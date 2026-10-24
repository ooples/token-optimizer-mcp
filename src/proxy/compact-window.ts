/**
 * Compacting the main session at ~400k tokens instead of ~967k.
 *
 * THE COST. Every call re-reads the whole context, so the context's average
 * size between compactions is what a long session pays per call. On the 1M
 * models Claude Code auto-compacts at about 967k; one long session averaged
 * 344k over 1,055 calls since its last compaction, ~363M cache-read tokens.
 * Compacting at ~400k keeps the average near (70k + 400k) / 2 instead of
 * (70k + 967k) / 2 -- about 55% fewer cache reads.
 *
 * THE USER'S DECISION (2026-10-21): "At ~400k". It trades detail kept verbatim
 * for cost; what was recorded in the knowledge graph survives compaction.
 *
 * THE LEVER. `autoCompactWindow` in Claude Code's user settings (tokens,
 * 100k-1M, capped at the model's window, so 200k models are unaffected). A
 * plugin cannot ship it -- plugin settings honour only `agent` and
 * `subagentStatusLine` -- and a SessionStart env file reaches Bash commands,
 * not the client process. So it is written to settings.json like the default
 * route: only when absent, recorded, and taken back out only while it still
 * holds the value we wrote.
 *
 * TOKEN_OPTIMIZER_COMPACT_WINDOW=<tokens> picks another value; 0/off removes ours.
 */
/* eslint-disable n/no-sync -- SYNCHRONOUS FOR THE REASON default-routing.ts gives: a few hundred
 * bytes of settings and manifest, written once at server start, where an interleaved write between
 * two passes is the failure that matters and awaiting would buy no concurrency. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  claudeSettingsFile,
  loadSettings,
  optimizerHome,
  saveSettings,
} from './default-routing.js';

export const DEFAULT_COMPACT_WINDOW = 400_000;
const KEY = 'autoCompactWindow';

interface Recorded {
  readonly value: number;
  readonly writtenAt: string;
}

/**
 * The record of what we wrote, BESIDE THE SETTINGS FILE it describes, for the
 * reason default-routing.ts gives: kept in the optimizer home, a process with
 * a private home wrote the user's real settings and kept the only record
 * where the user's install never looks -- and a value with no record reads as
 * the user's own, so it could never be taken back, not even by the off switch.
 */
export const compactWindowRecordFile = (env: NodeJS.ProcessEnv): string =>
  join(dirname(claudeSettingsFile(env)), 'token-optimizer-compact-window.json');

/** Where records were kept before: still read, emptied on the next write. */
export const legacyCompactWindowRecordFile = (env: NodeJS.ProcessEnv): string =>
  join(optimizerHome(env), 'compact-window.json');

function readAt(path: string): Record<string, Recorded> {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function readManifest(env: NodeJS.ProcessEnv): Record<string, Recorded> {
  const legacy =
    legacyCompactWindowRecordFile(env) === compactWindowRecordFile(env)
      ? {}
      : readAt(legacyCompactWindowRecordFile(env));
  return { ...legacy, ...readAt(compactWindowRecordFile(env)) };
}

function writeManifest(
  env: NodeJS.ProcessEnv,
  manifest: Record<string, Recorded>
): void {
  const file = compactWindowRecordFile(env);
  const path = claudeSettingsFile(env);
  // Only this settings file's entry moves; any other file's stays where it was.
  const current = readAt(file);
  if (path in manifest) current[path] = manifest[path];
  else delete current[path];
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(current, null, 2)}\n`);
  const legacyFile = legacyCompactWindowRecordFile(env);
  if (legacyFile !== file && existsSync(legacyFile)) {
    const legacy = readAt(legacyFile);
    if (path in legacy) {
      delete legacy[path];
      writeFileSync(legacyFile, `${JSON.stringify(legacy, null, 2)}\n`);
    }
  }
}

/** The window to write, or null when the user switched this off. */
export function compactWindowFromEnv(
  env: NodeJS.ProcessEnv = process.env
): number | null {
  const raw = String(env.TOKEN_OPTIMIZER_COMPACT_WINDOW ?? '').trim();
  if (/^(0|false|no|off)$/i.test(raw)) return null;
  // The global off switch turns this off too, and takes our value back out.
  if (/^off$/i.test(String(env.TOKEN_OPTIMIZER_MODE ?? '').trim())) return null;
  if (!raw) return DEFAULT_COMPACT_WINDOW;
  const n = Number(raw.replace(/k$/i, '000'));
  return Number.isInteger(n) && n >= 100_000 && n <= 1_000_000
    ? n
    : DEFAULT_COMPACT_WINDOW;
}

export type CompactWindowStatus =
  | 'written'
  | 'unchanged'
  | 'user-owned'
  | 'removed'
  | 'disabled'
  | 'no-client'
  | 'unreadable';

/** Write, keep, or take back our `autoCompactWindow`. Never touches a value the user set. */
export function applyCompactWindow(
  env: NodeJS.ProcessEnv = process.env
): CompactWindowStatus {
  const path = claudeSettingsFile(env);
  const want = compactWindowFromEnv(env);
  const manifest = readManifest(env);
  const ours = manifest[path];
  if (!existsSync(path) && !ours) return 'no-client';
  const { settings, unreadable } = loadSettings(path);
  if (unreadable) return 'unreadable';
  const current = (settings as Record<string, unknown>)[KEY];

  if (want === null) {
    if (ours && current === ours.value) {
      delete (settings as Record<string, unknown>)[KEY];
      saveSettings(path, settings);
      delete manifest[path];
      writeManifest(env, manifest);
      return 'removed';
    }
    return 'disabled';
  }
  if (current !== undefined && !(ours && current === ours.value))
    return 'user-owned';
  if (current === want) return 'unchanged';
  (settings as Record<string, unknown>)[KEY] = want;
  saveSettings(path, settings);
  manifest[path] = { value: want, writtenAt: new Date().toISOString() };
  writeManifest(env, manifest);
  return 'written';
}
