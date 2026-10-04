/**
 * THE HIGH-RESOLUTION INSTRUMENT: WHAT WAS ACTUALLY BILLED, FROM DISK.
 *
 * `meter.mjs` reads the quantity that matters -- subscription utilisation --
 * but at 1% granularity, which is far too coarse to attribute to a workload.
 * This file reads the other half: Claude Code writes every assistant message
 * to `~/.claude/projects/<slug>/<session>.jsonl`, and each one carries the
 * `usage` block the API returned for that request. Exact token counts, split by
 * the four kinds that are billed at four different rates, already on disk, for
 * every request this machine has ever made. Reading them costs nothing.
 *
 * Together the two give what neither gives alone: exact tokens (here) against
 * real metered movement (there), which is what `calibrate.mjs` fits. That is
 * the whole point -- it replaces the three constants in
 * `bench/compression/cost-model.mjs` that were copied off a price list and
 * never once checked against the meter they claim to predict.
 *
 * THREE DEFECTS IN THE RAW DATA, EACH OF WHICH WOULD SILENTLY FALSIFY A SUM.
 * These are measured, not assumed; running this file reprints the counts.
 *
 *  1. THE FILES REPEAT THEMSELVES, ROUGHLY 2.2x. There are ~80,700 rows with a
 *     usage block but only ~35,900 distinct `requestId`s: a resumed or forked
 *     session rewrites the history it inherited into its own transcript, so the
 *     same billed request appears in several files. Summing rows rather than
 *     requests over-counts by more than double -- and the error is not a
 *     constant factor, because how often a session was resumed varies by day.
 *     A `requestId` is one upstream request and is therefore billed once, so
 *     this deduplicates on it.
 *
 *  2. DUPLICATES DISAGREE ~132 TIMES, IN TWO SHAPES, BOTH PARTIAL WRITES. Some
 *     copies read `0,0,0,0` (the row was persisted before the usage arrived);
 *     others carry a truncated `output_tokens` against otherwise identical
 *     input counts -- e.g. `32,12566,144182,5` beside `32,12566,144182,2621`,
 *     a stream snapshotted five tokens in. In both shapes one copy is a prefix
 *     of the finished request, so the resolution is to keep the LARGEST, per
 *     field: a partial can never exceed the complete record it is a prefix of.
 *
 *  3. `<synthetic>` ROWS ARE NOT REQUESTS. Claude Code writes local-only
 *     messages (interrupts, hook notices) with `model: "<synthetic>"` and a
 *     zeroed or absent usage block. They were never sent upstream and are
 *     excluded by model, not by their zeros, so a genuine zero-cost request
 *     would still be counted.
 *
 * WHAT IS KEPT, AND WHY EACH FIELD EARNS ITS PLACE. The bill is not one number
 * per request and a calibration that collapsed it would be fitting a constant
 * to a mixture:
 *   - `input` / `cacheWrite5m` / `cacheWrite1h` / `cacheRead` / `output` --
 *     five separately-priced quantities. The 1h and 5m cache writes are a
 *     distinct rate from each other, which `cost-model.mjs` collapses into one
 *     `cacheWrite: 1.25`; they arrive here already separated in
 *     `usage.cache_creation`.
 *   - `model` -> `family` -- the meter weights families differently, so every
 *     weight is per (family x kind), never global.
 *   - `thinking` -- billed as output, kept separately because a verbosity or
 *     effort lever moves it independently of visible output.
 *   - `at`, `isSidechain`, `sessionId`, `file` -- a window filter needs the
 *     timestamp; the others make an anomalous observation traceable to the
 *     session that produced it.
 */

import { createReadStream } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

export function projectsRoot() {
  const dir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
  return join(dir, 'projects');
}

/** Family names must match the keys `calibrate.mjs` solves weights for. */
export function familyOf(model) {
  if (typeof model !== 'string') return 'unknown';
  const m = model.toLowerCase();
  if (m.includes('opus')) return 'opus';
  if (m.includes('sonnet')) return 'sonnet';
  if (m.includes('haiku')) return 'haiku';
  if (m.includes('fable')) return 'fable';
  return 'unknown';
}

async function* jsonlFiles(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* jsonlFiles(path);
    else if (entry.name.endsWith('.jsonl')) yield path;
  }
}

function usageOf(row) {
  const u = row?.message?.usage;
  if (!u || typeof u !== 'object') return null;
  const creation = u.cache_creation ?? {};
  return {
    input: Number(u.input_tokens ?? 0) || 0,
    cacheRead: Number(u.cache_read_input_tokens ?? 0) || 0,
    // `cache_creation_input_tokens` is the TOTAL of the two TTLs. It is kept as
    // the fallback for rows written before `cache_creation` existed, where the
    // split is unknowable; those land wholly in 5m, which is flagged below so a
    // calibration can exclude them rather than silently fit a wrong rate.
    cacheWrite5m:
      Number(creation.ephemeral_5m_input_tokens ?? u.cache_creation_input_tokens ?? 0) || 0,
    cacheWrite1h: Number(creation.ephemeral_1h_input_tokens ?? 0) || 0,
    cacheWriteSplitKnown: creation.ephemeral_5m_input_tokens !== undefined,
    output: Number(u.output_tokens ?? 0) || 0,
    thinking: Number(u.output_tokens_details?.thinking_tokens ?? 0) || 0,
  };
}

/**
 * Every distinct billed request on this machine, deduplicated and repaired.
 *
 * Returns `{ requests, census }`. `requests` is a Map keyed by `requestId`;
 * `census` carries the counts behind the three defects above so a caller can
 * print them instead of taking this file's word for it.
 */
export async function loadRequests({ root = projectsRoot(), since = null } = {}) {
  const sinceMs = since ? new Date(since).getTime() : null;
  const requests = new Map();
  const census = {
    files: 0,
    rowsWithUsage: 0,
    rowsSynthetic: 0,
    rowsNoRequestId: 0,
    rowsBeforeSince: 0,
    rowsUnparsable: 0,
    distinctRequests: 0,
    duplicateRows: 0,
    conflictingRequests: 0,
    conflictsAllZero: 0,
    conflictsPartialOutput: 0,
    conflictsOtherShape: 0,
    splitUnknownRequests: 0,
  };

  for await (const file of jsonlFiles(root)) {
    census.files++;
    const stream = createReadStream(file, 'utf8');
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line || line.charCodeAt(0) !== 123 /* { */) continue;
      let row;
      try {
        row = JSON.parse(line);
      } catch {
        census.rowsUnparsable++;
        continue;
      }
      const usage = usageOf(row);
      if (!usage) continue;
      census.rowsWithUsage++;

      const model = row?.message?.model ?? null;
      if (model === '<synthetic>') {
        census.rowsSynthetic++;
        continue;
      }
      const id = row.requestId;
      if (!id) {
        census.rowsNoRequestId++;
        continue;
      }
      const at = row.timestamp ? Date.parse(row.timestamp) : NaN;
      if (sinceMs !== null && Number.isFinite(at) && at < sinceMs) {
        census.rowsBeforeSince++;
        continue;
      }

      const existing = requests.get(id);
      if (!existing) {
        requests.set(id, {
          id,
          at: Number.isFinite(at) ? at : null,
          model,
          family: familyOf(model),
          isSidechain: row.isSidechain === true,
          sessionId: row.sessionId ?? null,
          file,
          ...usage,
        });
        continue;
      }

      census.duplicateRows++;

      // FIELDWISE MAX, because every disagreement observed is a partial write
      // (see defect 2). Classifying each conflict keeps the assumption
      // falsifiable rather than merely stated: a conflict of a THIRD shape
      // lands in `conflictsOtherShape`, and a non-zero count there means this
      // rule no longer covers the data and has to be revisited.
      const differs =
        existing.input !== usage.input ||
        existing.cacheRead !== usage.cacheRead ||
        existing.cacheWrite5m !== usage.cacheWrite5m ||
        existing.cacheWrite1h !== usage.cacheWrite1h ||
        existing.output !== usage.output;
      if (differs) {
        census.conflictingRequests++;
        const zeroed =
          (usage.input === 0 && usage.cacheRead === 0 && usage.output === 0) ||
          (existing.input === 0 && existing.cacheRead === 0 && existing.output === 0);
        const sameInputs =
          existing.input === usage.input &&
          existing.cacheRead === usage.cacheRead &&
          existing.cacheWrite5m === usage.cacheWrite5m &&
          existing.cacheWrite1h === usage.cacheWrite1h;
        if (zeroed) census.conflictsAllZero++;
        else if (sameInputs) census.conflictsPartialOutput++;
        else census.conflictsOtherShape++;
      }
      for (const key of [
        'input',
        'cacheRead',
        'cacheWrite5m',
        'cacheWrite1h',
        'output',
        'thinking',
      ]) {
        if (usage[key] > existing[key]) existing[key] = usage[key];
      }
      existing.cacheWriteSplitKnown =
        existing.cacheWriteSplitKnown || usage.cacheWriteSplitKnown;
      // Keep the EARLIEST timestamp: a resumed transcript rewrites history with
      // the time it was replayed, and the window a request belongs to is the
      // one it was originally made in.
      if (Number.isFinite(at) && (existing.at === null || at < existing.at)) existing.at = at;
    }
  }

  census.distinctRequests = requests.size;
  for (const r of requests.values()) {
    if (!r.cacheWriteSplitKnown && r.cacheWrite5m > 0) census.splitUnknownRequests++;
  }
  return { requests, census };
}

/** Empty totals, so a window with no requests sums identically to one with. */
export function zeroTotals() {
  return {
    requests: 0,
    input: 0,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    cacheRead: 0,
    output: 0,
    thinking: 0,
  };
}

/** The five separately-priced quantities, in the order every report uses. */
export const KINDS = Object.freeze([
  'input',
  'cacheWrite5m',
  'cacheWrite1h',
  'cacheRead',
  'output',
]);

/**
 * Sum requests in `[fromMs, toMs)` into per-family totals.
 *
 * The half-open interval is deliberate: a rolling window ends AT `resets_at`,
 * and a request stamped exactly there belongs to the next one. Requests with no
 * usable timestamp are counted in `undated` and excluded from every window,
 * because guessing which window they fall in is exactly the kind of quiet
 * assumption this rig exists to remove.
 */
export function totalsInWindow(requests, fromMs, toMs) {
  const byFamily = {};
  const all = zeroTotals();
  let undated = 0;
  for (const r of requests.values()) {
    if (r.at === null) {
      undated++;
      continue;
    }
    if (r.at < fromMs || r.at >= toMs) continue;
    const bucket = (byFamily[r.family] ??= zeroTotals());
    for (const t of [bucket, all]) {
      t.requests++;
      t.input += r.input;
      t.cacheWrite5m += r.cacheWrite5m;
      t.cacheWrite1h += r.cacheWrite1h;
      t.cacheRead += r.cacheRead;
      t.output += r.output;
      t.thinking += r.thinking;
    }
  }
  return { all, byFamily, undated };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const { requests, census } = await loadRequests();
  console.log('census');
  for (const [k, v] of Object.entries(census)) {
    console.log(`  ${k.padEnd(22)} ${String(v).padStart(9)}`);
  }
  const now = Date.now();
  for (const [label, ms] of [
    ['last 5h', 5 * 3600e3],
    ['last 7d', 7 * 24 * 3600e3],
  ]) {
    const { all, byFamily } = totalsInWindow(requests, now - ms, now);
    console.log(
      `\n${label}: ${all.requests} requests  in ${all.input}  ` +
        `w5m ${all.cacheWrite5m}  w1h ${all.cacheWrite1h}  ` +
        `read ${all.cacheRead}  out ${all.output} (think ${all.thinking})`
    );
    for (const [family, t] of Object.entries(byFamily)) {
      console.log(
        `    ${family.padEnd(8)} ${String(t.requests).padStart(5)} req  ` +
          `in ${t.input}  w5m ${t.cacheWrite5m}  w1h ${t.cacheWrite1h}  ` +
          `read ${t.cacheRead}  out ${t.output}`
      );
    }
  }
}
