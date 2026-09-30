/**
 * Codex's rollout logs.
 *
 * ~/.codex/sessions/<year>/<month>/<day>/rollout-<stamp>-<id>.jsonl, one JSON
 * object per line, each with a `type` and a `payload`.
 *
 * THIS FORMAT DOES NOT SAY WHICH CALLS FAILED. Claude Code stamps `is_error` on a
 * result; Codex returns the tool's own JSON, and whether it went wrong is inside
 * that -- an `exit_code` that is not zero, a `status` of rejected, an error string
 * where output was expected. So the failure test here is structural first and only
 * falls back to reading wording when the structure says nothing, which is the
 * opposite order from the wording-only guess it would be easy to settle for.
 *
 * The date directories are not a convenience to skip: a day's directory is the
 * only cheap way to honour `since` without opening every session ever recorded.
 */

import { Dirent, existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { classifyFailure, failureDetail } from '../classify.js';
import { SubjectKind, ProjectInfo, SessionData, ToolCall } from '../models.js';
import { AgentPlugin, BuiltInAgent, ContextTarget, ScanOptions } from '../plugin.js';
import {
  DEFAULT_MAX_BYTES,
  parseLine,
  readJsonlHead,
  recordField,
  stringField,
  textOf,
} from './jsonl.js';

function sessionsRoot(): string {
  const override = process.env.TOKEN_OPTIMIZER_CODEX_HOME;
  const home = override !== undefined && override.length > 0 ? override : homedir();
  return join(home, '.codex', 'sessions');
}

/** Every rollout file under the year/month/day tree, newest first. */
function sessionFiles(root: string): { path: string; mtime: number }[] {
  const files: { path: string; mtime: number }[] = [];
  const walk = (dir: string, depth: number): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        // Three levels of date directories and no deeper. A bound here is what
        // keeps a stray symlink in a log directory from walking a whole disk.
        if (depth < 3) walk(path, depth + 1);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      try {
        files.push({ path, mtime: statSync(path).mtimeMs });
      } catch {
        // Gone between the listing and the stat.
      }
    }
  };
  walk(root, 0);
  return files.sort((a, b) => b.mtime - a.mtime);
}

/** What the tool's own reply says about how it went. */
interface Verdict {
  readonly failed: boolean;
  readonly reason: string;
}

/**
 * Read a Codex tool reply.
 *
 * The reply is a list of text parts, and a part is often itself JSON: an exec
 * result carries `exit_code`, a parallel batch carries `{status, value}` per
 * branch. Both are read structurally. Anything that is not JSON is left to the
 * wording test, and a reply that says nothing either way is a success -- treating
 * silence as failure would turn every tool without a status field into a fault.
 */
export function readCodexOutput(output: unknown): Verdict {
  // THE STRUCTURE IS READ BEFORE IT IS FLATTENED. A reply that arrives as an object
  // rather than as a string of JSON was only ever flattened to text here, and
  // flattening `{exit_code: 1, stderr: "..."}` yields the empty stdout beside it --
  // so a call that plainly failed read as a success and was dropped.
  const direct = judge(output);
  if (direct !== null && direct.failed) return direct;
  const parts: string[] = [];
  const collect = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) collect(item);
      return;
    }
    const text = textOf(value);
    if (text.length > 0) parts.push(text);
  };
  collect(output);

  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const verdict = judge(parsed);
    if (verdict !== null) return verdict;
  }
  return { failed: false, reason: '' };
}

function judge(value: unknown, depth = 0): Verdict | null {
  if (depth > 4) return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const verdict = judge(item, depth + 1);
      if (verdict !== null && verdict.failed) return verdict;
    }
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  const status = record['status'];
  if (status === 'rejected' || status === 'failed' || status === 'error') {
    return { failed: true, reason: textOf(record['reason'] ?? record['value'] ?? '') };
  }
  const code = record['exit_code'];
  if (typeof code === 'number' && code !== 0) {
    // stderr counts. Without it the reason was "exit code 1" and nothing else,
    // which restates the category and is refused downstream as no evidence at all.
    const said = textOf(record['output']) || textOf(record['stderr']) || textOf(record['stdout']);
    return { failed: true, reason: `exit code ${code}\n${said}` };
  }
  if (record['success'] === false) {
    return { failed: true, reason: textOf(record['error'] ?? record['output'] ?? '') };
  }
  for (const key of ['value', 'result', 'data']) {
    if (key in record) {
      const verdict = judge(record[key], depth + 1);
      if (verdict !== null) return verdict;
    }
  }
  return null;
}

/** The wording test, used only where the structure said nothing. */
const SAYS_ERROR = /^(?:error|exception|failed|fatal|traceback)\b/im;

interface Subject {
  readonly value: string;
  readonly kind: SubjectKind;
}

interface Pending {
  readonly name: string;
  readonly subject: Subject;
  readonly index: number;
}

const NOTHING: Subject = { value: '', kind: SubjectKind.None };

/** The fields this format's tool inputs use, and what each one holds. */
const SUBJECT_KEYS: readonly (readonly [string, SubjectKind])[] = [
  ['command', SubjectKind.Command],
  ['cmd', SubjectKind.Command],
  ['file_path', SubjectKind.Path],
  ['path', SubjectKind.Path],
  ['pattern', SubjectKind.Pattern],
  ['query', SubjectKind.Pattern],
  ['url', SubjectKind.Url],
];

/**
 * What the call was about, and what kind of thing that is.
 *
 * THE INPUT HERE IS A JSON DOCUMENT, not a field. Codex records a shell call as
 * `{"command":["bash","-lc","..."],"workdir":...}`, so flattening the whole thing to
 * text -- which is what this did first -- produces a subject that is mostly JSON
 * punctuation and groups by nothing. The named fields are read first, and an array
 * command is joined back into the line it was, which is what the analyser groups by.
 */
function subjectOf(input: unknown): Subject {
  if (typeof input === 'string') {
    const parsed = parseLine(input);
    if (parsed !== null) return fromRecord(parsed);
    return { value: tidy(input), kind: SubjectKind.None };
  }
  if (typeof input === 'object' && input !== null) {
    return fromRecord(input as Record<string, unknown>);
  }
  return NOTHING;
}

function fromRecord(input: Record<string, unknown>): Subject {
  for (const [key, kind] of SUBJECT_KEYS) {
    const value = input[key];
    if (typeof value === 'string' && value.length > 0) {
      return { value: tidy(value), kind };
    }
    if (Array.isArray(value) && value.length > 0) {
      const joined = value.filter((part) => typeof part === 'string').join(' ');
      if (joined.length > 0) return { value: tidy(joined), kind };
    }
  }
  const text = tidy(textOf(input));
  return text.length === 0 ? NOTHING : { value: text, kind: SubjectKind.None };
}

function tidy(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 400);
}

function scanFile(path: string, maxBytes: number): SessionData | null {
  const { lines, truncated } = readJsonlHead(path, maxBytes);
  if (lines.length === 0) return null;
  const pending = new Map<string, Pending>();
  const calls: ToolCall[] = [];
  let sessionId = '';
  let startedAt: Date | null = null;
  let index = 0;
  for (const line of lines) {
    const record = parseLine(line);
    if (record === null) continue;
    const payload = recordField(record, 'payload');
    if (payload === null) continue;
    if (stringField(record, 'type') === 'session_meta') {
      if (sessionId.length === 0) sessionId = stringField(payload, 'session_id');
      const stamp = stringField(payload, 'timestamp') || stringField(record, 'timestamp');
      if (stamp.length > 0) {
        const parsed = new Date(stamp);
        if (!Number.isNaN(parsed.getTime())) startedAt = parsed;
      }
      continue;
    }
    const type = stringField(payload, 'type');
    if (type === 'custom_tool_call' || type === 'function_call') {
      index += 1;
      pending.set(stringField(payload, 'call_id'), {
        name: stringField(payload, 'name'),
        subject: subjectOf(payload['input'] ?? payload['arguments']),
        index,
      });
      continue;
    }
    if (type !== 'custom_tool_call_output' && type !== 'function_call_output') continue;
    const id = stringField(payload, 'call_id');
    const asked = pending.get(id);
    pending.delete(id);
    const verdict = readCodexOutput(payload['output']);
    const text = verdict.failed ? verdict.reason : textOf(payload['output'], 4096);
    const failed = verdict.failed || SAYS_ERROR.test(text.slice(0, 200));
    if (!failed) continue;
    const name = asked?.name ?? 'unknown';
    calls.push({
      name,
      id,
      subject: asked?.subject.value ?? '',
      subjectKind: asked?.subject.kind ?? SubjectKind.None,
      failed: true,
      category: classifyFailure(name, text),
      detail: failureDetail(text),
      outputBytes: text.length,
      index: asked?.index ?? index,
    });
  }
  const fallbackId = path.replace(/\\/g, '/').split('/').pop() ?? path;
  return {
    sessionId: sessionId.length > 0 ? sessionId : fallbackId.replace(/\.jsonl$/, ''),
    agent: BuiltInAgent.Codex,
    calls,
    totalCalls: index,
    startedAt,
    truncated,
  };
}

/** The working directory a rollout recorded. */
function cwdOf(path: string): string | null {
  try {
    const { lines } = readJsonlHead(path, 256 * 1024);
    for (const line of lines) {
      const record = parseLine(line);
      if (record === null) continue;
      const payload = recordField(record, 'payload');
      if (payload === null) continue;
      const cwd = stringField(payload, 'cwd');
      if (cwd.length > 0) return cwd;
    }
  } catch {
    // Unknown, and reported as unknown.
  }
  return null;
}

/**
 * Codex projects.
 *
 * Codex files sessions by DATE, not by project, so a project is not a directory
 * here -- it is a working directory several sessions happen to share, and the only
 * way to learn it is to read each session's head. That costs one small read per
 * session file, which is why this is the one place a bound on how far back to look
 * changes what discovery costs.
 */
function discover(limit: number): readonly ProjectInfo[] {
  const root = sessionsRoot();
  if (!existsSync(root)) return [];
  const counts = new Map<string, number>();
  for (const file of sessionFiles(root).slice(0, limit)) {
    const key = cwdOf(file.path) ?? '';
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()].map(([path, count]) => ({
    name: path.length === 0 ? 'unknown working directory' : path,
    projectPath: path.length === 0 ? null : path,
    dataPath: root,
    sessionCount: count,
  }));
}

/** How many session files discovery reads before it stops looking for projects. */
const DISCOVERY_LIMIT = 200;

export const codexPlugin: AgentPlugin = {
  name: BuiltInAgent.Codex,
  displayName: 'Codex',

  detect(): boolean {
    return existsSync(sessionsRoot());
  },

  discoverProjects(): readonly ProjectInfo[] {
    return discover(DISCOVERY_LIMIT);
  },

  scanProject(project: ProjectInfo, options: ScanOptions = {}): readonly SessionData[] {
    const maxBytes = options.maxBytesPerSession ?? DEFAULT_MAX_BYTES;
    const sessions: SessionData[] = [];
    const files = sessionFiles(sessionsRoot());
    const limit = options.maxSessions ?? files.length;
    for (const file of files) {
      if (sessions.length >= limit) break;
      if (options.since !== undefined && file.mtime < options.since.getTime()) continue;
      // The project IS a working directory here, so a session that ran elsewhere
      // belongs to a different project even though it sits in the same tree.
      if (project.projectPath !== null && cwdOf(file.path) !== project.projectPath) {
        continue;
      }
      try {
        const session = scanFile(file.path, maxBytes);
        if (session !== null) sessions.push(session);
      } catch {
        // One unreadable rollout, not the whole pass -- but a named loss.
        options.onUnreadable?.(file.path);
      }
    }
    return sessions;
  },

  contextTarget(): ContextTarget {
    return { contextFile: 'AGENTS.md', memoryFile: null };
  },
};