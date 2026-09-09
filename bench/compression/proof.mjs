/**
 * The proof gate.
 *
 * Runs every strategy over every workload fixture and reports three numbers,
 * because only the third can see the failure that matters:
 *
 *   gross      the content blocks, before vs after. Their methodology.
 *   net        the entire serialised request, including anything a strategy
 *              INJECTED to make its markers redeemable. HeadRoom appends a
 *              system message and a retrieval tool definition to every
 *              compressed request; a payload-only number does not charge for
 *              that, and the user is billed for it.
 *   effective  cache-weighted. A cached read bills at 0.10x and a write at
 *              1.25x, so rewriting a cached prefix can cut tokens while
 *              MULTIPLYING cost. Gross and net are both blind to that.
 *   touchable  reduction over only the content the strategy was ALLOWED to
 *              modify. v1 leaves the cached prefix alone by design, so its
 *              gross number is diluted by bytes it never had permission to
 *              touch -- comparing that against a cache-unaware competitor's
 *              figure understates it. This is the like-for-like column.
 *
 * THE GATE: v1-frontier must beat the ccr arm on effective tokens on every
 * workload. If it does not, the design is wrong, and the plan says to stop and
 * report rather than build the proxy anyway.
 *
 * Run: node bench/compression/proof.mjs
 */

import { fixtures } from './fixtures.mjs';
import { STRATEGIES } from '../../dist/compress/strategy.js';
import { lastCacheBreakpoint, isAfter } from '../../dist/compress/frontier.js';

const CACHE_READ = 0.1;
const CACHE_WRITE = 1.25;

/** Tokens, approximated consistently across arms so comparisons are fair. */
function tokens(text) {
  // A ratio, applied identically to every arm. The comparison is between arms
  // on the same content, so a shared approximation cancels; what would NOT
  // cancel is measuring one arm differently from another.
  return Math.ceil(text.length / 4);
}

/** Every text block in a request, with its position. */
function blocks(request) {
  const out = [];
  (request.messages ?? []).forEach((message, mi) => {
    const content = message?.content;
    if (!Array.isArray(content)) return;
    content.forEach((block, bi) => {
      if (typeof block?.text === 'string') out.push({ text: block.text, at: { message: mi, block: bi } });
    });
  });
  return out;
}

const grossTokens = (request) => blocks(request).reduce((n, b) => n + tokens(b.text), 0);

/** Tokens in the blocks a frontier-respecting strategy is permitted to rewrite. */
function touchableTokens(request) {
  const frontier = lastCacheBreakpoint(request);
  return blocks(request)
    .filter((b) => isAfter(b.at, frontier))
    .reduce((n, b) => n + tokens(b.text), 0);
}
const netTokens = (request) => tokens(JSON.stringify(request));

/**
 * Cache-weighted tokens.
 *
 * The prefix is everything at or before the original breakpoint. If a strategy
 * changed any of it the provider cache misses, so the prefix is billed at the
 * write rate rather than the read rate.
 */
function effectiveTokens(before, after) {
  const frontier = lastCacheBreakpoint(before);
  const originals = blocks(before);
  const compressed = blocks(after);

  let prefixIntact = true;
  let prefix = 0;
  let suffix = 0;

  for (const [i, original] of originals.entries()) {
    const now = compressed[i];
    const text = now ? now.text : original.text;
    const cached = !isAfter(original.at, frontier);
    if (cached) {
      if (text !== original.text) prefixIntact = false;
      prefix += tokens(text);
    } else {
      suffix += tokens(text);
    }
  }

  // Injected preamble is never cached on the turn it appears.
  const injected = netTokens(after) - compressed.reduce((n, b) => n + tokens(b.text), 0);
  const baseline = netTokens(before) - originals.reduce((n, b) => n + tokens(b.text), 0);

  return prefix * (prefixIntact ? CACHE_READ : CACHE_WRITE) + suffix + Math.max(0, injected - baseline);
}

const pct = (before, after) => `${(((before - after) / before) * 100).toFixed(1)}%`;

function main() {
  const spilled = [];
  const spill = (content, hint) => {
    spilled.push(content);
    return `.token-optimizer/spill/${spilled.length}-${hint}`;
  };

  console.log('\nCompression proof -- synthetic fixtures at the scale of HeadRoom\'s published workloads.');
  console.log('gross = payload only (their methodology) | net = whole request | effective = cache-weighted\n');

  const failures = [];

  for (const fixture of fixtures()) {
    const before = fixture.request;
    const g0 = grossTokens(before);
    const n0 = netTokens(before);
    const e0 = effectiveTokens(before, before);
    const t0 = touchableTokens(before);

    console.log(`=== ${fixture.name}`);
    console.log(
      `    baseline           gross ${g0}  net ${n0}  effective ${e0.toFixed(0)}` +
        `   (theirs: ${fixture.theirs.before} -> ${fixture.theirs.after}, ${pct(fixture.theirs.before, fixture.theirs.after)})`
    );

    const scores = {};
    for (const [name, run] of Object.entries(STRATEGIES)) {
      // A fresh spill per arm: one arm must not benefit from another's writes.
      const armSpill = (content, hint) => spill(content, `${name}-${hint}`);
      const result = run(before, { spill: armSpill, wanted: [] });
      const g = grossTokens(result.request);
      const n = netTokens(result.request);
      const e = effectiveTokens(before, result.request);
      const t = touchableTokens(result.request);
      scores[name] = e;
      console.log(
        `    ${name.padEnd(16)}   gross ${String(g).padStart(6)} (${pct(g0, g).padStart(6)})` +
          `  net ${String(n).padStart(6)} (${pct(n0, n).padStart(6)})` +
          `  effective ${e.toFixed(0).padStart(6)} (${pct(e0, e).padStart(6)})` +
          `  touchable (${pct(t0, t).padStart(6)})`
      );
    }

    if (!(scores['v1-frontier'] < scores.ccr)) {
      failures.push(
        `${fixture.name}: v1-frontier ${scores['v1-frontier'].toFixed(0)} effective vs ccr ${scores.ccr.toFixed(0)}`
      );
    }
    console.log('');
  }

  console.log('--- gate: v1-frontier must beat ccr on effective tokens, every workload ---');
  if (failures.length) {
    console.log('GATE FAILED:');
    for (const f of failures) console.log(`  ${f}`);
    process.exitCode = 1;
    return;
  }
  console.log('GATE PASSED on all workloads.');
}

main();
