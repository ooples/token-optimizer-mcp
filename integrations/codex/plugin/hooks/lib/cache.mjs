// GENERATED FILE -- do not edit.
// Source of truth: hooks-core/cache.mjs. Regenerate with `npm run sync:hooks`.
/**
 * Prompt-cache economics.
 *
 * Cache economics is real money in a way most compression is not: a cache read
 * costs a tenth of a fresh token and a cache WRITE costs a quarter more than
 * one, so a prefix that keeps invalidating can cost more than every saving this
 * product makes elsewhere. It is also the one area where we do not have to
 * model anything -- the client's own transcript records cache_read_input_tokens
 * and cache_creation_input_tokens per turn, which is ground truth.
 *
 * MEASUREMENT ALONE IS NOT ACTIONABLE. A hit rate tells you the cache missed;
 * it cannot tell you why, and an unactionable number is the same dead thing as
 * a context-quality letter. So the prefix is also modelled as ORDERED SEGMENTS
 * with a volatility each, which turns every invalidation into a named cause
 * with a price attached:
 *
 *   not  "78% cache hit rate"
 *   but  "CLAUDE.md line 12 embeds a timestamp; it sits ahead of 47,000 tokens,
 *         so every session re-writes them -- about 58,750 tokens at write price"
 *
 * Measured effect, attributed cause. The measurement proves the loss is real;
 * the attribution says which line to change.
 *
 * AND OUR OWN OUTPUT IS PART OF THE PREFIX. Every competing tool observes the
 * cache from outside. We inject briefings, findings and previews INTO it, so a
 * careless optimizer can cost more cache than it saves tokens. Everything we
 * emit at session start goes through `stableText` first, which is the
 * cache-safety-by-construction half of this file.
 */

import { readFileSync, readdirSync, statSync, existsSync, openSync, readSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

/** Anthropic prompt-cache pricing multipliers, relative to a plain input token. */
export const WRITE_MULTIPLIER = 1.25;
export const READ_MULTIPLIER = 0.1;

/**
 * The client's own placeholder for a row it wrote itself -- an interrupt, an
 * auth error, "No response requested." at the end of a session. It carries a
 * full all-zero `usage` object, so it survives every filter below, but it is
 * not a model and no prefix was ever written under it.
 *
 * Measured across the four real transcripts on one machine: all four contain
 * these rows, and three used exactly one real model yet would report two --
 * a false "2 models used in this session" costing an invented ~767,000 tokens.
 */
const SYNTHETIC_MODEL = '<synthetic>';

/** True for a turn naming a model an inference actually ran under. */
const realModel = (turn) => Boolean(turn.model) && turn.model !== SYNTHETIC_MODEL;

/* -------------------------------------------------------------- MEASUREMENT */

/**
 * Where this client keeps its transcripts.
 *
 * Claude Code slugs the project directory into a folder name; the newest
 * .jsonl in it is the session in progress. Returns null rather than guessing
 * when nothing is found -- an invented transcript path would produce invented
 * economics.
 */
export function transcriptFor(cwd = process.cwd()) {
  const override = process.env.TOKEN_OPTIMIZER_TRANSCRIPT;
  if (override) return existsSync(override) ? override : null;

  const slug = String(cwd).replace(/[^a-zA-Z0-9]/g, '-');
  const dir = join(homedir(), '.claude', 'projects', slug);
  try {
    const files = readdirSync(dir)
      .filter((name) => name.endsWith('.jsonl'))
      .map((name) => ({ path: join(dir, name), at: statSync(join(dir, name)).mtimeMs }))
      .sort((a, b) => b.at - a.at);
    return files.length ? files[0].path : null;
  } catch {
    return null;
  }
}

/**
 * Per-turn cache usage, read from the client's own record.
 *
 * Bounded to the tail: a long session's transcript is tens of megabytes, and
 * this runs on a hook path. Recent turns are also the right statistics -- cache
 * behaviour from three days ago says nothing about the prefix as it stands.
 */
export function readCacheUsage(path, { maxBytes = 4_000_000 } = {}) {
  if (!path) return [];
  let text;
  try {
    const size = statSync(path).size;
    if (size <= maxBytes) {
      text = readFileSync(path, 'utf8');
    } else {
      // Read the tail OFF DISK. readFileSync loaded the whole file first, which
      // on a real 147 MB transcript measured 361 ms and 334 MB of RSS to keep
      // 4 MB, and throws ERR_STRING_TOO_LONG past ~512 MB -- which the catch
      // below silently turns into "no cache measurements available" for a
      // perfectly readable file. It also sliced a BYTE offset out of a UTF-16
      // string: on that same file bytes-minus-chars was 140,264, so 3.5% of the
      // requested window was quietly discarded.
      const handle = openSync(path, 'r');
      try {
        const buffer = Buffer.allocUnsafe(maxBytes);
        const got = readSync(handle, buffer, 0, maxBytes, size - maxBytes);
        // A partial UTF-8 sequence at the cut is discarded by the startsWith('{')
        // and JSON.parse guards below, exactly as the old first-line slice was.
        text = buffer.toString('utf8', 0, got);
      } finally {
        closeSync(handle);
      }
    }
  } catch {
    return [];
  }

  const turns = [];
  for (const line of text.split('\n')) {
    if (!line.startsWith('{')) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue; // a truncated first line from the tail slice
    }
    const usage = row?.message?.usage;
    if (!usage) continue;
    turns.push({
      at: Date.parse(row.timestamp) || null,
      model: row?.message?.model || null,
      read: usage.cache_read_input_tokens || 0,
      written: usage.cache_creation_input_tokens || 0,
      input: usage.input_tokens || 0,
    });
  }
  return turns;
}

/**
 * What the cache is actually doing.
 *
 * `prefixTokens` is the size of the cached prefix at the most recent turn --
 * the number every attribution below is a fraction of, and the one that makes
 * an invalidation expressible in tokens rather than in adjectives.
 */
export function cacheHealth(turns) {
  if (!turns.length) return null;

  let read = 0;
  let written = 0;
  const models = new Map();

  for (const turn of turns) {
    read += turn.read;
    written += turn.written;
    if (!realModel(turn)) continue;
    if (!models.has(turn.model)) models.set(turn.model, { read: 0, written: 0, turns: 0 });
    const entry = models.get(turn.model);
    entry.read += turn.read;
    entry.written += turn.written;
    entry.turns += 1;
  }

  // The last turn that actually CARRIED a prefix. A session routinely ends on a
  // zero-usage row -- the client's '<synthetic>' placeholders, an interrupted
  // turn -- and reading turns[length - 1] literally reported a 0-token prefix
  // for a session whose prefix was 600,000 tokens. That zeroed every
  // attribution price, made keepWarm answer "unknown", and returned null from
  // modelSwitchCost under a guard its caller does not share, which crashed
  // cache_audit outright with "Cannot read properties of null".
  const last = turns.reduce((best, turn) => (turn.read + turn.written > 0 ? turn : best), turns[turns.length - 1]);
  const total = read + written;

  return {
    turns: turns.length,
    read,
    written,
    hitRate: total ? read / total : null,
    prefixTokens: last.read + last.written,
    // Priced in plain-token equivalents, which is what makes it comparable with
    // every other saving this product reports.
    writeCost: Math.round(written * WRITE_MULTIPLIER),
    readCost: Math.round(read * READ_MULTIPLIER),
    savedVersusNoCache: Math.round(read * (1 - READ_MULTIPLIER)),
    models: Object.fromEntries(models),
  };
}

/**
 * What a mid-session model switch would cost, before it is paid.
 *
 * Detection after the fact tells you about money already spent. The whole
 * prefix is re-written under the new model, so the price is knowable in advance
 * and is worth one sentence at the moment it matters.
 */
export function modelSwitchCost(turns) {
  const health = cacheHealth(turns);
  if (!health?.prefixTokens) return null;

  const switched = new Set(turns.filter(realModel).map((t) => t.model)).size > 1;
  return {
    prefixTokens: health.prefixTokens,
    rewriteCost: Math.round(health.prefixTokens * WRITE_MULTIPLIER),
    alreadySwitched: switched,
    text: `Switching model now discards a ${health.prefixTokens.toLocaleString()}-token warm prefix; ` +
      `re-writing it costs about ${Math.round(health.prefixTokens * WRITE_MULTIPLIER).toLocaleString()} tokens.`,
  };
}

/* -------------------------------------------------------------- ATTRIBUTION */

/**
 * Constructs that change between sessions, and therefore invalidate everything
 * after them.
 *
 * Each is something whose VALUE differs run to run while its purpose does not:
 * the file looks stable to a human and is a fresh prefix to the cache every
 * time. That is why this class of bug survives -- nothing about it looks wrong.
 */
const VOLATILE = [
  { id: 'timestamp', re: /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/, why: 'an embedded timestamp' },
  { id: 'date', re: /\b(?:today|current date)\b[^\n]{0,40}\d{4}-\d{2}-\d{2}/i, why: 'an embedded current date' },
  // A bare date is a SUSPICION, not a measurement: "- 2025-10-31: reworked the
  // loader" is byte-identical every session. Kept, because stableText fails
  // closed over our own output and dropping a line there costs little -- but
  // NOT priced, because in the blame report a false positive invents a
  // per-session cost and tells the user to delete their changelog.
  { id: 'iso-date', re: /\b\d{4}-\d{2}-\d{2}\b/, why: 'an embedded date', priced: false },
  { id: 'session-id', re: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i, why: 'a session id' },
  { id: 'git-sha', re: /\b[0-9a-f]{40}\b/, why: 'a git sha' },
  { id: 'counter', re: /\b(?:run|build|attempt|iteration)\s*#?\d+\b/i, why: 'a run counter' },
  { id: 'epoch', re: /\b1[6-9]\d{11}\b/, why: 'an epoch timestamp' },
];

/** Every volatile construct in a text, with the line it is on. */
export function volatileLines(text) {
  const out = [];
  const lines = String(text || '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    for (const rule of VOLATILE) {
      if (!rule.re.test(lines[i])) continue;
      out.push({ line: i + 1, id: rule.id, why: rule.why, priced: rule.priced !== false, text: lines[i].trim().slice(0, 120) });
      break; // one cause per line is enough to act on
    }
  }
  return out;
}

const estimate = (text) => Math.ceil(String(text || '').length / 4);

/**
 * Attributes cache invalidation to the files that cause it.
 *
 * The price of a volatile construct is everything positioned AFTER it, because
 * a prefix cache is invalidated from the first difference onwards. So the same
 * timestamp is nearly free at the end of the prefix and ruinous near the front
 * -- which is why a flat list of "cache-breaking constructs" is not enough, and
 * position has to be part of the finding.
 *
 * `prefixTokens` comes from the measurement. Without it the downstream size is
 * unknown, and this reports the construct WITHOUT a price rather than inventing
 * one.
 */
export function attributeInvalidation(cwd, prefixTokens = null, { files = null } = {}) {
  // Ordered as the client assembles them: the client preamble and tool
  // definitions come first, then project instructions, then the conversation.
  const candidates = files || ['CLAUDE.md', 'AGENTS.md', '.claude/CLAUDE.md'];
  const out = [];
  let offset = 0;

  for (const relative of candidates) {
    const path = join(cwd, relative);
    let text;
    try {
      text = readFileSync(path, 'utf8');
    } catch {
      continue;
    }

    const size = estimate(text);
    const lines = text.split('\n');
    const found = volatileLines(text);
    for (const [index, hit] of found.entries()) {
      // Everything after THIS LINE is re-written -- not everything after the
      // file, which priced every hit in a file identically and, because each is
      // emitted as its own record and audit.mjs sums them, billed the same
      // tokens once per line. Measured before this fix: a three-line changelog
      // in CLAUDE.md priced at 2,301,093 tokens/session against a 613,625-token
      // prefix -- 3.75x the entire prefix. Conservative still: the preamble
      // ahead of the file is not counted, so this remains a floor.
      const ahead = offset + estimate(lines.slice(0, hit.line - 1).join('\n'));
      const downstream = prefixTokens != null ? Math.max(0, prefixTokens - ahead) : null;
      // A prefix cache invalidates ONCE, at the earliest difference. A later
      // volatile line in the same file costs nothing extra until the first one
      // is fixed, so it is reported for context but not billed again.
      //
      // Subsumption is measured against the earliest PRICED hit, not simply the
      // first hit. An unpriced bare date at index 0 does not invalidate anything
      // we are willing to bill for, so treating it as the subsumer zeroed the
      // price of a genuine timestamp below it -- turning a real, fixable cost
      // into a reported zero.
      const firstPriced = found.find((h) => h.priced);
      const subsumedBy =
        hit.priced && firstPriced && firstPriced !== hit ? `${relative}:${firstPriced.line}` : null;
      out.push({
        file: relative,
        line: hit.line,
        why: hit.why,
        excerpt: hit.text,
        downstreamTokens: downstream,
        subsumedBy,
        // null means NOT MEASURABLE -- no prefix measurement, or a construct we
        // decline to price. 0 means measured and genuinely free, which is what a
        // subsumed hit is: real, but already billed by the earlier line. Folding
        // those two into one value is the same mistake this file warns about.
        costPerSession: downstream == null || !hit.priced
          ? null
          : (subsumedBy ? 0 : Math.round(downstream * WRITE_MULTIPLIER)),
        remedy: {
          kind: 'yours',
          type: 'edit',
          file: relative,
          why: `${hit.why} on line ${hit.line} changes every session, re-writing everything after it`,
          diff: `${relative}:${hit.line}\n- ${hit.text}\n+ (remove the changing value, or move this section to the end of the file)`,
        },
      });
    }
    offset += size;
  }

  return out.sort((a, b) => (b.costPerSession ?? 0) - (a.costPerSession ?? 0));
}

/* ------------------------------------------------ CACHE-SAFE BY CONSTRUCTION */

/**
 * Our own contribution to the prefix, made stable.
 *
 * THE HALF NOBODY ELSE HAS TO THINK ABOUT. Every competing tool observes the
 * cache from outside; we write into it. Anything we emit at session start sits
 * near the front of the prefix, so a single varying character in it invalidates
 * everything after -- and an optimizer that costs more cache than it saves
 * tokens is worse than no optimizer.
 *
 * So our own text goes through the same detector we point at the user's files,
 * and a line that would differ between sessions is DROPPED rather than emitted.
 * Failing closed is right here: a missing line of guidance costs a little, and
 * a volatile one costs the whole prefix.
 */
export function stableText(text) {
  const lines = String(text || '').split('\n');
  const volatiles = new Set(volatileLines(text).map((v) => v.line));
  if (!volatiles.size) return { text: String(text || ''), dropped: 0 };

  const kept = lines.filter((_, i) => !volatiles.has(i + 1));
  return { text: kept.join('\n'), dropped: volatiles.size };
}

/**
 * Assembles our injections in cache order: stable first, volatile last.
 *
 * Within one block the order still matters, because a later session re-emitting
 * the same block with one changed line invalidates from that line onward. Put
 * the parts that rarely change at the top and the freshest at the bottom and
 * the invalidation is confined to the tail.
 */
export function cacheOrdered(items) {
  return [...items].sort((a, b) => {
    const stability = (item) => (item.volatility ?? (item.fresh ? 1 : 0));
    return stability(a) - stability(b);
  });
}
