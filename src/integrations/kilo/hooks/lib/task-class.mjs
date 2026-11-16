// GENERATED FILE -- do not edit.
// Source of truth: src/hooks-core/task-class.mjs. Regenerate with `npm run sync:hooks`.
/**
 * What kind of task a session is doing, so settings can follow the task.
 *
 * WHY THIS EXISTS. One default per setting is measurably wrong for some tasks.
 * Outline substitution helps a model locate something in a large file (ledger
 * large-file-defect 0.926x) and costs it 1.356x when it is about to rewrite the
 * whole file (ledger whole-file-transform). The output-discipline block won on
 * debug-pipeline-py (0.58x) and lost on seo-audit (1.23x). A setting that can
 * only be on or off everywhere gives up one of each pair. So the session is
 * given a category, and task-settings.mjs holds a default per category.
 *
 * TWO PASSES, BECAUSE A PROMPT CAN MISLEAD (chosen 2026-11-16). The prompt is
 * classified when it is submitted, which is the only point early enough for
 * text that has to be in context before the first turn. The first tool calls
 * then confirm or correct it: a model that reads a 500 KB log is locating,
 * whatever the prompt said. Text already delivered cannot be retracted, so the
 * second pass only moves settings applied per tool call.
 *
 * DETERMINISTIC AND CHEAP. This runs inside a hook with a deadline, on every
 * prompt, so it is rules over bounded input: no model call, no directory walk.
 * Ties and weak evidence give UNKNOWN, whose settings are today's defaults, so
 * a wrong guess can never be worse than not classifying.
 */

import { statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { isFsSafePath } from './paths.mjs';

/** The closed set of categories. Frozen: a typo is undefined, never a new category. */
export const TaskCategory = Object.freeze({
  FIX: 'fix',
  BUILD: 'build',
  REWRITE: 'rewrite',
  SURVEY: 'survey',
  LOCATE: 'locate',
  EXPLAIN: 'explain',
  UNKNOWN: 'unknown',
});

const CATEGORIES = new Set(Object.values(TaskCategory));

export function isTaskCategory(value) {
  return CATEGORIES.has(value);
}

/** Classification reads a fixed head of the prompt: a pasted log must not decide it. */
const PROMPT_HEAD = 4000;

/** A file this large, named by the prompt, is something to search, not to read. */
const LARGE_INPUT_BYTES = 256 * 1024;

/** At most this many files named by the prompt are checked on disk. */
const MAX_STATS = 8;

/** The winner needs this score and this lead over the runner-up, or the answer is UNKNOWN. */
const MIN_SCORE = 2;
const MIN_LEAD = 1;

/*
 * Each rule is [pattern, weight]. Patterns are single-level (no quantified
 * group inside a quantified group) because they run over pasted text, and a
 * JavaScript regex cannot be given a timeout. CJK alternatives are included
 * because the prompts this product sees are not all English (THOL log-needle-zh).
 */
const RULES = {
  [TaskCategory.FIX]: [
    [/\b(?:failing|failed|fails|broken|red)\b[^.\n]{0,40}\b(?:tests?|suite|build|ci)\b/i, 3],
    [/\b(?:tests?|suite|build)\b[^.\n]{0,30}\b(?:fail(?:s|ing)?|red|broken)\b/i, 3],
    [/\b(?:fix|debug|repair)\b[^.\n]{0,40}\b(?:bugs?|errors?|crash|regression|issue)\b/i, 3],
    [/\broot cause\b/i, 2],
    [/\b(?:traceback|stack trace|exception)\b/i, 1],
    [/\bfix\b/i, 1],
    [/修复|失败的测试|报错|缺陷/, 3],
  ],
  [TaskCategory.BUILD]: [
    [/\bimplement\b/i, 2],
    [/\b(?:SPEC|MIGRATION|REFACTOR|DESIGN)\.md\b/, 2],
    [/\b(?:add|build|create)\b[^.\n]{0,30}\b(?:feature|endpoint|command|function|class|module|support)\b/i, 2],
    [/\b(?:migrate|migration|refactor|split)\b/i, 2],
    [/实现|新增功能|迁移|重构/, 3],
  ],
  [TaskCategory.REWRITE]: [
    [/\brewrite\b[^.\n]{0,30}\b(?:whole|entire|this|the)\b[^.\n]{0,20}\bfile\b/i, 4],
    [/\b(?:convert|translate|port|reformat)\b[^.\n]{0,40}\b(?:file|module)\b/i, 3],
    [/\b(?:whole|entire)\s+file\b/i, 2],
    [/重写整个文件|整个文件/, 4],
  ],
  [TaskCategory.SURVEY]: [
    [/\b(?:write|produce|create|generate)\b[^.\n]{0,50}\.md\b/i, 3],
    [/\b(?:audit|inventory|overview|architecture|onboarding|report|documentation)\b/i, 2],
    [/\b(?:every|all)\b[^.\n]{0,30}\b(?:pages?|files?|modules?|settings?|components?)\b/i, 1],
    [/报告|审计|文档|概述|清单/, 2],
  ],
  [TaskCategory.LOCATE]: [
    [/\b(?:find|locate|identify|which|where)\b[^.\n]{0,60}\b(?:log|output|line|entry|occurrence)\b/i, 3],
    [/\.log\b/i, 1],
    [/\b(?:noisy|huge|long|large)\b[^.\n]{0,30}\b(?:log|output|file)\b/i, 2],
    [/日志|找出|查找|定位/, 2],
  ],
  [TaskCategory.EXPLAIN]: [
    [/^\s*(?:why|how does|how do|what does|what is|explain)\b/i, 3],
    [/\bexplain\b/i, 2],
    [/为什么|解释/, 3],
  ],
};

/** Paths a prompt names: `backticked`, or bare tokens that end in an extension. */
function namedPaths(text) {
  const found = new Set();
  for (const m of text.matchAll(/`([^`\n]{1,200})`/g)) found.add(m[1].trim());
  for (const m of text.matchAll(/(?:^|[\s(])([\w./\\-]{1,200}\.[A-Za-z0-9]{1,8})(?=[\s),.:;]|$)/g))
    found.add(m[1]);
  return [...found].filter((p) => /\.[A-Za-z0-9]{1,8}$/.test(p) && !/\s/.test(p));
}

function sizeOf(path, cwd) {
  try {
    const full = isAbsolute(path) || !cwd ? path : join(cwd, path);
    // A path carrying U+10FFFF aborts libuv instead of throwing (paths.mjs),
    // and this runs on whatever path a prompt or a tool call names.
    if (!isFsSafePath(full)) return -1;
    const st = statSync(full);
    return st.isFile() ? st.size : -1;
  } catch {
    return -1;
  }
}

/**
 * The category of a prompt, with the evidence that chose it.
 *
 * @param {string} prompt the user's prompt
 * @param {{cwd?: string}} [workspace] where relative paths in the prompt resolve
 * @returns {{category: string, scores: Record<string, number>, signals: string[]}}
 */
export function classifyPrompt(prompt, { cwd } = {}) {
  const text = String(prompt || '').slice(0, PROMPT_HEAD);
  const scores = Object.fromEntries([...CATEGORIES].map((c) => [c, 0]));
  const signals = [];

  for (const [category, rules] of Object.entries(RULES))
    for (const [pattern, weight] of rules)
      if (pattern.test(text)) {
        scores[category] += weight;
        signals.push(`${category}:${pattern.source.slice(0, 32)}`);
      }

  // WORKSPACE EVIDENCE: only what the prompt itself names, and only a stat.
  for (const path of namedPaths(text).slice(0, MAX_STATS)) {
    const size = sizeOf(path, cwd);
    if (size >= LARGE_INPUT_BYTES) {
      scores[TaskCategory.LOCATE] += 3;
      signals.push(`locate:large-input:${path}`);
    }
  }

  const ranked = Object.entries(scores)
    .filter(([c]) => c !== TaskCategory.UNKNOWN)
    .sort((a, b) => b[1] - a[1]);
  const [[best, top], [, second]] = ranked;
  const category = top >= MIN_SCORE && top - second >= MIN_LEAD ? best : TaskCategory.UNKNOWN;
  return { category, scores, signals };
}

/** How many tool calls the second pass looks at before the category is settled. */
export const RECLASSIFY_WINDOW = 6;

const TEST_COMMAND =
  /\b(?:pytest|unittest|jest|vitest|mocha|go test|cargo test|dotnet test|npm (?:run )?test|yarn test|pnpm test)\b/;

/**
 * The second pass: what the first tool calls say the task is.
 *
 * Returns a category only on evidence strong enough to overrule the prompt,
 * else null (keep the prompt's answer). One call at a time, so a hook can
 * apply it the moment the evidence appears.
 *
 * @param {{tool_name?: string, tool_input?: object, tool_response?: unknown}} call
 * @param {{readPaths?: string[], cwd?: string}} [context]
 */
export function categoryFromToolCall(call, { readPaths = [], cwd } = {}) {
  const name = String(call?.tool_name || '');
  const input = call?.tool_input || {};
  const path = typeof input.file_path === 'string' ? input.file_path : '';

  // A whole-file read of something huge is a search, whatever the prompt said.
  if (/^(?:Read|read_file|view)$/i.test(name) && path && input.offset == null && input.limit == null)
    if (sizeOf(path, cwd) >= LARGE_INPUT_BYTES) return TaskCategory.LOCATE;

  // Replacing a file the session already read, wholesale, is a rewrite.
  if (/^(?:Write|write_file|create)$/i.test(name) && path && readPaths.includes(path))
    return TaskCategory.REWRITE;

  // A test run that fails before anything was edited is a fix.
  if (/^(?:Bash|shell|run_shell_command|exec_command)$/i.test(name)) {
    const command = String(input.command || input.cmd || '');
    const out = typeof call.tool_response === 'string'
      ? call.tool_response
      : JSON.stringify(call.tool_response || '');
    if (TEST_COMMAND.test(command) && /\b(?:FAILED|FAIL|failures?=|[1-9]\d* failed|AssertionError)\b/.test(out.slice(0, 20000)))
      return TaskCategory.FIX;
  }
  return null;
}

/*
 * WHICH EVIDENCE MAY OVERRULE THE PROMPT. A red test run is how a BUILD task
 * starts too ("implement SPEC.md; the suite is failing"), so it only settles a
 * session the prompt left UNKNOWN. A whole-file read of a huge input and a
 * wholesale rewrite are what LOCATE and REWRITE mean, and they are exactly the
 * cases outline substitution gets right or wrong, so they overrule anything.
 */
const OVERRULES = new Set([TaskCategory.LOCATE, TaskCategory.REWRITE]);

/**
 * The session's category after one more tool call.
 *
 * @param {{category: string, source: string, calls: number}} current
 * @returns {{category: string, source: string, calls: number}} a new record, or `current` unchanged
 */
export function afterToolCall(current, call, context = {}, { count = true } = {}) {
  const base = current && isTaskCategory(current.category)
    ? current
    : { category: TaskCategory.UNKNOWN, source: 'none', calls: 0 };
  // Settled once the window has passed: later calls neither count nor move it.
  if ((Number(base.calls) || 0) >= RECLASSIFY_WINDOW) return base;
  // A call is counted once, where it starts; its result is judged again
  // without counting, so a pre-tool and a post-tool hook do not count it twice.
  const calls = (Number(base.calls) || 0) + (count ? 1 : 0);
  const seen = categoryFromToolCall(call, context);
  if (seen && seen !== base.category && (OVERRULES.has(seen) || base.category === TaskCategory.UNKNOWN))
    return { category: seen, source: 'tools', calls };
  return calls === base.calls ? base : { ...base, calls };
}
