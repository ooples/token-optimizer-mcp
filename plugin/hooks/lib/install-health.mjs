// GENERATED FILE -- do not edit.
// Source of truth: hooks-core/install-health.mjs. Regenerate with `npm run sync:hooks`.
/**
 * Other installs of this product that are still hooked beside the running one.
 *
 * AN UPGRADE LEFT TWO ROUTERS RUNNING. Observed on one machine: a 7.4.3 plugin,
 * a 5.5.0 npm-global install wired into settings.json, and a dispatcher.ps1 from
 * the first PowerShell installer, all hooked on every tool call. Each install
 * only ever looked at its own wiring -- the doctor skipped settings.json
 * entirely for a plugin install -- so nothing reported the others, and the
 * 5.5.0 router, which predates `assist` and refuses under it, kept denying
 * calls the plugin allowed. Every session on that machine paid for it.
 *
 * "Stray" is an entry of ours (wire.mjs isOurs) whose script is NOT in the
 * directory the running hook was loaded from. That distinction is what keeps a
 * script install -- whose own entries live in settings.json -- from retiring
 * itself, while a plugin install, which writes nothing to settings.json,
 * treats every entry of ours there as another install.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { dispatcherOf, entrypointOf, isOurs } from './wire.mjs';

/** The hooks' own state root, as policy.mjs resolves it, so a test can isolate it. */
const stateRoot = (env) => env.TOKEN_OPTIMIZER_STATE_DIR || join(tmpdir(), 'token-optimizer-hooks');

/** Claude Code's user settings file, as the doctor resolves it. */
export function claudeSettingsPath(env = process.env) {
  return (
    env.TOKEN_OPTIMIZER_SETTINGS ||
    join(env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'settings.json')
  );
}

/**
 * A short notice that the product is switched off, at most once a day.
 *
 * OFF WAS INVISIBLE FOR FOUR WEEKS. `off` exits every hook before it reads its
 * payload, so nothing the product does can say it is off -- the doctor reports
 * it, but only to someone who runs the doctor. One machine carried
 * TOKEN_OPTIMIZER_MODE=off in its settings `env` block from 2026-09-23 to
 * 2026-10-20, very likely left there by a session that meant to switch it off
 * for itself; every session and every subagent in between saved nothing, and
 * its hook log recorded 1,229 runs in one day that each exited unread.
 *
 * One line, about 60 tokens, once per calendar day per machine: the user who
 * chose `off` deliberately hears about it daily rather than per session, and the
 * user who never meant to keep it learns within a day instead of never.
 */
export function offModeNotice({ env = process.env, now = Date.now(), stampDir = stateRoot(env) } = {}) {
  const settingsPath = claudeSettingsPath(env);
  let source = 'the environment';
  let since = '';
  try {
    const value = JSON.parse(readFileSync(settingsPath, 'utf8'))?.env?.TOKEN_OPTIMIZER_MODE;
    if (String(value ?? '').trim().toLowerCase() === 'off') {
      source = `the "env" block of ${settingsPath}`;
      since = ` (file last changed ${new Date(statSync(settingsPath).mtimeMs).toISOString().slice(0, 10)})`;
    }
  } catch {
    /* no readable settings file: the variable came from the environment */
  }

  const day = new Date(now).toISOString().slice(0, 10);
  const stamp = join(stampDir, 'off-notice.stamp');
  try {
    if (existsSync(stamp) && readFileSync(stamp, 'utf8').trim() === day) return null;
    mkdirSync(stampDir, { recursive: true });
    writeFileSync(stamp, day);
  } catch {
    return null;
  }

  return (
    `token-optimizer is OFF: TOKEN_OPTIMIZER_MODE=off is set in ${source}${since}, so no read routing, ` +
    'output bounding, knowledge-graph retrieval or harvest runs in this session or its subagents. ' +
    'If that is not intended, set TOKEN_OPTIMIZER_MODE=assist (everything on, no refusals).'
  );
}

const norm = (path) => resolve(String(path || '')).split('\\').join('/').toLowerCase();

/** The script an entry runs: a node entrypoint, or a dispatcher's -File operand. */
function scriptOf(command) {
  return entrypointOf(command) || dispatcherOf(command);
}

/** The version of the package a hook script belongs to, or null when unknown. */
export function versionNear(script) {
  let dir = dirname(String(script || ''));
  for (let i = 0; i < 5 && dir && dir !== dirname(dir); i += 1) {
    const manifest = join(dir, 'package.json');
    if (existsSync(manifest)) {
      try {
        const parsed = JSON.parse(readFileSync(manifest, 'utf8'));
        if (parsed?.name === '@ooples/token-optimizer-mcp') return parsed.version ?? null;
      } catch {
        return null;
      }
    }
    dir = dirname(dir);
  }
  return null;
}

/**
 * Entries of ours in `settings` that belong to an install other than `ownHooksDir`.
 *
 * Pure apart from the version lookup; `ownHooksDir` null means "the caller is
 * not a script install", so every entry of ours counts.
 */
export function strayEntries(settings, ownHooksDir = null) {
  const own = ownHooksDir ? norm(ownHooksDir) : null;
  const found = [];
  for (const [event, entries] of Object.entries(settings?.hooks || {})) {
    if (!Array.isArray(entries)) continue;
    entries.forEach((entry, index) => {
      if (!isOurs(entry)) return;
      for (const hook of entry.hooks) {
        const script = scriptOf(hook?.command || '');
        if (own && script && norm(dirname(script)) === own) return;
        found.push({ event, index, command: hook?.command || '', script, version: versionNear(script) });
      }
    });
  }
  return found;
}

/** One line per stray install, for a report or a session notice. */
export function describeStrays(strays) {
  const byScript = new Map();
  for (const stray of strays) {
    const key = stray.script || stray.command;
    if (!byScript.has(key)) byScript.set(key, stray);
  }
  return [...byScript.values()].map(
    (s) => `${s.event} -> ${s.script || s.command}${s.version ? ` (v${s.version})` : ''}`
  );
}

/**
 * Removes stray entries from the settings file, keeping a backup beside it.
 *
 * Opt-out with TOKEN_OPTIMIZER_KEEP_STRAY_HOOKS=1. Writes through a temporary
 * file and a rename so a crash cannot leave the user with half a settings file,
 * and never rewrites a file it cannot parse.
 *
 * @returns {{removed: string[], backup: string|null}}
 */
export function retireStrays(settingsPath, { ownHooksDir = null, env = process.env, now = Date.now() } = {}) {
  const none = { removed: [], backup: null };
  if (String(env.TOKEN_OPTIMIZER_KEEP_STRAY_HOOKS || '') === '1') return none;
  if (!settingsPath || !existsSync(settingsPath)) return none;

  let raw;
  let settings;
  try {
    raw = readFileSync(settingsPath, 'utf8');
    settings = JSON.parse(raw);
  } catch {
    return none;
  }

  const strays = strayEntries(settings, ownHooksDir);
  if (!strays.length) return none;

  const strayCommands = new Set(strays.map((s) => s.command));
  const hooks = {};
  for (const [event, entries] of Object.entries(settings.hooks || {})) {
    if (!Array.isArray(entries)) {
      hooks[event] = entries;
      continue;
    }
    const kept = entries
      .map((entry) =>
        isOurs(entry)
          ? { ...entry, hooks: entry.hooks.filter((h) => !strayCommands.has(h?.command || '')) }
          : entry
      )
      .filter((entry) => !Array.isArray(entry?.hooks) || entry.hooks.length);
    if (kept.length) hooks[event] = kept;
  }
  const next = { ...settings };
  if (Object.keys(hooks).length) next.hooks = hooks;
  else delete next.hooks;

  const backup = `${settingsPath}.token-optimizer-stray-${now}.bak`;
  writeFileSync(backup, raw);
  const tmp = `${settingsPath}.token-optimizer-tmp-${now}`;
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
  renameSync(tmp, settingsPath);
  return { removed: describeStrays(strays), backup };
}
