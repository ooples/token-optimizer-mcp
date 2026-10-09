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
  readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync, readdirSync, statSync,
  unlinkSync, openSync, readSync, closeSync, appendFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { redact } from './redact.mjs';
import { isToolAbsentMessage } from './capabilities.mjs';

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
  try {
    return turnsFromLines(readFileSync(transcriptPath, 'utf8').split('\n'));
  } catch {
    return [];
  }
}

/** The turns in a run of transcript lines; each line stands on its own. */
function turnsFromLines(lines) {
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
 * INCREMENTAL, because Stop fires on every turn and the transcript only grows.
 * Rebuilding the archive from the whole transcript each time made every Stop cost
 * O(transcript): measured on a 45.6 MB session transcript, 1.0-1.1 s per Stop, 76%
 * of it in this function, and the plugin's own hook log shows Stop at p50 997 ms
 * and a maximum of 130 s over 610 calls (issue #473, defect 9). A sidecar records
 * how many transcript bytes the archive already covers, and only the bytes after
 * that are parsed and appended.
 *
 * The result is byte-identical to a full rebuild, because a transcript is
 * append-only and every line is turned into turns on its own. Anything that
 * breaks that assumption -- a shorter transcript, a different path, a missing
 * archive or sidecar -- falls back to the full rebuild, which is what this
 * function always did.
 */
export function archive(dir, transcriptPath, { sessionId } = {}) {
  const root = transcriptDir(dir);
  const file = join(root, `${safeName(sessionId)}.jsonl`);
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

  // EVERYTHING BELOW HOLDS THE LOCK, the append AND the rebuild. Appending is
  // not idempotent the way the old rewrite was: two archivers that read the
  // same coverage both append the same turns (eight of them wrote 10.7 MB where
  // the rebuild is 2.1 MB). And a rebuild running beside an append either
  // duplicates turns or records coverage the archive does not hold -- which no
  // later call repairs, because the coverage still looks valid. So an archiver
  // that cannot take the lock does nothing: the holder covers everything up to
  // its end, and whatever arrives after it is covered by the next Stop.
  const lock = `${coveragePath(file)}.lock`;
  if (!takeArchiveLock(lock)) return 0;
  try {
    const appended = appendNewTurns(file, transcriptPath);
    if (appended !== null) return appended;

    // The end is fixed BEFORE reading: the client keeps appending, and coverage
    // recorded after a read would claim lines that arrived during it.
    const end = completeLinesEnd(transcriptPath);
    const turns = turnsBetween(transcriptPath, 0, end);
    if (!turns.length) return 0;
    try {
      // Truncate-and-write rather than append: the transcript is cumulative, so
      // appending the full set would store the early turns once per firing.
      const payload = turns.map((t) => JSON.stringify(t)).join('\n') + '\n';
      writeFileSync(file, payload, { mode: 0o600 });
      writeCoverage(file, transcriptPath, end);
    } catch {
      return 0;
    }
    prune(root);
    return turns.length;
  } finally {
    try {
      unlinkSync(lock);
    } catch {
      /* already gone */
    }
  }
}

/** A lock older than any archive takes is a crashed holder's. */
const ARCHIVE_LOCK_STALE_MS = 30_000;

/**
 * Takes the archive lock, or reports that someone else holds it.
 *
 * Every failure is "not taken", never "proceed without it": a holder that
 * released between our two calls, or a second process that also found the
 * lock stale and won the re-create, both mean another archiver is active.
 */
function takeArchiveLock(lock) {
  try {
    closeSync(openSync(lock, 'wx'));
    return true;
  } catch (error) {
    if (error?.code !== 'EEXIST') return false;
  }
  try {
    if (Date.now() - statSync(lock).mtimeMs < ARCHIVE_LOCK_STALE_MS) return false;
    unlinkSync(lock);
    closeSync(openSync(lock, 'wx'));
    return true;
  } catch {
    return false;
  }
}

/** Where the record of how much of the transcript an archive covers is kept. */
const coveragePath = (file) => file.replace(/\.jsonl$/, '.covered');

/**
 * The byte offset just past the transcript's last complete line.
 *
 * A Stop can fire while the client is mid-write, and a half-written last line
 * fails to parse -- the full rebuild drops it and picks it up next time. The
 * coverage must stop at the same place, or that line would never be read.
 */
function completeLinesEnd(transcriptPath) {
  let fd;
  try {
    const size = statSync(transcriptPath).size;
    fd = openSync(transcriptPath, 'r');
    const window = Buffer.alloc(Math.min(size, 1 << 16));
    for (let end = size; end > 0; ) {
      const start = Math.max(0, end - window.length);
      const length = end - start;
      readSync(fd, window, 0, length, start);
      const newline = window.subarray(0, length).lastIndexOf(10);
      if (newline >= 0) return start + newline + 1;
      end = start;
    }
    return 0;
  } catch {
    return 0;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* already closed */
      }
    }
  }
}

function writeCoverage(file, transcriptPath, offset) {
  writeFileSync(
    coveragePath(file),
    JSON.stringify({ transcript: String(transcriptPath), offset }),
    { mode: 0o600 }
  );
}

/**
 * Appends the turns in the transcript bytes the archive does not yet cover.
 * The caller holds the archive lock.
 *
 * Returns how many turns were appended, or null when the incremental path
 * cannot be trusted and the caller must rebuild.
 */
function appendNewTurns(file, transcriptPath) {
  try {
    if (!existsSync(file)) return null;
    const covered = JSON.parse(readFileSync(coveragePath(file), 'utf8'));
    if (covered?.transcript !== String(transcriptPath)) return null;
    const from = Number(covered.offset);
    const end = completeLinesEnd(transcriptPath);
    if (!Number.isInteger(from) || from < 0 || end < from) return null;
    if (end === from) return 0;

    const turns = turnsBetween(transcriptPath, from, end);
    if (turns.length) {
      appendFileSync(file, turns.map((t) => JSON.stringify(t)).join('\n') + '\n', {
        mode: 0o600,
      });
    }
    writeCoverage(file, transcriptPath, end);
    return turns.length;
  } catch {
    return null;
  }
}

/** The turns in transcript bytes [from, end), which must start and end on a line boundary. */
function turnsBetween(transcriptPath, from, end) {
  if (end <= from) return [];
  let fd;
  try {
    fd = openSync(transcriptPath, 'r');
    const buffer = Buffer.alloc(end - from);
    readSync(fd, buffer, 0, buffer.length, from);
    return turnsFromLines(buffer.toString('utf8').split('\n'));
  } catch {
    return [];
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* already closed */
      }
    }
  }
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
      try {
        unlinkSync(coveragePath(e.full));
      } catch {
        /* an archive written before coverage existed has none */
      }
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

/**
 * How much of a transcript's TAIL is scanned for failed tool results.
 *
 * A transcript is the largest file this project reads: the three real ones on
 * the measuring machine are 5.8 MB, 22 MB and 45 MB. `archive()` above already
 * reads the whole thing once at Stop, so an unbounded second pass doubles the
 * most expensive read on the session-end path for evidence that is, by
 * construction, mostly old. The tail is the right half to keep for the same
 * reason `buildFeedbackDigest` keeps the end: what a session learned is
 * concentrated where the work went wrong, which is later rather than sooner.
 */
const FAILED_SCAN_BYTES = () =>
  Number(process.env.TOKEN_OPTIMIZER_TRANSCRIPT_SCAN_BYTES) || 8 * 1024 * 1024;

/**
 * A much smaller tail for the absence scan, which runs on the HOT PATH.
 *
 * `failedResultsFromTranscript` reads 8 MB because it feeds a detector that
 * wants a session's whole failure history. This one answers a single question
 * -- has a call already come back "no such tool" -- whose answer is persisted
 * in session state the first time it is seen, so only the recent tail can ever
 * contain news. Eight megabytes of JSON parsed before every tool call to
 * re-learn a fact already on disk is a latency bill with no return.
 */
const ABSENCE_SCAN_BYTES = () =>
  Number(process.env.TOKEN_OPTIMIZER_TRANSCRIPT_ABSENCE_SCAN_BYTES) ||
  256 * 1024;

/** Failed results kept, most recent first. The pairing detector needs a handful. */
const FAILED_MAX = 50;

/** Same 4 KB cap `recordToolOutcome` applies to `output`, for the same reason. */
const FAILED_OUTPUT_MAX = 4096;

/**
 * The same 120-character truncation `recordToolOutcome` applies to `anchor`.
 *
 * ONE COMMAND MUST PRODUCE ONE KEY FROM EITHER SOURCE. A `tool-outcome` stores
 * the command as `String(tool_input.command).slice(0, 120)`, and `attemptKey`
 * reads up to three non-flag tokens off whatever it is handed. A long first
 * token -- a quoted grep pattern, an absolute Windows path, a heredoc -- is cut
 * by that cap INSIDE those three tokens, so the untruncated transcript copy of
 * the same command lands in a DIFFERENT group. Measured against one real
 * session's own evidence: 266 commands present in both sources, and truncating
 * here made 266 of 266 keys agree where the untruncated text agreed on only
 * 240.
 *
 * WHAT THAT ACTUALLY BUYS, stated precisely rather than generously. `derive`
 * refuses to build a claim out of a command at or over the cap at all (see
 * `quotable` there), so agreement on a TRUNCATED key never produces a finding
 * on its own. It buys two things that still matter: a transcript failure lands
 * in the same run as the event outcomes of the same command, so the
 * nearest-preceding-failure rule sees the real sequence rather than a sparse
 * one; and the no-call-id fallback in `derive`'s deduplication compares command
 * TEXT against an already-truncated anchor, which cannot match unless this side
 * is truncated identically.
 */
const ANCHOR_MAX = 120;

/**
 * A tool result that reports a command that RAN and exited non-zero.
 *
 * A POSITIVE ALLOWLIST, and the measurement is why. Claude Code sets
 * `is_error: true` on every kind of unhappy tool result, and across three real
 * transcripts 214 of them fell into four shapes:
 *
 *   83  `Exit code N` + stderr    -- a command ran and failed. THIS ONE.
 *   109 hook and policy denials   -- overwhelmingly THIS optimizer's own
 *                                    PreToolUse text ("Recursive shell searches
 *                                    return unbounded output. Call the
 *                                    token-optimizer MCP tool smart_grep
 *                                    instead"), plus `Remove-Item on system
 *                                    path` blocks.
 *   18  `<tool_use_error>...`     -- protocol errors: `String to replace not
 *                                    found`, `File has not been read yet`,
 *                                    `Blocked: ...`.
 *   4   a person declined the call.
 *
 * Only the first shape is a command failing. In every other shape THE COMMAND
 * NEVER RAN, so "`X` failed with: ..." would be a false claim about X, and a
 * later success would pair with a failure that never happened. The 109 are the
 * dangerous ones: ingesting them would have this tool derive findings from its
 * own advice, at 0.9 confidence, and serve them back as observations about the
 * project -- a self-referential loop that also inflates its own finding count.
 * That is the measurement-bias class this plan tracks, and a denylist would
 * have let every future denial string through by default.
 */
const EXIT_CODE_RESULT = /^(?:Error:\s*)?Exit code (\d+)\b/;

/**
 * A run the HARNESS stopped, which is not the command failing.
 *
 * The allowlist above admits anything shaped `Exit code N`, and a killed
 * command reports `Exit code 143` with `Command timed out after 2m 0s` -- so
 * it walks straight in. Nothing about it is a lesson about the command: it did
 * not fail, it was not allowed to finish, and the same command run with a
 * longer budget may well pass. Pairing one with a later success would claim a
 * red-to-green transition that never happened.
 *
 * MEASURED, on a 237 MB transcript of ordinary feature work: of 130 admitted
 * failures, 25 were timeouts -- 19%. At the 64 MB scan it was 11 of 23, 48%.
 * User declines are NOT in this class and need no rule; the positive allowlist
 * already excludes them, verified at every scan size on the same transcript.
 */
const HARNESS_TIMEOUT = /^\s*Command timed out after\b/m;

/** Reads at most `bytes` from the END of a file, without loading the rest. */
function readTail(path, bytes) {
  let fd;
  try {
    const size = statSync(path).size;
    const length = Math.min(size, bytes);
    if (!length) return '';
    fd = openSync(path, 'r');
    const buffer = Buffer.allocUnsafe(length);
    readSync(fd, buffer, 0, length, size - length);
    const text = buffer.toString('utf8');
    // A tail almost never starts on a line boundary, and half a JSON object is
    // not a parse failure worth reporting -- it is a partial record. Drop it.
    return length < size ? text.slice(text.indexOf('\n') + 1) : text;
  } catch {
    return '';
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* already gone */
      }
    }
  }
}

/**
 * The failed COMMAND results a transcript holds, which no hook event carries.
 *
 * WHY THIS READER EXISTS. Claude Code never fires PostToolUse for a failed tool
 * call: a deliberately failing command produced no event at all, and 2,238 of
 * 2,238 live `tool-outcome` events on the measuring machine carry
 * `success: true`. So `derive.mjs`'s two strongest detectors -- command
 * failed-then-succeeded at 0.90 and test/build red-to-green at 0.85 -- have no
 * input whatsoever on the primary client, while working normally on the ten
 * adapter clients. The failures exist; they exist only here.
 *
 * WHY NOT THE ARCHIVE, which the plan for this reader assumed. `readTurns`
 * DROPS tool results by design -- that is where whole file contents would enter
 * the record -- so `readArchive` returns no failure, ever, and an extractor over
 * archived turns would find nothing however well it was written. Making the
 * archive carry them would also push command stderr into `buildFeedbackDigest`,
 * which is the one code path in this project that sends anything to a model
 * endpoint. So this reads the transcript and STORES NOTHING NEW: read-only, no
 * capture path, no new event kind, and no widening of what leaves the machine.
 *
 * REDACTED HERE, at this boundary, exactly as `recordToolOutcome` redacts
 * `output`. Transcript text has never passed a redaction boundary -- that one
 * never saw it -- and everything returned from here is destined for a claim that
 * is injected into model context and exported to markdown.
 *
 * @returns {Array<{command: string, output: string, exit: number|null,
 *   at: number, toolCallId: string|null}>} in transcript order, so a caller can
 *   sort it beside `tool-outcome` events without re-ordering.
 */
export function failedResultsFromTranscript(transcriptPath, options = {}) {
  const { max = FAILED_MAX, scanBytes = FAILED_SCAN_BYTES() } = options || {};
  if (!transcriptPath) return [];
  const text = readTail(transcriptPath, scanBytes);
  if (!text) return [];

  // tool_use_id -> the command that was attempted. The join is EXACT and it is
  // the only one available: the result block carries no command of its own, and
  // the id is the same string `episodeMeta` reads into `toolCallId`, so the same
  // key also deduplicates against events on clients that do report failures.
  const commands = new Map();
  const failures = [];

  for (const line of text.split('\n')) {
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
    if (!Array.isArray(content)) continue;

    if (role === 'assistant') {
      for (const block of content) {
        if (!block || block.type !== 'tool_use' || !block.id) continue;
        const command = block.input?.command;
        if (typeof command !== 'string' || !command.trim()) continue;
        commands.set(String(block.id), command.slice(0, ANCHOR_MAX));
      }
      continue;
    }

    if (role !== 'user') continue;
    for (const block of content) {
      if (!block || block.type !== 'tool_result' || block.is_error !== true) continue;
      // Only a STRING result can be an exit-code report; every failed Claude
      // Code result observed was one, and a structured body is a shape this
      // classifier has not measured, so it is refused rather than guessed at.
      if (typeof block.content !== 'string') continue;
      const match = EXIT_CODE_RESULT.exec(block.content);
      if (!match) continue;
      // The command ran, but the harness ended it. See HARNESS_TIMEOUT.
      if (HARNESS_TIMEOUT.test(block.content)) continue;
      const command = commands.get(String(block.tool_use_id || ''));
      // No command means no claim. The result says something failed; without
      // the text of what failed there is nothing to say about it, and nothing
      // to group it with.
      if (!command) continue;
      failures.push({
        command,
        // The exit line itself is stripped: `exit` carries it structurally, and
        // leaving it in makes every failure claim read "failed with: Exit code 1".
        output: redact(block.content.slice(match[0].length).trim(), {
          max: FAILED_OUTPUT_MAX,
        }),
        exit: Number(match[1]),
        at: Date.parse(entry.timestamp || '') || 0,
        toolCallId: block.tool_use_id ? String(block.tool_use_id) : null,
      });
    }
  }

  // The MOST RECENT `max`, keeping chronological order. A session that failed
  // two hundred times teaches its last lessons, not its first.
  return failures.slice(-max);
}

/**
 * The optimizer MCP tools a call in this session proved do NOT exist.
 *
 * WHY THIS READER EXISTS, and why the post-tool event cannot do the job: the
 * header above `failedResultsFromTranscript` records the measurement -- Claude
 * Code fires no PostToolUse for a failed tool call, 2,238 of 2,238 live events
 * carried `success: true`. A call to a tool the host never registered is the
 * most complete failure there is, so on the primary client it produces no hook
 * event at all. The transcript is the only place it exists.
 *
 * That is exactly the gap behind #469. The hooks advertised 19 optimizer tools
 * on an install-time default, the host had registered none of them, every call
 * came back "No such tool available", and nothing in the hook pipeline could
 * ever learn it -- so the next hook recommended the same tool again, and the
 * Stop hook went on blocking the turn on a `wiki_write` that could not be
 * called.
 *
 * RETURNS NAMES AND NOTHING ELSE. The classifier runs here, against text that
 * stays in this function, and what comes back is a list of tool names drawn
 * from the assistant's own `tool_use` blocks. No transcript text, no tool
 * input, no result body and no path is returned, stored or logged, so this adds
 * nothing to what the archive already holds and crosses no disclosure boundary.
 *
 * @returns {Array<{name: string, at: number}>} raw tool names with the instant
 *   the refusal was recorded, deduplicated to the LATEST refusal per name, in
 *   first-seen order. `at` is 0 when the entry carries no parsable timestamp.
 */
export function absentToolsFromTranscript(transcriptPath, options = {}) {
  const { scanBytes = ABSENCE_SCAN_BYTES() } = options || {};
  if (!transcriptPath) return [];
  const text = readTail(transcriptPath, scanBytes);
  if (!text) return [];

  // tool_use_id -> the NAME that was attempted. Same exact join as the failure
  // reader: a result block carries no name of its own, only the id.
  const attempted = new Map();
  const absent = new Map();

  for (const line of text.split('\n')) {
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
    if (!Array.isArray(content)) continue;

    if (role === 'assistant') {
      for (const block of content) {
        if (!block || block.type !== 'tool_use' || !block.id) continue;
        if (typeof block.name !== 'string' || !block.name) continue;
        attempted.set(String(block.id), block.name);
      }
      continue;
    }

    if (role !== 'user') continue;
    for (const block of content) {
      if (!block || block.type !== 'tool_result' || block.is_error !== true)
        continue;
      const name = attempted.get(String(block.tool_use_id || ''));
      if (!name) continue;
      // A structured body is accepted here, unlike in the exit-code reader: a
      // host that reports "no such tool" as an MCP content block is reporting
      // the same fact, and the test below is a fixed phrase match rather than
      // a parse of the body's shape.
      const body =
        typeof block.content === 'string'
          ? block.content
          : Array.isArray(block.content)
            ? block.content
                .map((part) => (typeof part?.text === 'string' ? part.text : ''))
                .join('\n')
            : '';
      if (!isToolAbsentMessage(body)) continue;
      // THE INSTANT MATTERS, not just the name: a user who repairs an install
      // mid-session produces a later successful call, and the consumer decides
      // between the two by which came last. Without this the first failure in
      // a transcript would suppress the tool for the rest of the session.
      const at = Date.parse(entry.timestamp || '') || 0;
      absent.set(name, Math.max(absent.get(name) || 0, at));
    }
  }

  return [...absent].map(([name, at]) => ({ name, at }));
}
