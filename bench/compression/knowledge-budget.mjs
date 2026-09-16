/**
 * What each knowledge budget actually DELIVERS, measured before a campaign
 * is asked to price it.
 *
 * `DEFAULT_BUDGET_CHARS = 2000` carries a comment conceding the number "was
 * never chosen against a measurement, only against a worry", and the standing
 * instruction is to sweep it (0 / 2,000 / 8,000 / 32,000) and let the rig
 * answer. This runs FIRST, offline, because a rig cannot answer a question its
 * arms cannot distinguish -- and there is a specific, already-measured way that
 * happens here.
 *
 * THE FAILURE THIS EXISTS TO PREVENT. `screen-knowledge.sh` once passed its own
 * warm-up gate on file count and measured nothing: 9 files, 445KB, and zero
 * nodes carrying a `claim`. The knowledge arm injected an empty block, was
 * byte-for-byte the plain proxy arm, and returned identical turn counts on all
 * four tasks -- a null result that was really an unrun experiment. A budget
 * sweep has the same shape of failure available to it twice over:
 *
 *   - if the eligible pool is smaller than the budget, every arm at or above
 *     the pool delivers the SAME block, and those arms are one arm wearing
 *     several labels;
 *   - if the pool is empty for the arm's graph, every budget delivers nothing,
 *     and the sweep prices a feature that never fired.
 *
 * Both are invisible in a campaign's cost numbers and both look like a null.
 * So the ceiling is measured here, per graph and per scope regime, and the
 * sweep is only worth running over the budgets it can tell apart.
 *
 * TWO SCOPE REGIMES, BECAUSE THE RIG IS THE SECOND ONE. On a per-project graph
 * a `project` finding is true of exactly the tree being worked on. THOL tasks
 * run against OTHER repositories, so the rig's graph is shared: only `global`
 * and `organization` claims survive, which is a different and much smaller
 * pool. Reporting only the first would overstate what the rig can deliver by
 * whatever the project share happens to be.
 *
 * Usage:
 *   node bench/compression/knowledge-budget.mjs [graph-root ...]
 *
 * Defaults to this repository. Run `npm run build` first: this reads dist/.
 */

import { loadFindingsFrom } from '../../dist/proxy/findings.js';
import {
  knowledgeBlock,
  DEFAULT_BUDGET_CHARS,
} from '../../dist/compress/knowledge.js';

/** The sweep the plan specifies. 0 is the off arm and renders nothing. */
const BUDGETS = [0, 2000, 8000, 32000];

/**
 * Turns over which a written block is re-read.
 *
 * THOL's measured session length, not a round number: the block is charged
 * once at 1.25x and re-read at 0.1x, so its true price depends entirely on how
 * many turns it survives. Quoting a per-session cost against a session length
 * this workload does not have is how the 12.5% rewrite share came to encode a
 * 100-turn bet that a 13-turn benchmark could never honour.
 */
const SESSION_TURNS = 13;

const CACHE_WRITE = 1.25;
const CACHE_READ = 0.1;

/** Tokens, approximated the same way `proof.mjs` does, so figures compose. */
const tokens = (text) => Math.ceil(text.length / 4);

/**
 * What a block costs across a whole session, in tokens billed at 1x.
 *
 * Written once, then re-read on every later turn. This is the number the
 * budget trades against a saved turn, and it is the only honest way to state
 * the price of a block that lives in a cached prefix.
 */
const effective = (t) =>
  t * CACHE_WRITE + t * CACHE_READ * Math.max(0, SESSION_TURNS - 1);

/**
 * Contexts the block is ranked against.
 *
 * Relevance decides ORDER, never whether the block exists, so the delivered
 * SIZE is context-independent -- but WHICH findings arrive is not, and a
 * budget that fits six lines is entirely a question of which six. Three real
 * THOL task descriptions rather than one, so a pool that happens to match one
 * task's vocabulary cannot pass for a general result.
 */
const CONTEXTS = [
  ['code-bugfix-py', 'Find and fix the failing test in this Python package.'],
  [
    'code-refactor-split-py',
    'Split this module into smaller files without changing behaviour.',
  ],
  ['log-needle-zh', 'Find the one error line in this large log file.'],
];

/** Claim text eligible under a scope regime -- the ceiling any budget can reach. */
function ceiling(findings, sharedGraph) {
  // Measured through the shipped renderer at an absurd budget rather than by
  // re-implementing its filter here. A second copy of the eligibility rules
  // would drift from the real one, and then this instrument would report a
  // ceiling the proxy cannot actually deliver -- the exact class of error it
  // was built to catch.
  const all = knowledgeBlock(findings, CONTEXTS[0][1], 10_000_000, {
    sharedGraph,
  });
  return all ? all.length : 0;
}

function report(root, findings, sharedGraph, label) {
  const cap = ceiling(findings, sharedGraph);
  console.log(`\n  ${label}  (ceiling ${cap.toLocaleString()} chars)`);
  if (cap === 0) {
    console.log(
      '    NOTHING IS ELIGIBLE. Every budget delivers an empty block, so a\n' +
        '    sweep over this graph prices a feature that never fires.'
    );
    return { cap, unique: [] };
  }

  console.log(
    '    budget   delivered   findings   session cost   distinct from previous'
  );
  // KEYED ON THE RENDERED BLOCK, and on the FIRST budget that produced it.
  // Counting distinct sizes said "4 distinguishable arms" whenever any two
  // budgets differed at all -- so a ceiling between two budgets left the larger
  // ones rendering an identical block while the verdict still recommended
  // paying for every one of them. The cheapest budget that yields a given block
  // is the only one worth running.
  const firstFor = new Map();
  let previous = null;
  for (const budget of BUDGETS) {
    const block =
      budget === 0
        ? null
        : knowledgeBlock(findings, CONTEXTS[0][1], budget, { sharedGraph });
    const chars = block ? block.length : 0;
    // The heading is counted against the budget, so lines are counted from the
    // rendered block rather than from the finding list.
    const lines = block
      ? block.split('\n').filter((l) => l.trim().startsWith('-')).length
      : 0;
    const same = block === previous;
    const key = block ?? '';
    if (!firstFor.has(key)) firstFor.set(key, budget);
    console.log(
      `    ${String(budget).padStart(6)}   ${String(chars).padStart(9)}   ` +
        `${String(lines).padStart(8)}   ${effective(tokens(chars ? block : '')).toFixed(0).padStart(12)}   ` +
        (same ? 'NO -- identical to the arm above' : 'yes')
    );
    previous = block;
  }
  return { cap, unique: [...firstFor.values()] };
}

/**
 * Does ranking actually reorder, or is the block the same six lines regardless?
 *
 * A budget sweep assumes the block is worth its size; if every task receives an
 * identical block then relevance is inert and widening the budget is the only
 * lever there is. Worth knowing which of those two worlds we are in before
 * paying for a campaign.
 */
function rankingVaries(findings, sharedGraph) {
  const rendered = CONTEXTS.map(
    ([, text]) =>
      knowledgeBlock(findings, text, DEFAULT_BUDGET_CHARS, { sharedGraph }) ?? ''
  );
  return new Set(rendered).size;
}

const roots = process.argv.slice(2);
if (!roots.length) roots.push(process.cwd());

let anyDistinguishable = false;

for (const root of roots) {
  const loaded = await loadFindingsFrom(root);
  console.log(`\n${'='.repeat(74)}`);
  console.log(`graph: ${root}`);
  console.log(
    `  ${loaded.findings.length} finding(s) loaded; ` +
      `graph reports itself ${loaded.sharedGraph ? 'SHARED across projects' : 'per-project'}`
  );

  const perProject = report(
    root,
    loaded.findings,
    false,
    'per-project regime  (this repo working on itself)'
  );
  const shared = report(
    root,
    loaded.findings,
    true,
    'shared regime  (the rig: tasks run against OTHER repositories)'
  );

  const varies = rankingVaries(loaded.findings, true);
  console.log(
    `\n    ranking: ${varies} distinct block(s) across ${CONTEXTS.length} task contexts ` +
      `in the shared regime`
  );

  // The verdict this script exists to deliver. A budget arm is only worth
  // running if it delivers something no cheaper arm already delivered.
  const usable = shared.unique;
  if (shared.cap === 0) {
    console.log(
      '\n    VERDICT: do not sweep on this graph. The shared regime is empty, so\n' +
        '    every arm is the plain proxy arm and the campaign cannot answer.'
    );
  } else if (usable.length < BUDGETS.length) {
    console.log(
      `\n    VERDICT: the shared ceiling is ${shared.cap.toLocaleString()} chars, so ${BUDGETS.length - usable.length} of the\n` +
        `    ${BUDGETS.length} budgets render a block an earlier one already rendered. Sweeping\n` +
        `    ${BUDGETS.join('/')} would pay for duplicates. Sweep only ${usable.join('/')} --\n` +
        '    or seed a larger transferable pool first.'
    );
    // Two or more genuinely different arms can still answer something, even
    // though the full sweep as written would waste money on the rest.
    if (usable.length >= 2) anyDistinguishable = true;
  } else {
    anyDistinguishable = true;
    console.log(
      `\n    VERDICT: ${usable.length} distinguishable arms. The sweep can answer; run it.`
    );
  }
  void perProject;
}

console.log('');
// Non-zero when no graph can support the sweep, so a script chaining this
// before a campaign stops rather than spending.
process.exit(anyDistinguishable ? 0 : 3);
