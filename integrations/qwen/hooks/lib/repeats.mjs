// GENERATED FILE -- do not edit.
// Source of truth: hooks-core/repeats.mjs. Regenerate with `npm run sync:hooks`.
/**
 * Diff-only repeats: a command run again, or a file read again, returns only
 * what changed since the agent last saw it.
 *
 * WHY. An edit/test loop runs the same test command after every change and
 * re-reads the file it just edited. Each repeat lands in the context in full
 * and is re-read on every later call, though most of it is what the agent
 * already has a few calls back.
 *
 * ONLY WHILE THE EARLIER RESULT IS SURELY STILL THERE. A pointer to an earlier
 * output is only an answer if that output is still in the agent's context, so
 * this applies within REPEAT_WINDOW tool calls -- the same number of recent
 * results the server-side clearing always keeps (src/compress/context-edit.ts).
 *
 *   Bash/PowerShell, same command, same output   one line naming the earlier call
 *   Bash/PowerShell, same command, changed       the changed lines only, each
 *                                                hunk with its line numbers
 *   Read, same file and range, unchanged         one line naming the earlier Read
 *
 * A changed Read is always passed through whole: an edit is built from it. The
 * full output of every rewritten result stays one Read away in the artifact
 * store. TOKEN_OPTIMIZER_REPEATS=0 turns it off.
 */
import { createHash } from 'node:crypto';

export const REPEAT_WINDOW = 5;
/** Below this many characters a repeat is cheaper to show than to explain. */
export const REPEAT_MIN_CHARS = 400;
/** A changed output is shown as a diff only when the diff is at most this share of it. */
const DIFF_MAX_SHARE = 0.6;
const MAX_KEYS = 64;
/** Outputs longer than this are remembered by hash only (identical-repeat detection). */
const MAX_TEXT = 40_000;
/** Above this many line pairs the exact diff is not attempted. */
const LCS_LIMIT = 4_000_000;
const NL = '\n';
const STDERR = `${NL}[stderr]${NL}`;

export function repeatsEnabled(env = process.env) {
  return !/^(0|false|no|off)$/i.test(String(env.TOKEN_OPTIMIZER_REPEATS ?? '').trim());
}

const digest = (text) => createHash('sha256').update(String(text)).digest('hex').slice(0, 20);

/** What makes two calls "the same": tool, working directory and the exact input. */
export function repeatKey(tool, input, cwd = '') {
  if (tool === 'Bash' || tool === 'PowerShell') {
    const command = String(input?.command ?? '').trim().replace(/\s+/g, ' ');
    return command ? `${tool}|${cwd}|${command}` : null;
  }
  if (tool === 'Read' && input?.file_path)
    return `Read|${input.file_path}|${input.offset ?? ''}|${input.limit ?? ''}`;
  return null;
}

function outputOf(tool, response) {
  if (tool === 'Read') return typeof response?.file?.content === 'string' ? response.file.content : null;
  if (typeof response?.stdout !== 'string') return null;
  return response.stderr ? `${response.stdout}${STDERR}${response.stderr}` : response.stdout;
}

/**
 * The changed hunks of `next` against `prev`, by a longest-common-subsequence
 * line diff: where each hunk sits in `next`, the lines that are new there, and
 * how many old lines went. Null when the outputs are too large to diff exactly.
 */
export function lineHunks(prev, next) {
  const a = String(prev).split(NL);
  const b = String(next).split(NL);
  if (a.length * b.length > LCS_LIMIT) return null;
  const n = a.length;
  const m = b.length;
  const w = m + 1;
  // lcs[i * w + j]: longest common subsequence of a[i..] and b[j..].
  const lcs = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      lcs[i * w + j] = a[i] === b[j] ? lcs[(i + 1) * w + j + 1] + 1 : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1]);
  const hunks = [];
  let open = null;
  const close = () => {
    if (open) hunks.push(open);
    open = null;
  };
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      close();
      i++;
      j++;
    } else if (j < m && (i >= n || lcs[i * w + j + 1] >= lcs[(i + 1) * w + j])) {
      open = open || { at: j + 1, added: [], removed: 0 };
      open.added.push(b[j]);
      j++;
    } else {
      open = open || { at: j + 1, added: [], removed: 0 };
      open.removed++;
      i++;
    }
  }
  close();
  return hunks;
}

function render(hunks) {
  return hunks
    .map((h) => {
      const span = h.added.length > 1 ? `-${h.at + h.added.length - 1}` : '';
      const where = h.added.length ? `line ${h.at}${span}` : `after line ${h.at - 1}`;
      const gone = h.removed ? ` (${h.removed} earlier line${h.removed > 1 ? 's' : ''} gone)` : '';
      return [`@@ ${where}${gone}`, ...h.added].join(NL);
    })
    .join(NL);
}

/**
 * The result to hand the model instead, or null to pass it through. Records
 * this call either way, so the next repeat compares against the latest output.
 *
 * @param {{ tool: string, input: object, response: object, cwd?: string, call: number, state: object, store?: (text: string) => string | null }} p
 */
export function repeatResponse({ tool, input, response, cwd = '', call, state, store }) {
  const key = repeatKey(tool, input, cwd);
  const text = key ? outputOf(tool, response) : null;
  if (!key || text === null) return null;
  const id = digest(key);
  state.repeats = state.repeats || {};
  const prior = state.repeats[id];
  state.repeats[id] = { hash: digest(text), call, text: text.length > MAX_TEXT ? null : text };
  // Bounded: the oldest entries go first.
  const ids = Object.keys(state.repeats);
  if (ids.length > MAX_KEYS)
    for (const old of ids.sort((x, y) => state.repeats[x].call - state.repeats[y].call).slice(0, ids.length - MAX_KEYS))
      delete state.repeats[old];

  if (!prior || call - prior.call > REPEAT_WINDOW || text.length < REPEAT_MIN_CHARS) return null;
  const same = prior.hash === digest(text);

  if (tool === 'Read') {
    if (!same) return null;
    const lines = response.file.numLines ?? text.split(NL).length;
    return {
      ...response,
      file: {
        ...response.file,
        content: `[unchanged since your Read of this file at call #${prior.call}: the same ${lines} lines, still in your context above]`,
      },
    };
  }

  const ref = store ? store(text) : null;
  const where = ref ? ` Full output: ${ref}` : '';
  if (same)
    return {
      ...response,
      stdout: `[identical to the output of this same command at your call #${prior.call}, still in your context above.${where}]`,
      stderr: '',
    };
  if (!prior.text) return null;
  const hunks = lineHunks(prior.text, text);
  if (!hunks) return null;
  const shown = render(hunks);
  if (shown.length > text.length * DIFF_MAX_SHARE) return null;
  const total = text.split(NL).length;
  return {
    ...response,
    stdout: `[changed since this command's output at your call #${prior.call}; of its ${total} lines only the changed ones follow, the rest are identical and in your context above.${where}]${NL}${shown}`,
    stderr: '',
  };
}
