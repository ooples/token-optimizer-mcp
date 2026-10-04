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
  // the currency was corrected. Its census needs the competitor's engine
  // present, so a run without hr-corpus and the clone will not reach every
  // payload; that is why the decomposition check fails loudly on the encoding
  // rather than trusting a partial census to have caught it.
  'bench/compression/head-to-head.mjs',
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
    const response = await fetch(ENDPOINT, {
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

function run(target, env) {
  return spawnSync(process.execPath, [target], {
    cwd: REPO,
    env: { ...process.env, ...env },
    stdio: 'ignore',
  }).status;
}

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
  for (const target of TARGETS)
    run(target, { TOKEN_OPTIMIZER_BENCH_CENSUS: censusPath });

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
    `strict ${target}: ${status === 0 ? 'pass' : `FAIL (exit ${status})`}`
  );
  if (status !== 0) bad += 1;
}
process.exitCode = bad === 0 ? 0 : 1;
