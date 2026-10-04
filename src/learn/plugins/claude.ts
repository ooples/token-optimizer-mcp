/**
 * Claude Code's transcripts.
 *
 * ~/.claude/projects/<encoded project path>/<session id>.jsonl, one JSON object
 * per line. A tool call is an `assistant` entry carrying a `tool_use` block; its
 * result is a later `user` entry carrying a `tool_result` block with the same id
 * and an `is_error` flag. That flag is the whole reason this format is worth
 * reading offline: the agent already told us which calls failed, so nothing here
 * has to guess at it from wording.
 *
 * The project directory name is the working directory with its separators
 * replaced, which is ambiguous to decode -- a dash could have been a dash. So the
 * path is read from the `cwd` field a transcript records instead, and the encoded
 * name is only a fallback for a file that has none.
 */

import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { classifyFailure, failureDetail } from '../classify.js';
import { SubjectKind, ProjectInfo, SessionData, ToolCall } from '../models.js';
import {
  AgentPlugin,
  ContextTarget,
  ScanOptions,
  directoryExists,
} from '../plugin.js';
import { BuiltInAgent } from '../plugin.js';
import {
  DEFAULT_MAX_BYTES,
  parseLine,
  readJsonlHead,
  recordField,
  stringField,
  textOf,
} from './jsonl.js';

function projectsRoot(): string {
  const override = process.env.TOKEN_OPTIMIZER_CLAUDE_HOME;
  const home =
    override !== undefined && override.length > 0 ? override : homedir();
  return join(home, '.claude', 'projects');
}

/** The field each tool puts its subject in, and what that field holds. */
const SUBJECT_KEYS: readonly (readonly [string, SubjectKind])[] = [
  ['file_path', SubjectKind.Path],
  ['path', SubjectKind.Path],
  ['notebook_path', SubjectKind.Path],
  ['command', SubjectKind.Command],
  ['pattern', SubjectKind.Pattern],
  ['query', SubjectKind.Pattern],
  ['url', SubjectKind.Url],
];

interface Subject {
  readonly value: string;
  readonly kind: SubjectKind;
}

function subjectOf(input: Record<string, unknown> | null): Subject {
  if (input === null) return { value: '', kind: SubjectKind.None };
  for (const [key, kind] of SUBJECT_KEYS) {
    const value = input[key];
    if (typeof value === 'string' && value.length > 0) {
      return { value: value.slice(0, 400), kind };
    }
  }
  return { value: '', kind: SubjectKind.None };
}

interface Pending {
  readonly name: string;
  readonly subject: Subject;
  readonly index: number;
}

async function sessionFiles(
  dir: string
): Promise<{ path: string; mtime: number }[]> {
  const files: { path: string; mtime: number }[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
    const path = join(dir, entry.name);
    try {
      files.push({ path, mtime: (await stat(path)).mtimeMs });
    } catch {
      // Gone between the listing and the stat. Nothing to read.
    }
  }
  return files.sort((a, b) => b.mtime - a.mtime);
}

async function scanFile(
  path: string,
  maxBytes: number
): Promise<SessionData | null> {
  const { lines, truncated } = await readJsonlHead(path, maxBytes);
  if (lines.length === 0) return null;
  const pending = new Map<string, Pending>();
  const calls: ToolCall[] = [];
  let startedAt: Date | null = null;
  let index = 0;
  for (const line of lines) {
    const record = parseLine(line);
    if (record === null) continue;
    if (startedAt === null) {
      const stamp = stringField(record, 'timestamp');
      if (stamp.length > 0) {
        const parsed = new Date(stamp);
        if (!Number.isNaN(parsed.getTime())) startedAt = parsed;
      }
    }
    const message = recordField(record, 'message');
    if (message === null) continue;
    const content = message['content'];
    if (!Array.isArray(content)) continue;
    for (const raw of content) {
      if (typeof raw !== 'object' || raw === null) continue;
      const block = raw as Record<string, unknown>;
      const type = stringField(block, 'type');
      if (type === 'tool_use') {
        index += 1;
        pending.set(stringField(block, 'id'), {
          name: stringField(block, 'name'),
          subject: subjectOf(recordField(block, 'input')),
          index,
        });
        continue;
      }
      if (type !== 'tool_result') continue;
      const id = stringField(block, 'tool_use_id');
      const asked = pending.get(id);
      pending.delete(id);
      const failed = block['is_error'] === true;
      if (!failed) continue;
      const output = textOf(block['content']);
      calls.push({
        name: asked?.name ?? 'unknown',
        id,
        subject: asked?.subject.value ?? '',
        subjectKind: asked?.subject.kind ?? SubjectKind.None,
        failed: true,
        category: classifyFailure(asked?.name ?? '', output),
        detail: failureDetail(output),
        outputBytes: output.length,
        index: asked?.index ?? index,
      });
    }
  }
  return {
    sessionId:
      path
        .replace(/\\/g, '/')
        .split('/')
        .pop()
        ?.replace(/\.jsonl$/, '') ?? path,
    agent: BuiltInAgent.Claude,
    calls,
    totalCalls: index,
    startedAt,
    truncated,
  };
}

export const claudePlugin: AgentPlugin = {
  name: BuiltInAgent.Claude,
  displayName: 'Claude Code',

  detect(): Promise<boolean> {
    return directoryExists(projectsRoot());
  },

  async discoverProjects(): Promise<readonly ProjectInfo[]> {
    const root = projectsRoot();
    if (!(await directoryExists(root))) return [];
    const projects: ProjectInfo[] = [];
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = join(root, entry.name);
      const files = await sessionFiles(dir);
      if (files.length === 0) continue;
      projects.push({
        name: entry.name,
        projectPath: await cwdOf(files[0]?.path ?? ''),
        dataPath: dir,
        sessionCount: files.length,
      });
    }
    return projects;
  },

  async scanProject(
    project: ProjectInfo,
    options: ScanOptions = {}
  ): Promise<readonly SessionData[]> {
    const maxBytes = options.maxBytesPerSession ?? DEFAULT_MAX_BYTES;
    const sessions: SessionData[] = [];
    const files = await sessionFiles(project.dataPath);
    const limit = options.maxSessions ?? files.length;
    for (const file of files) {
      if (sessions.length >= limit) break;
      if (options.since !== undefined && file.mtime < options.since.getTime())
        continue;
      try {
        const session = await scanFile(file.path, maxBytes);
        if (session !== null) sessions.push(session);
      } catch {
        // One unreadable transcript is not a reason to learn nothing from the
        // other two hundred, but the caller is told which one it lost.
        options.onUnreadable?.(file.path);
      }
    }
    return sessions;
  },

  contextTarget(): ContextTarget {
    return { contextFile: 'CLAUDE.md', memoryFile: 'MEMORY.md' };
  },
};

/** The working directory a transcript recorded, read from its first entries. */
async function cwdOf(path: string): Promise<string | null> {
  if (path.length === 0) return null;
  try {
    const { lines } = await readJsonlHead(path, 64 * 1024);
    for (const line of lines) {
      const record = parseLine(line);
      if (record === null) continue;
      const cwd = stringField(record, 'cwd');
      if (cwd.length > 0) return cwd;
    }
  } catch {
    // An unreadable head means we do not know where it ran. The encoded
    // directory name is still reported as the project's name.
  }
  return null;
}
