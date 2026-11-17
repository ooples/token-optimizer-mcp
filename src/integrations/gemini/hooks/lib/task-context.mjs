// GENERATED FILE -- do not edit.
// Source of truth: src/hooks-core/task-context.mjs. Regenerate with `npm run sync:hooks`.
/**
 * Resolve a follow-up from recent conversation, then inherit if it is unclear.
 * The latest explicit request always wins. Context is local, bounded and never
 * persisted: only the category and signal names enter state or telemetry.
 */
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { classifyPrompt, isTaskCategory, TaskCategory } from './task-class.mjs';
import { isFsSafePath } from './paths.mjs';

export const TASK_CONTEXT_BYTES = 64 * 1024;
const MAX_MESSAGES = 6;
const MAX_TEXT = 4000;
const MAX_AGE = 24 * 60 * 60 * 1000;

const FOLLOW_UP = /^(?:(?:yes|yeah|yep|sure|ok(?:ay)?|agreed|sounds good|please proceed|also|and)\b|(?:(?:please|just)\s+)?(?:continue|proceed|keep going|go ahead|go with|carry on|do (?:it|that|this|the|option|#?\d{1,2})|use (?:it|that|this|the|option)|option\s+#?\d{1,2}|#?\d{1,2})\b)/i;
const STOP = /^(?:no\b|stop\b|cancel\b|never ?mind\b|forget (?:it|that)\b)|\b(?:don'?t|do not) (?:do|continue|proceed|use)\b/i;
const CHOICE = /\boption\s*#?(\d{1,2})\b|#(\d{1,2})\b|\bdo\s+(\d{1,2})\b|^(\d{1,2})(?:\s+please)?[.!]?$/i;
const CHOICE_REPLY = /^(?:(?:yes|ok(?:ay)?|sure)\b[,\s]*)?(?:(?:please\s+)?(?:do|use|go with|choose|pick)\s+)?(?:option\s*#?\d{1,2}|#\d{1,2}|\d{1,2}\b)/i;
const NEGATED_ACTION = /\b(?:don'?t|do not|never)\s+(?:do|continue|proceed|use|rewrite|reformat|translate|build|implement|write|fix)\b[^.!?;\n]*?(?=\b(?:but|instead|then)\b|[.!?;\n]|$)/gi;

function textOf(content, tail = false) {
  const clip = (text) => tail ? text.slice(-MAX_TEXT) : text.slice(0, MAX_TEXT);
  if (typeof content === 'string') return clip(content);
  if (!Array.isArray(content) || content.some((b) => b?.type === 'tool_result')) return '';
  let text = '';
  for (const block of content) {
    if (/^(?:text|input_text|output_text)$/.test(block?.type) && typeof block.text === 'string')
      text = clip(`${text}${text ? '\n' : ''}${block.text}`);
    if (!tail && text.length >= MAX_TEXT) break;
  }
  return text;
}

/** Claude JSONL and Codex rollout message records; no tools or reasoning. */
function conversationMessage(entry) {
  if (!entry || entry.isMeta || entry.isCompactSummary) return null;
  const codex = entry.type === 'response_item';
  const message = codex ? entry.payload : entry.message || entry;
  if (!message || (codex && message.type !== 'message')) return null;
  const role = codex ? message.role : entry.type || message.role;
  if (role !== 'user' && role !== 'assistant') return null;
  if (message.channel && !['final', 'commentary'].includes(message.channel)) return null;
  // Proposed next steps are usually at the end of a long assistant response.
  // User prompts retain their head, so pasted logs do not choose the task.
  const text = textOf(message.content, role === 'assistant').trim();
  if (!text || /^(?:# AGENTS\.md instructions|<environment_context>|<system|<developer|<user_instructions>)/i.test(text)) return null;
  return { role, text };
}

/** Read only a regular file's tail, dropping partial JSONL records. */
export function readTaskContext(path, prompt, { now = Date.now() } = {}) {
  if (typeof path !== 'string' || !path || !isFsSafePath(path)) return [];
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NONBLOCK || 0));
    const stat = fstatSync(fd);
    if (!stat.isFile()) return [];
    if (now - stat.mtimeMs > MAX_AGE) return [];
    const length = Math.min(stat.size, TASK_CONTEXT_BYTES);
    if (!length) return [];
    const buffer = Buffer.alloc(length);
    const read = readSync(fd, buffer, 0, length, stat.size - length);
    let text = buffer.subarray(0, read).toString('utf8');
    if (stat.size > length) text = text.slice(text.indexOf('\n') + 1);
    const messages = [];
    for (const line of text.split('\n')) {
      try {
        const entry = JSON.parse(line);
        const at = Date.parse(entry.timestamp || '');
        if (Number.isFinite(at) && (now - at > MAX_AGE || at > now + 60_000)) continue;
        const message = conversationMessage(entry);
        if (message) messages.push(message);
      } catch {
        // A partial append or an unsupported record is not conversation.
      }
    }
    // Some hosts append the current prompt before invoking its hook, others
    // after. Remove only the trailing copy, never earlier identical approvals.
    if (messages.at(-1)?.role === 'user' && messages.at(-1).text === String(prompt).trim().slice(0, MAX_TEXT)) messages.pop();
    return messages.slice(-MAX_MESSAGES);
  } catch {
    return [];
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** An option's body ends at the next option; never score all choices at once. */
function selectedOption(text, number) {
  const options = [...text.matchAll(/^\s*(?:#{1,6}\s*)?(?:\*\*)?(\d{1,2})[.)]\s+([^\n]*(?:\n(?!\s*(?:#{1,6}\s*)?(?:\*\*)?\d{1,2}[.)]\s)[^\n]*)*)/gm)];
  const matches = options.filter((m) => Number(m[1]) === number);
  return matches.length === 1 ? matches[0][2] : '';
}

/** Prospective actions only: a completed report is not a proposal to write it. */
function proposal(text) {
  // Multiple choices without a selection are deliberately unresolved.
  if ((text.match(/^\s*(?:\*\*)?\d{1,2}[.)]\s/gm) || []).length > 1) return '';
  const found = [...text.matchAll(/(?:\b(?:I can|I will|I['’]ll|I could|shall I|should I|would you like me to|do you want me to|I recommend|next step is to|next I can)\s+)([^!?\n]+?)(?=\.(?:\s|$)|[!?\n]|$)/gi)];
  if (found.length !== 1) return '';
  return /\bor\b/i.test(found[0][1]) ? '' : found[0][1];
}

function unquoted(text) {
  return text.replace(/```[^]*?(?:```|$)/g, '').split('\n').filter((line) => !/^\s*>/.test(line)).join('\n');
}

/**
 * No model calls and no concatenation of old prompts into the current one.
 * Only approvals/continuations may use context or inherit; unrelated chat,
 * cancellations and unrecognised new requests return UNKNOWN.
 */
export function resolveTaskPrompt(prompt, {
  cwd, previous, messages = [], transcriptPath, now = Date.now(),
} = {}) {
  const text = String(prompt || '').slice(0, MAX_TEXT).trim();
  const intent = text.replace(NEGATED_ACTION, '').replace(/^no,\s*/i, '').trim();
  const direct = classifyPrompt(intent, { cwd });
  if (!intent || STOP.test(intent)) return { ...direct, category: TaskCategory.UNKNOWN, source: 'prompt', signals: [] };
  // A numbered approval can include background symptoms or a review request.
  // Classify the selected action rather than that incidental vocabulary. A
  // fresh directive introduced with "now" or "instead" still takes priority.
  const selecting = CHOICE_REPLY.test(text) && !/\b(?:now|instead)\s+(?:write|rewrite|fix|build|implement|explain|find)\b/i.test(text);
  if (direct.category !== TaskCategory.UNKNOWN && !selecting) return { ...direct, source: 'prompt' };
  if (intent !== text) return { ...direct, source: 'prompt' };
  if (!FOLLOW_UP.test(text)) return { ...direct, source: 'prompt' };
  const recent = transcriptPath ? readTaskContext(transcriptPath, text, { now }) : messages.slice(-MAX_MESSAGES);
  const last = recent.at(-1);
  const choice = text.match(CHOICE);
  const multipleChoices = [...text.matchAll(/\boption\s*#?\d{1,2}\b|#\d{1,2}\b/g)].length > 1;
  const assistantText = last?.role === 'assistant' ? unquoted(last.text) : '';
  let candidate = '';
  if (last?.role === 'assistant') {
    if (!choice) candidate = proposal(assistantText);
    else if (!multipleChoices) candidate = selectedOption(assistantText, Number(choice[1] || choice[2] || choice[3] || choice[4]));
  }
  if (candidate) {
    // Proposed paths are not current user requests: do not stat them.
    const contextual = classifyPrompt(candidate, { statPaths: false });
    if (contextual.category !== TaskCategory.UNKNOWN)
      return { ...contextual, source: 'context', signals: ['context:accepted-proposal'] };
  }
  if (direct.category !== TaskCategory.UNKNOWN) return { ...direct, source: 'prompt' };
  if (isTaskCategory(previous?.category) && previous.category !== TaskCategory.UNKNOWN &&
      previous.gen > 0 && previous.gen <= now + 60_000 && now - previous.gen <= MAX_AGE)
    return { ...direct, category: previous.category, source: 'inherited', signals: ['context:current-task'] };
  // Resuming without state: only the most recent user turn supplies the task.
  const user = !previous ? recent.findLast((m) => m.role === 'user') : null;
  if (user) {
    const priorIntent = user.text.replace(NEGATED_ACTION, '').trim();
    const contextual = STOP.test(priorIntent) ? null : classifyPrompt(priorIntent, { statPaths: false });
    if (contextual && contextual.category !== TaskCategory.UNKNOWN)
      return { ...contextual, source: 'context', signals: ['context:previous-request'] };
  }
  return { ...direct, source: 'prompt' };
}
