/**
 * The settings a session runs with, chosen by its task category.
 *
 * ONE ROW PER CATEGORY, AND UNKNOWN IS TODAY'S PRODUCT. A category with no
 * measurement inherits every value from UNKNOWN, so classifying a session can
 * only change behaviour where a measurement says the change pays. A cell that
 * differs from UNKNOWN must name the measurement behind it, in EVIDENCE below;
 * tests/hooks/task-settings.test.mjs fails on a cell without one.
 *
 * AN EXPLICIT SWITCH STILL WINS. A user who set TOKEN_OPTIMIZER_OUTPUT_DISCIPLINE
 * or TOKEN_OPTIMIZER_OUTLINE decided for every task; the table only fills in
 * what nobody decided.
 */

import { TaskCategory, isTaskCategory } from './task-class.mjs';

/**
 * The output-discipline block, exported so a benchmark arm can deliver it the
 * way a competitor delivers theirs -- as a CLAUDE.md, with no hooks at all.
 *
 * ONE SOURCE OF TRUTH, deliberately. The head-to-head compared our arm (hooks
 * PLUS this text) against theirs (text alone) and I described it as text
 * versus text, which it was not. Fixing that needs an arm carrying only these
 * words; copying them into the benchmark would let the measured text drift
 * from the shipped text, so the arm imports this constant instead.
 *
 * IT GOVERNS WHAT THE MODEL WRITES, NEVER HOW IT READS (#594 discipline A/B).
 * The earlier wording ("quote the shortest decisive line of a command result")
 * was read as an instruction about tool use: with it, 0 of 5 log-needle runs
 * used Read (5 of 5 without it), and every bugfix run added `| tail -30` and a
 * separate find/grep, one more turn each. A turn re-reads the whole context,
 * so the narrower calls cost more than the bytes they saved: bugfix 0.105 vs
 * 0.096, log-needle 0.145 vs 0.138 (median $, 5 reps). The output-token gains
 * were real (seo-audit -9% output), so the block is scoped, not dropped.
 *
 * WHETHER IT HELPS DEPENDS ON THE TASK, which is why it is a per-category
 * setting. The ledger data has it winning on debug-pipeline-py (0.58x) and
 * explain-failure (0.87x); te-bench 594-discipline-v2 has the rewrite losing
 * on seo-audit (1.23x), log-needle (1.17x) and bugfix (1.07x).
 */
export const OUTPUT_DISCIPLINE = [
  '## Keep output lean',
  '',
  'Every token you write is billed at output rates -- far dearer than reading.',
  '- No preamble, recap, tool-call narration, or closing summary. Answer directly.',
  '- In replies, quote only the decisive line of a result; never paste it whole.',
  '- Write the least code that works; reuse what exists before adding.',
  '- Keep identifiers, paths, API names and error strings verbatim -- never paraphrase.',
  '- Correctness first: brevity that loses a fact is not a saving.',
  '- This is about what you write, not how you read: read files and run commands as',
  '  usual, and prefer fewer tool calls over smaller ones.',
].join('\n');

/** What UNKNOWN runs with: the product's behaviour before categories existed. */
const DEFAULTS = Object.freeze({
  /** The "Keep output lean" block, delivered with the prompt (see adapter.mjs). */
  outputDiscipline: true,
  /** Whole-file Reads of large code files answered with an outline first. */
  outlineSubstitution: true,
});

/** Only the cells that differ from DEFAULTS. Every one needs an EVIDENCE entry. */
const OVERRIDES = Object.freeze({
  [TaskCategory.REWRITE]: Object.freeze({ outlineSubstitution: false }),
});

/**
 * Why each override exists. Keyed `${category}.${setting}`.
 * Pending measurements (te-bench campaigns/594-discipline-bycat) fill in
 * outputDiscipline for fix, build and survey; until then they inherit.
 */
export const EVIDENCE = Object.freeze({
  'rewrite.outlineSubstitution':
    'bench/ledger/RESULTS-LARGECONTEXT.md: on whole-file-transform, hooks with outlining cost ' +
    '1.356x [1.125, 1.642] the same text without them, n=30; the model paid for the outline, ' +
    'then read the whole file anyway.',
});

const ON = new Set(['1', 'on', 'true', 'yes']);
const OFF = new Set(['0', 'off', 'false', 'no']);

/** true / false for an explicit switch, undefined when nobody set it. */
function explicit(raw) {
  const value = String(raw ?? '').trim().toLowerCase();
  if (ON.has(value)) return true;
  if (OFF.has(value)) return false;
  return undefined;
}

/** The env switch that overrides each setting for every category. */
export const SETTING_ENV = Object.freeze({
  outputDiscipline: 'TOKEN_OPTIMIZER_OUTPUT_DISCIPLINE',
  outlineSubstitution: 'TOKEN_OPTIMIZER_OUTLINE',
});

/** The table row for a category, with no env applied. */
export function tableRow(category) {
  const row = isTaskCategory(category) ? OVERRIDES[category] : undefined;
  return { ...DEFAULTS, ...(row || {}) };
}

/**
 * The settings for a category, an explicit env switch winning over the table.
 *
 * @param {string} category a TaskCategory value; anything else is UNKNOWN
 * @param {NodeJS.ProcessEnv} [env]
 */
export function settingsFor(category, env = process.env) {
  const row = tableRow(category);
  for (const [setting, name] of Object.entries(SETTING_ENV)) {
    const forced = explicit(env[name]);
    if (forced !== undefined) row[setting] = forced;
  }
  return row;
}

/** The settings for a session, from the category its state carries. */
export function sessionSettings(state, env = process.env) {
  return settingsFor(state?.taskClass?.category ?? TaskCategory.UNKNOWN, env);
}

/** Every category's row, for tests and the doctor. */
export function settingsTable() {
  return Object.fromEntries(Object.values(TaskCategory).map((c) => [c, tableRow(c)]));
}
