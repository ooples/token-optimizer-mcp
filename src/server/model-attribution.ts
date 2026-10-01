/**
 * WHICH MODEL WAS ON THE OTHER END, resolved from evidence rather than hope.
 *
 * THE DEFECT THIS REPLACES. `McpEvidenceRecorder.analyticsAttribution` used to
 * read the model from `process.env.TOKEN_OPTIMIZER_MODEL` and nothing else --
 * a variable this package never sets, never documents and no client exports.
 * So every analytics row recorded `model: null`, and a live ledger read:
 *
 *     (unattributed)   5,440,720 tokens  3,884 ops  not priced
 *     claude-sonnet        27,134 tokens      3 ops  not priced
 *
 * 3,884 of 3,895 verified-savings operations had no model, which meant 98.9% of
 * every token we could prove we saved could not be priced, and the dollar
 * figure the product reports was computed from five rows. The pricing catalog
 * was never the problem; the attribution was never wired.
 *
 * WHY NOT INFER IT. The tempting fix is to guess -- the client's name implies a
 * vendor, the vendor has a flagship, call it that. That would put a fabricated
 * model id underneath a priced figure inside a provenance-gated report, which
 * is the one thing every other measurement in this package refuses to do. A
 * guessed model is worse than no model: `(unattributed)` is visibly missing,
 * whereas a wrong model prices silently and wrongly.
 *
 * SO IT IS READ FROM THE CLIENT'S OWN LOG. Both agents we have a plugin for
 * already write the exact model id to disk for every turn -- Claude Code as
 * `message.model` on each assistant record in its session transcript, Codex as
 * `payload.model` in its rollout's session meta. Those are exact catalog ids
 * (`claude-opus-5`, not "opus"), written by the client itself, and they are
 * already on the machine. Reading them is observation, not inference.
 *
 * PRIVACY. The transcript is conversation content. This module reads a bounded
 * window of it, extracts one field, and returns a model id. No other field is
 * read, nothing is retained past the call, and nothing is logged -- the only
 * value that leaves is a model id or null. The window is parsed as JSON lines
 * and the id is taken from a parsed record, never matched out of the raw text:
 * a transcript routinely CONTAINS the string `"model": "..."` inside quoted
 * tool output and pasted code, and a regex over the buffer would happily
 * attribute a saving to a model id someone mentioned in a message.
 *
 * COST. Resolution is a tail read, not a scan: the newest records are at the
 * end of the file, so the window starts at 64KB and grows only if that window
 * held no assistant turn. Measured on a 199MB live transcript: 1ms at 64KB,
 * 1ms at 1MB, 14ms at 8MB, and the answer came from the first window. The
 * result is then cached for a few seconds so a burst of tool calls reads once.
 */

/**
 * ASYNC THROUGHOUT, against the temptation to reach for the sync calls this
 * kind of lookup usually gets written with. It sits on the path of every
 * recorded tool result, and a 12ms blocking read there stalls an MCP server
 * that is answering other calls; every caller is already async, so there was
 * nothing to pay for it.
 */
import { open, readdir, stat, access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isValidSessionId } from '../utils/session-id.js';

/**
 * WHERE A MODEL ID CAME FROM, recorded alongside it.
 *
 * A priced figure is only as good as its model id, so a reviewer has to be able
 * to tell a value the operator declared from one we observed in a log from one
 * we never found. Without this the three are indistinguishable in the ledger
 * and the first question asked of any surprising dollar figure -- "where did
 * that model come from?" -- has no answer.
 */
export const MODEL_SOURCES = Object.freeze({
  /** The operator set TOKEN_OPTIMIZER_MODEL. A stated answer beats an observed one. */
  Declared: 'declared',
  /** Read from `message.model` on the newest assistant turn of the session transcript. */
  ClaudeCodeTranscript: 'claude-code-transcript',
  /** Read from `payload.model` in the session meta of the Codex rollout. */
  CodexRollout: 'codex-rollout',
  /** No source produced one. The row stays unattributed, and says why. */
  None: 'none',
} as const);

export type ModelSource = (typeof MODEL_SOURCES)[keyof typeof MODEL_SOURCES];

export interface ModelAttribution {
  readonly model: string | null;
  readonly source: ModelSource;
}

/** Nothing found, and the reason is that nothing was found. */
const UNATTRIBUTED: ModelAttribution = { model: null, source: MODEL_SOURCES.None };

/**
 * GROWING WINDOWS, not one big read. The last record of a transcript is the
 * newest, so the first window almost always answers; the larger ones exist for
 * the case where a single enormous tool result sits between the end of the file
 * and the most recent assistant turn.
 */
const TAIL_WINDOWS = Object.freeze([65_536, 1_048_576, 8_388_608]);

/**
 * A model can change mid-session -- an operator switches, and from that point
 * the savings belong to a different price. So this is a short cache rather than
 * a once-per-process resolution: long enough that a burst of tool calls reads
 * the file once, short enough that a switch is picked up in the same minute.
 */
const CACHE_TTL_MS = 5_000;

/**
 * `<synthetic>` is Claude Code's marker for a record it generated itself rather
 * than one a model produced. It is not a model, it is not in any catalog, and
 * attributing a saving to it would be attributing it to the client's own
 * bookkeeping.
 */
const SYNTHETIC = '<synthetic>';

/**
 * Read the last `bytes` of a file as complete JSON lines, newest first.
 *
 * THE FIRST LINE OF A TAIL WINDOW IS DISCARDED unless the window covers the
 * whole file, because a window that starts mid-record begins with a fragment.
 * Parsing would reject it anyway, but a fragment that happened to remain valid
 * JSON would be a record with its beginning missing, which is worse than no
 * record at all.
 */
async function tailLines(path: string, bytes: number): Promise<readonly string[]> {
  let size: number;
  try {
    size = (await stat(path)).size;
  } catch {
    return [];
  }
  if (size === 0) return [];
  const length = Math.min(bytes, size);
  const start = size - length;
  const buffer = Buffer.alloc(length);
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(path, 'r');
    await handle.read(buffer, 0, length, start);
  } catch {
    return [];
  } finally {
    if (handle !== null) {
      try {
        await handle.close();
      } catch {
        // A handle we can no longer close is not a reason to lose the read.
      }
    }
  }
  let text = buffer.toString('utf8');
  if (start > 0) {
    const newline = text.indexOf('\n');
    text = newline < 0 ? '' : text.slice(newline + 1);
  }
  return text.split('\n').reverse();
}

/**
 * Pull one string field out of JSON-line records, newest first.
 *
 * PARSED, NEVER MATCHED. `pick` is handed a parsed record, so a model id quoted
 * inside a message body or a pasted config cannot be mistaken for the model
 * that produced the turn. Unparseable lines are skipped rather than failing the
 * read: a transcript being appended to while we read it will have a torn last
 * line, and that is the normal case, not an error.
 */
function fromJsonLines(
  lines: readonly string[],
  pick: (record: Record<string, unknown>) => unknown
): string | null {
  for (const line of lines) {
    if (!line) continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (!record || typeof record !== 'object') continue;
    const value = pick(record as Record<string, unknown>);
    if (typeof value === 'string' && value.length > 0 && value !== SYNTHETIC) {
      return value;
    }
  }
  return null;
}

/** Agent home, overridable the same way the `learn` plugins allow. */
function agentHome(variable: string): string {
  const override = process.env[variable];
  return override !== undefined && override.length > 0 ? override : homedir();
}

/**
 * Session ids worth trying, in order of how directly the client stated them.
 *
 * EXISTENCE IS THE VERIFICATION. `TOKEN_OPTIMIZER_SESSION_ID` is set by our own
 * hooks as well as by clients, so it is not necessarily the agent's own session
 * id -- but an id that resolves to a transcript file named after it is the
 * agent's session id by construction, and one that does not resolve is skipped.
 * That is why candidates are tried against the filesystem rather than ranked.
 *
 * Every candidate passes `isValidSessionId` first: these values are
 * concatenated into a path, and that allowlist is the guard that stops
 * `../../..` from turning an attribution lookup into an arbitrary file read.
 */
function sessionCandidates(primary: string): readonly string[] {
  const raw = [process.env[primary], process.env.TOKEN_OPTIMIZER_SESSION_ID];
  const seen = new Set<string>();
  for (const value of raw) {
    const trimmed = (value || '').trim();
    if (isValidSessionId(trimmed)) seen.add(trimmed);
  }
  return [...seen];
}

/** `~/.claude/projects/<project>/<session>.jsonl`, whichever project holds it. */
async function claudeTranscript(): Promise<string | null> {
  const root = join(agentHome('TOKEN_OPTIMIZER_CLAUDE_HOME'), '.claude', 'projects');
  let projects: readonly string[];
  try {
    projects = (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return null;
  }
  for (const session of sessionCandidates('CLAUDE_CODE_SESSION_ID')) {
    for (const project of projects) {
      const path = join(root, project, `${session}.jsonl`);
      try {
        await access(path);
        return path;
      } catch {
        // Not this project's transcript; try the next.
      }
    }
  }
  return null;
}

/**
 * How many day-directories of Codex rollouts to look through.
 *
 * A rollout is filed under `sessions/YYYY/MM/DD/`, and the session we are
 * attributing is the one this very process belongs to -- so it is today's, or
 * yesterday's if the process has been up across midnight. Three is slack, not a
 * search: widening this into a walk of the whole tree would turn a per-call
 * lookup into thousands of stats to find a file we either own or do not.
 */
const CODEX_DAYS = 3;

/** The newest `limit` leaf directories of a `YYYY/MM/DD` tree, newest first. */
async function newestDatedDirs(
  root: string,
  depth: number,
  limit: number
): Promise<readonly string[]> {
  let level: string[] = [root];
  for (let step = 0; step < depth; step += 1) {
    const next: string[] = [];
    for (const dir of level) {
      let names: string[];
      try {
        names = (await readdir(dir, { withFileTypes: true }))
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name)
          // Zero-padded date components sort lexicographically the same way
          // they sort chronologically, which is the whole reason this tree can
          // be walked newest-first without stat-ing anything.
          .sort((a, b) => b.localeCompare(a));
      } catch {
        continue;
      }
      for (const name of names) next.push(join(dir, name));
      if (next.length >= limit) break;
    }
    level = next.slice(0, limit);
    if (level.length === 0) return [];
  }
  return level;
}

/** `~/.codex/sessions/YYYY/MM/DD/rollout-<timestamp>-<session>.jsonl`. */
async function codexRollout(): Promise<string | null> {
  const root = join(agentHome('TOKEN_OPTIMIZER_CODEX_HOME'), '.codex', 'sessions');
  const sessions = sessionCandidates('CODEX_SESSION_ID');
  if (sessions.length === 0) return null;
  for (const dir of await newestDatedDirs(root, 3, CODEX_DAYS)) {
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      continue;
    }
    for (const session of sessions) {
      // MATCHED ON THE FULL SUFFIX, never a substring: the session id is the
      // tail of the filename, and `includes` would let a different session
      // whose id merely contained this one answer for it.
      const suffix = `-${session}.jsonl`;
      const hit = names.find((name) => name.endsWith(suffix));
      if (hit) return join(dir, hit);
    }
  }
  return null;
}

/** Grow the tail window until an assistant turn is in it, or give up. */
async function fromTail(
  path: string,
  pick: (record: Record<string, unknown>) => unknown
): Promise<string | null> {
  for (const window of TAIL_WINDOWS) {
    const found = fromJsonLines(await tailLines(path, window), pick);
    if (found !== null) return found;
  }
  return null;
}

/** `message.model` on a Claude Code transcript record. */
function claudeModel(record: Record<string, unknown>): unknown {
  const message = record.message;
  if (!message || typeof message !== 'object') return null;
  return (message as Record<string, unknown>).model;
}

/** `payload.model` on a Codex rollout record. */
function codexModel(record: Record<string, unknown>): unknown {
  const payload = record.payload;
  if (!payload || typeof payload !== 'object') return null;
  return (payload as Record<string, unknown>).model;
}

/**
 * Resolve the model behind the current session, uncached.
 *
 * ORDERED BY HOW DIRECTLY THE ANSWER WAS STATED, and it stops at the first
 * source that produces one. A declared value wins because an operator who sets
 * it has overridden us on purpose -- including the case where they are routing
 * a client through a model its own log would not name.
 *
 * Both logs are then consulted regardless of which client connected, because
 * the client name is not a reliable discriminator (a wrapper, a proxy or a
 * relaunch can all present something else) and a transcript named after this
 * process's own session id is proof enough on its own.
 */
export async function resolveModelUncached(): Promise<ModelAttribution> {
  const declared = (process.env.TOKEN_OPTIMIZER_MODEL || '').trim();
  if (declared) return { model: declared, source: MODEL_SOURCES.Declared };

  const transcript = await claudeTranscript();
  if (transcript) {
    const model = await fromTail(transcript, claudeModel);
    if (model) return { model, source: MODEL_SOURCES.ClaudeCodeTranscript };
  }

  const rollout = await codexRollout();
  if (rollout) {
    const model = await fromTail(rollout, codexModel);
    if (model) return { model, source: MODEL_SOURCES.CodexRollout };
  }

  return UNATTRIBUTED;
}

let cache: { at: number; value: ModelAttribution } | null = null;

/**
 * Resolve the model behind the current session.
 *
 * NEVER THROWS, because this sits on the path of every recorded tool result and
 * an attribution failure must cost a model id, not the measurement it was going
 * to label.
 */
export async function resolveModel(
  now: number = Date.now()
): Promise<ModelAttribution> {
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.value;
  let value: ModelAttribution;
  try {
    value = await resolveModelUncached();
  } catch {
    value = UNATTRIBUTED;
  }
  cache = { at: now, value };
  return value;
}

/** Drop the cached attribution. For tests, and for a deliberate re-read. */
export function resetModelAttributionCache(): void {
  cache = null;
}
