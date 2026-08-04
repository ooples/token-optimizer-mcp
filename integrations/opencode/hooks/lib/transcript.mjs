// GENERATED FILE -- do not edit.
// Source of truth: hooks-core/transcript.mjs. Regenerate with `npm run sync:hooks`.
/**
 * The raw local archive of what was asked and what was answered.
 *
 * THE ARCHIVE AND THE LESSONS ARE DIFFERENT THINGS, and keeping them separate
 * is the whole design. The archive is complete and never retrieved; the lessons
 * extracted from it are sparse and are the only thing ever injected. Storing
 * everything AND retrieving everything would drown the graph -- a session is
 * thousands of turns of ordinary work and a handful of moments that taught
 * something. Storing everything and retrieving only the lessons keeps the record
 * complete without diluting what gets served.
 *
 * NOTHING HERE LEAVES THE MACHINE. The archive is written inside the wiki
 * directory, which already carries a `.gitignore` of `*`, and it is explicitly
 * excluded from the harvest digest -- the one code path that sends anything to a
 * model endpoint. A feedback loop must never become the reason a user's prompts
 * are transmitted.
 */

import {
  readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync, readdirSync, statSync, unlinkSync,
} from 'node:fs';
import { join } from 'node:path';

/** Where a project's transcripts live, under the graph it belongs to. */
export const transcriptDir = (dir) => join(dir, 'transcripts');

/**
 * Total bytes of archive kept per project before the oldest are dropped.
 *
 * An unbounded archive of every session is a disk leak that grows fastest for
 * the users who use the tool most, which is exactly backwards.
 */
const archiveBudget = () =>
  Number(process.env.TOKEN_OPTIMIZER_TRANSCRIPT_BUDGET_BYTES) || 50 * 1024 * 1024;

/** A session id reduced to something that cannot escape the archive directory. */
export function safeName(sessionId) {
  const safe = String(sessionId || 'unknown').replace(/[^A-Za-z0-9._-]/g, '_');
  return (/^[.]+$/.test(safe) ? 'unknown' : safe).slice(0, 64);
}

/**
 * Turns a Claude transcript into the prompt/response pairs worth keeping.
 *
 * TOOL RESULTS ARE DROPPED, for the same reason `buildDigest` drops them: that
 * is where whole file contents would enter the record. The archive is meant to
 * hold the conversation, not a second copy of the repository.
 */
export function readTurns(transcriptPath) {
  let lines;
  try {
    lines = readFileSync(transcriptPath, 'utf8').split('\n');
  } catch {
    return [];
  }

  const turns = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    const message = entry.message || entry;
    const role = message.role || entry.type;
    const content = message.content;

    if (role === 'user') {
      const text =
        typeof content === 'string'
          ? content
          : Array.isArray(content)
            ? content
                .filter((b) => b && b.type === 'text')
                .map((b) => String(b.text))
                .join('\n')
            : '';
      if (text.trim()) turns.push({ role: 'user', text: text.trim(), at: entry.timestamp ?? null });
      continue;
    }

    if (role === 'assistant' && Array.isArray(content)) {
      const text = content
        .filter((b) => b && b.type === 'text')
        .map((b) => String(b.text))
        .join('\n');
      const tools = content
        .filter((b) => b && b.type === 'tool_use')
        .map((b) => ({
          name: b.name,
          // Arguments only, never results, and truncated: a command is the
          // useful part, its output is not.
          command: b.input?.command ? String(b.input.command).slice(0, 300) : undefined,
          path: b.input?.file_path || b.input?.path || undefined,
        }));
      if (text.trim() || tools.length) {
        turns.push({ role: 'assistant', text: text.trim(), tools, at: entry.timestamp ?? null });
      }
    }
  }
  return turns;
}

/**
 * Appends this session's turns to the project archive.
 *
 * Idempotent per session by rewriting that session's file, so a Stop hook firing
 * repeatedly does not multiply the record.
 */
export function archive(dir, transcriptPath, { sessionId } = {}) {
  const turns = readTurns(transcriptPath);
  if (!turns.length) return 0;

  const root = transcriptDir(dir);
  try {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    try {
      chmodSync(root, 0o700);
    } catch {
      /* not POSIX, or not ours */
    }
  } catch {
    return 0;
  }

  const file = join(root, `${safeName(sessionId)}.jsonl`);
  try {
    // Truncate-and-write rather than append: Stop fires many times per session
    // and the transcript is cumulative, so appending would store the early turns
    // once per firing.
    const payload = turns.map((t) => JSON.stringify(t)).join('\n') + '\n';
    writeFileSync(file, payload, { mode: 0o600 });
  } catch {
    return 0;
  }

  prune(root);
  return turns.length;
}

/**
 * Drops the oldest sessions once the archive exceeds its budget.
 *
 * Oldest-first, because the value of a transcript is highest while the work it
 * describes is still live.
 */
export function prune(root, budget = archiveBudget()) {
  let entries;
  try {
    entries = readdirSync(root)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => {
        const full = join(root, f);
        try {
          const s = statSync(full);
          return { full, size: s.size, mtime: s.mtimeMs };
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return 0;
  }

  let total = entries.reduce((a, e) => a + e.size, 0);
  if (total <= budget) return 0;

  entries.sort((a, b) => a.mtime - b.mtime);
  let dropped = 0;
  for (const e of entries) {
    if (total <= budget) break;
    try {
      unlinkSync(e.full);
      total -= e.size;
      dropped += 1;
    } catch {
      /* leave it; a locked file must not stop the rest */
    }
  }
  return dropped;
}

/** True when a path is inside a transcript archive -- the never-transmit test. */
export function isArchived(path) {
  return /[\\/]\.token-optimizer[\\/]wiki[\\/]transcripts[\\/]/.test(String(path));
}

/** Reads a session's archived turns back, for the lesson extractor. */
export function readArchive(dir, sessionId) {
  const file = join(transcriptDir(dir), `${safeName(sessionId)}.jsonl`);
  if (!existsSync(file)) return [];
  try {
    return readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}
