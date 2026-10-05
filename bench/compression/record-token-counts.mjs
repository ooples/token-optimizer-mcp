/**
 * Record the authoritative token counts this harness is denominated in.
 *
 * Needs a credential and the network; nothing else here does. CI never runs
 * this -- it reads the fixture this writes, which is why the fixture is
 * committed. The credential comes from the same place the subscription meter
 * takes it, and neither it nor any part of it is written to the fixture, a log
 * or the console.
 *
 * WHAT IT WRITES: content digests and integer counts, and nothing else. The
 * text a count was measured on is never stored -- the same rule the base
 * context record follows. A digest is enough, because the only question ever
 * asked of this fixture is "what did THIS string cost", and the asker is
 * holding the string.
 *
 * HOW IT TERMINATES: recording is a fixed point. A census pass runs the
 * harness with provisional counts and writes down every string it was asked
 * about; those are counted and merged; the harness is run again. A pass that
 * discovers nothing new is the fixed point, and the run ends with a STRICT
 * pass -- no census, no provisional answers -- which is the only thing that
 * proves the fixture is complete.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readOAuthToken } from '../subscription/meter.mjs';
import { FIXTURE, MODEL, digest } from './currency.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');

/** Everything that asks this harness for a token count. */
const TARGETS = [
  'bench/compression/proof.mjs',
  'bench/compression/proof-metrics.check.mjs',
  // The tools bench prices every reply against reading the file it answers
  // about, and it counted with tiktoken until it was moved onto this currency.
  // Its payloads are byte-stable across runs (verified) and carry no
  // machine-specific string (scanned, 0 of 37), which is what makes a
  // content-digest-keyed fixture possible for them at all.
  'bench/tools/reduction.mjs',
  'bench/tools/reduction.check.mjs',
  // THE COMPETITIVE COMPARATOR, which counted with tiktoken cl100k_base until
  // the currency was corrected.
  //
  // ITS CENSUS DOES NOT CONVERGE YET, and the cause is known. Rounds 4 and 5
  // each found exactly 72 new strings and two independent census passes gave
  // `run1 234 run2 234 only1 72 only2 72`: 72 of its 234 payloads have
  // different bytes on every run, so their digests never repeat and no fixture
  // can be complete. Those are the payloads carrying marker stamps. A stamp is
  // an HMAC keyed by `SECRET = randomBytes(32)` at annotate.ts:114, minted once
  // per process and never emitted, so every run stamps differently.
  //
  // FIXED by seeding the stamp secret for every target below, which took three
  // attempts to get right: `options.stamp` at the comparator's compressBlock
  // sites took it from 72 to 29, wiring the two sites written on one line took
  // it to 13, and the last 13 were `compressBody`, which takes positional
  // arguments through four levels and has nowhere to receive a stamp. Seeding
  // the secret covers every path at once, including the ones that were never
  // found. Two census passes over one capture now agree exactly: 0 of 234.
  //
  // IT TAKES THE COMPETITOR'S CAPTURE DIRECTORY AS AN ARGUMENT, so registering
  // it bare recorded nothing: a run with no argument prints its usage line and
  // exits, which the census read as a target that reached zero strings rather
  // than as a target that never ran. The capture the recorded result was taken
  // over is `hr30/merged/warm`, and the census is only as complete as whatever
  // capture is on disk -- which is why the decomposition check fails loudly on
  // the encoding instead of trusting a census to have caught it.
  ['bench/compression/head-to-head.mjs', 'hr30/merged/warm'],
  // THE REPLICATE'S CAPTURE, which is a different sweep and therefore different
  // payloads. A speed verdict needs two independent recordings that agree, and
  // the replicate could not be re-taken at all until its strings were counted:
  // the currency refuses a digest it has never seen rather than estimating, so
  // a capture absent from the fixture is a capture the comparator cannot price.
  // hr31/warm WAS THE OBVIOUS CHOICE AND IT IS NOT USABLE. Its capture reports
  // their engine running with a capability missing -- Kompress gave up with its
  // time budget exhausted and kept the remainder verbatim, four times -- so
  // their column there is a floor on their engine rather than a measurement of
  // it, and the comparator refuses to let any row from it be quoted as a win.
  // That is a property of the capture, taken on a machine that was not quiet,
  // not of the currency work.
  ['bench/compression/head-to-head.mjs', 'hr30/warm'],
  // The prefix-survival measurement, which counts the shared run between turns
  // as text rather than scaling a character share.
  'bench/compression/prefix-survival.mjs',
  // The turn-by-turn replay, which prices each turn against the prefix the one
  // before it left cached. Its payloads are whole requests rather than single
  // replies, so it contributes the largest strings in the fixture.
  'bench/compression/replay.mjs',
  // The eviction arms, which replay each conversation twice and so contribute
  // both the baseline bodies and the stubbed ones.
  'bench/compression/evict.mjs',
];

const ENDPOINT = 'https://api.anthropic.com/v1/messages/count_tokens';
const { token } = readOAuthToken();
if (!token)
  throw new Error(
    'no Claude credential found. Set CLAUDE_CODE_OAUTH_TOKEN or sign in with Claude Code.'
  );

let calls = 0;

async function countRequest(text) {
  for (let attempt = 0; ; attempt += 1) {
    calls += 1;
    // A TRANSPORT FAILURE IS RETRYABLE TOO, and it used to escape this loop.
    // The retry below covers HTTP statuses only, so a connection aborted mid
    // write -- ECONNABORTED, which the comparator's six-figure payloads provoke
    // -- threw straight out of the recorder and ended the run with a stack
    // trace, after it had already spent every call before it. The payload size
    // is not the problem: the largest fixture counts fine on its own.
    let response;
    try {
      response = await fetch(ENDPOINT, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'anthropic-version': '2023-06-01',
          'anthropic-beta': 'oauth-2025-04-20',
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          model: MODEL,
          messages: [{ role: 'user', content: [{ type: 'text', text }] }],
        }),
      });
    } catch (error) {
      if (attempt >= 5)
        throw new Error(
          `count_tokens transport failure after ${attempt + 1} attempts on a ${text.length}-character payload: ${error.message}`
        );
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
      continue;
    }
    if (response.ok) return (await response.json()).input_tokens;
    const body = (await response.text()).slice(0, 200);
    const retryable = response.status === 429 || response.status >= 500;
    if (!retryable || attempt >= 5)
      throw new Error(`count_tokens ${response.status}: ${body}`);
    await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
  }
}

/**
 * The envelope, derived rather than assumed.
 *
 * `count_tokens` prices a request, so a per-string count has to have the
 * request's own fixed cost taken off it. Repeating one single-token word n
 * times gives `count = envelope + slope * n`, and two points solve it -- but
 * only if the relation really is linear, so every rung is checked against the
 * fit and a fixture is not written if any disagrees. (Measured 2026-10-03:
 * 8, 9, 10, 11, 15, 23, 39, 71 -- slope 1, envelope 7.)
 */
const LADDER = [1, 2, 3, 4, 8, 16, 32, 64];
const WORD = ' hello';

async function measureEnvelope() {
  const rungs = [];
  for (const n of LADDER) rungs.push([n, await countRequest(WORD.repeat(n))]);
  const [first, last] = [rungs[0], rungs[rungs.length - 1]];
  const slope = (last[1] - first[1]) / (last[0] - first[0]);
  const envelope = first[1] - slope * first[0];
  const off = rungs.filter(([n, c]) => c !== envelope + slope * n);
  if (!Number.isInteger(slope) || !Number.isInteger(envelope) || off.length)
    throw new Error(
      `the envelope ladder is not linear, so a per-string count cannot be derived from it: ${JSON.stringify(rungs)}`
    );
  return { envelope, slope, ladder: rungs };
}

/** Whitespace-only text is priced at the margin, since the API refuses it bare. */
let dot = 0;

async function countString(text, envelope) {
  if (/\S/.test(text)) return (await countRequest(text)) - envelope;
  if (!dot) dot = await countRequest('.');
  return (await countRequest(`.${text}`)) - dot;
}

/** Three at a time: polite to the endpoint, and fast enough for a few hundred. */
async function countAll(texts, envelope, onProgress) {
  const out = new Map();
  const queue = [...texts];
  const worker = async () => {
    for (;;) {
      const text = queue.pop();
      if (text === undefined) return;
      out.set(digest(text), await countString(text, envelope));
      onProgress(out.size);
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  return out;
}

function save(record) {
  // DIGESTS AND COUNTS ONLY. Asserted on the way out rather than trusted,
  // because this is the one file in the harness a mistake here would turn into
  // a committed copy of the corpus.
  for (const [key, value] of Object.entries(record.counts)) {
    if (!/^[0-9a-f]{64}$/.test(key))
      throw new Error(`refusing to write a fixture key that is not a digest`);
    if (!Number.isInteger(value) || value < 0)
      throw new Error(`refusing to write a non-count for ${key}`);
  }
  const counts = {};
  for (const key of Object.keys(record.counts).sort())
    counts[key] = record.counts[key];
  writeFileSync(FIXTURE, `${JSON.stringify({ ...record, counts }, null, 2)}\n`);
}

/**
 * A target is a path, or a path plus the arguments it needs to do anything.
 *
 * REGISTERING ONE BARE THAT NEEDS AN ARGUMENT RECORDS NOTHING, and looks like
 * success. head-to-head.mjs takes the competitor's capture directory; with no
 * argument it printed its usage line and exited, and the census read that as a
 * target which had reached zero new strings rather than as one which had never
 * run. The strict pass afterwards was the only thing that noticed.
 */
function run(target, env) {
  const [file, ...args] = Array.isArray(target) ? target : [target];
  return spawnSync(process.execPath, [file, ...args], {
    cwd: REPO,
    env: {
      ...process.env,
      // EVERY TARGET STAMPS THE SAME WAY, OR NO FIXTURE CAN BE COMPLETE. A
      // marker stamp is an HMAC keyed by a per-process random secret, so a
      // payload carrying one has different bytes every run and its digest never
      // repeats. Measured on the comparator: 72 of 234 payloads varied, and with
      // this set, 0. The seed is read only by annotate.ts and only when present,
      // so nothing in production is affected; see the note there for the trade.
      TOKEN_OPTIMIZER_BENCH_STAMP_SEED: 'token-counts',
      ...env,
    },
    stdio: 'ignore',
  }).status;
}

/** For a message: the path, with its arguments if it has any. */
const label = (target) =>
  Array.isArray(target) ? target.join(' ') : String(target);

const scratch = mkdtempSync(join(tmpdir(), 'token-counts-'));
const censusPath = join(scratch, 'census.jsonl');

const measured = await measureEnvelope();
console.log(
  `envelope ${measured.envelope} (slope ${measured.slope}, ladder checked)`
);

const record = existsSync(FIXTURE)
  ? JSON.parse(readFileSync(FIXTURE, 'utf8'))
  : { model: MODEL, envelope: measured.envelope, recordedAt: '', counts: {} };
// A COUNT IS ONLY A COUNT FOR THE ENVELOPE IT WAS TAKEN WITH. If the measured
// envelope has moved, every stored count was derived by subtracting a
// different number and none of them is salvageable.
if (record.envelope !== measured.envelope) record.counts = {};
record.model = MODEL;
record.envelope = measured.envelope;
record.ladder = measured.ladder;
save(record);

/**
 * Every digest the last census pass asked for, hit or miss.
 *
 * WHAT THE FIXTURE IS PRUNED TO. A count the harness no longer looks up is not
 * harmless: it is indistinguishable from a live one, so a reader auditing the
 * fixture cannot tell which strings this harness actually prices. Changing the
 * marker stamp's encoding left 190 of them behind in a single commit.
 *
 * SAFE BY CONSTRUCTION, AND LOUD IF IT IS NOT. The census pass and the strict
 * pass at the end of this file run the same targets over the same inputs, so
 * they reach the same strings; if a prune ever does drop something still
 * needed, the strict pass that follows refuses by name in the same run.
 */
let reached = new Set();

for (let round = 1; round <= 5; round += 1) {
  rmSync(censusPath, { force: true });
  for (const target of TARGETS) {
    const status = run(target, { TOKEN_OPTIMIZER_BENCH_CENSUS: censusPath });
    // A TARGET THAT DID NOT RUN IS NOT A TARGET THAT FOUND NOTHING. Census mode
    // answers a miss provisionally so a target is expected to SUCCEED here; a
    // non-zero exit means it never reached its payloads, and carrying on would
    // record a fixture that silently omits every string it would have counted.
    if (status !== 0) {
      // A KILL IS NOT A FAILURE, and saying so matters: the comparator takes
      // longer than any wrapper's patience, and under `timeout` it comes back
      // 143 having counted thousands of payloads perfectly well. Reporting that
      // as "reached none of its payloads" sent me looking for a defect in the
      // target instead of for the stopwatch around it.
      const killed = status === 143 || status === 137 || status === null;
      throw new Error(
        killed
          ? `census target ${label(target)} was killed (status ${status}) before it finished, so the fixture would be incomplete for whatever it had not yet reached. It needs to run to completion -- do not wrap it in a timeout.`
          : `census target ${label(target)} exited ${status}, so it reached none of its payloads; the counts it would have contributed cannot be recorded and the fixture would be silently incomplete`
      );
    }
  }

  const fresh = new Map();
  reached = new Set();
  if (existsSync(censusPath))
    for (const line of readFileSync(censusPath, 'utf8').split('\n')) {
      if (!line) continue;
      const { d, t } = JSON.parse(line);
      reached.add(d);
      // A hit carries no text, so only a miss is something to go and count.
      if (t !== undefined && !(d in record.counts)) fresh.set(d, t);
    }

  console.log(`round ${round}: ${fresh.size} string(s) to count`);
  if (fresh.size === 0) break;

  const counted = await countAll(
    [...fresh.values()],
    measured.envelope,
    (n) => {
      if (n % 25 === 0) process.stdout.write(`  counted ${n}/${fresh.size}\n`);
    }
  );
  for (const [key, value] of counted) record.counts[key] = value;
  record.recordedAt = new Date().toISOString();
  save(record);
}

const dead = Object.keys(record.counts).filter((d) => !reached.has(d));
if (dead.length > 0) {
  for (const d of dead) delete record.counts[d];
  record.recordedAt = new Date().toISOString();
  save(record);
}

rmSync(scratch, { recursive: true, force: true });
console.log(
  `${Object.keys(record.counts).length} counts recorded, ` +
    `${dead.length} pruned, ${calls} API calls`
);

// THE ONLY PROOF THE FIXTURE IS COMPLETE: a pass with no census and no
// provisional answers, where a single missing string is a hard refusal.
let bad = 0;
for (const target of TARGETS) {
  const status = run(target, { TOKEN_OPTIMIZER_BENCH_CENSUS: '' });
  console.log(
    `strict ${label(target)}: ${status === 0 ? 'pass' : `FAIL (exit ${status})`}`
  );
  if (status !== 0) bad += 1;
}
process.exitCode = bad === 0 ? 0 : 1;
