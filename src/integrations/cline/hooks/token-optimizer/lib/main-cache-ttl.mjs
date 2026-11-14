// GENERATED FILE -- do not edit.
// Source of truth: src/hooks-core/main-cache-ttl.mjs. Regenerate with `npm run sync:hooks`.
/**
 * The main conversation's prompt-cache TTL tier, set to 1h when this user's own
 * sessions show it is cheaper (#567).
 *
 * WHY. Claude Code picks the main thread's tier automatically: 1 hour on a
 * subscription within its usage limits, 5 minutes on an API key, Bedrock,
 * Vertex, Foundry -- and on a subscription once it is over its limits. At 5m,
 * every pause longer than five minutes (reading, thinking, a long build) loses
 * the whole cached conversation and writes it again at 1.25x. An explicit
 * `promptCacheTtl` setting outranks the automatic choice, so writing "1h" keeps
 * those sessions warm. Replayed over 92 of the author's sessions, 5m cost 1.201x
 * what 1h did.
 *
 * WHY NOT FOR EVERYONE UNCONDITIONALLY. A 1h write costs 2x against 1.25x, and
 * the setting covers `-p` and SDK turns too: short runs that never pause are
 * cheaper at 5m. So the setting is written only when the replay of this user's
 * own recent sessions says 1h is cheaper by a margin -- the same rule the
 * subagent tier follows (agent-ledger.mjs).
 *
 * NEVER OVER THE USER: an explicit `promptCacheTtl`, or CLAUDE_CODE_PROMPT_CACHE_TTL,
 * is theirs. Written once, ever, with a backup of the exact prior bytes; a
 * removal is the user declining it. Measured at most once a day.
 * Opt out with TOKEN_OPTIMIZER_MAIN_CACHE_TTL=off.
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homeDir } from './agent-ledger.mjs';
import { recentTranscripts } from './skill-diet.mjs';
import { editSettings } from './settings-edit.mjs';
import { replayTtl, tallyFile } from './subagents.mjs';

export const mainTtlRecordPath = (env = process.env) => join(homeDir(env), 'main-cache-ttl.json');
export const mainTtlCheckedPath = (env = process.env) => join(homeDir(env), 'main-cache-ttl.checked');

const DAY_MS = 86_400_000;
const optedOut = (env) => /^(off|0|false|no)$/i.test(String(env.TOKEN_OPTIMIZER_MAIN_CACHE_TTL || '').trim());

/**
 * Should the main conversation write at 1h, on the evidence of these session
 * tallies? Replays every session at both tiers: the replay is a model of the
 * cache from request timing and size, so it does not matter which tier a
 * session was recorded at. Needs several sessions and a material saving, so a
 * few odd sessions cannot flip a setting that covers every session.
 *
 * EVERY SESSION WITH A REQUEST COUNTS, single-request ones included: the
 * setting covers `-p` and SDK runs too, and a lone request is exactly where 1h
 * costs more (a 2x write against 1.25x, with no later read to repay it).
 * Leaving them out priced only the sessions 1h helps (#568 review).
 */
export function mainTtlDecision(tallies, { minSessions = 5, minSaving = 200_000, minShare = 0.05 } = {}) {
  const sessions = (tallies || []).filter((t) => t && Array.isArray(t.requests) && t.requests.length > 0);
  const at5m = sessions.reduce((sum, t) => sum + replayTtl(t.requests, '5m'), 0);
  const at1h = sessions.reduce((sum, t) => sum + replayTtl(t.requests, '1h'), 0);
  const saving = at5m - at1h;
  const share = at5m ? saving / at5m : 0;
  const enough = sessions.length >= minSessions && saving >= minSaving && share >= minShare;
  return { recommend: enough ? '1h' : null, sessions: sessions.length, at5m, at1h, saving, share };
}

/** Is the main TTL already the user's (or the environment's) to decide? */
export function mainTtlOwner(settings, env = process.env) {
  if (String(env.CLAUDE_CODE_PROMPT_CACHE_TTL || '').trim()) return 'environment';
  if (settings && Object.prototype.hasOwnProperty.call(settings, 'promptCacheTtl')) return 'settings';
  return null;
}

/**
 * Measure and, when the evidence says so, write `promptCacheTtl: "1h"`.
 *
 * @param {string} settingsPath ~/.claude/settings.json
 * @param {{ env?: object, now?: number, tallies?: object[] }} [options]
 *   `tallies` replaces the transcript scan (tests).
 * @returns {{ written: boolean, reason: string, backup?: string|null, decision?: object }}
 */
export function applyMainTtl(settingsPath, { env = process.env, now = Date.now(), tallies = null } = {}) {
  if (optedOut(env)) return { written: false, reason: 'opted out' };
  if (!settingsPath) return { written: false, reason: 'no settings path' };
  if (existsSync(mainTtlRecordPath(env))) {
    return { written: false, reason: 'written once before; a removal is the user declining it' };
  }
  try {
    if (now - statSync(mainTtlCheckedPath(env)).mtimeMs < DAY_MS) return { written: false, reason: 'measured within the day' };
  } catch {
    /* never measured */
  }
  // A first look, so a setting that is not ours costs no transcript scan. It is
  // checked again on a fresh read under the lock before anything is written.
  if (existsSync(settingsPath)) {
    let settings;
    try {
      settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
    } catch {
      return { written: false, reason: 'settings not parseable; never rewritten' };
    }
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
      return { written: false, reason: 'settings not an object' };
    }
    const owner = mainTtlOwner(settings, env);
    if (owner) return { written: false, reason: `already set in ${owner}` };
  } else if (mainTtlOwner({}, env)) {
    return { written: false, reason: `already set in ${mainTtlOwner({}, env)}` };
  }

  const measured = tallies ?? recentTranscripts({ env, maxFiles: 30 }).map((path) => tallyFile(path));
  const decision = mainTtlDecision(measured);
  try {
    mkdirSync(homeDir(env), { recursive: true });
    writeFileSync(mainTtlCheckedPath(env), `${JSON.stringify({ at: now, ...decision, share: Number(decision.share.toFixed(4)) })}\n`);
  } catch {
    /* measured again next time */
  }
  if (!decision.recommend) return { written: false, reason: 'evidence does not favour 1h', decision };

  const edit = editSettings(
    settingsPath,
    (settings) => {
      const owner = mainTtlOwner(settings, env);
      return owner ? { skip: `already set in ${owner}` } : { next: { ...settings, promptCacheTtl: decision.recommend } };
    },
    { now, backupTag: 'token-optimizer-main-ttl' }
  );
  if (edit.status !== 'written') return { written: false, reason: edit.reason, decision };
  try {
    const record = {
      at: now,
      settingsPath,
      value: decision.recommend,
      backup: edit.backup,
      existed: edit.existed,
      evidence: { sessions: decision.sessions, at5m: decision.at5m, at1h: decision.at1h, share: Number(decision.share.toFixed(4)) },
    };
    mkdirSync(homeDir(env), { recursive: true });
    writeFileSync(mainTtlRecordPath(env), `${JSON.stringify(record, null, 2)}\n`);
  } catch {
    /* the setting is written; without a record, uninstall cannot undo it, which doctor shows */
  }
  return { written: true, reason: 'evidence favours 1h', backup: edit.backup, decision };
}

/** Remove the setting we wrote, if it is still the value we wrote. */
export function undoMainTtl({ env = process.env, now = Date.now() } = {}) {
  let record;
  try {
    record = JSON.parse(readFileSync(mainTtlRecordPath(env), 'utf8'));
  } catch {
    return { undone: false, reason: 'nothing was written by token-optimizer' };
  }
  if (record.undoneAt) return { undone: false, reason: 'already removed' };
  if (!existsSync(record.settingsPath)) return { undone: false, reason: 'settings not parseable; never rewritten' };
  const edit = editSettings(
    record.settingsPath,
    (settings) => {
      if (settings.promptCacheTtl !== record.value) return { skip: 'the value was changed since; it is yours now' };
      const next = { ...settings };
      delete next.promptCacheTtl;
      return { next };
    },
    { now }
  );
  if (edit.status !== 'written') return { undone: false, reason: edit.reason };
  writeFileSync(mainTtlRecordPath(env), `${JSON.stringify({ ...record, undoneAt: now }, null, 2)}\n`);
  return { undone: true, reason: 'removed' };
}

/** One line for doctor: what the main TTL is and who set it. */
export function describeMainTtl(settingsPath, env = process.env) {
  let settings = {};
  try {
    settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
  } catch {
    settings = {};
  }
  let record = null;
  try {
    record = JSON.parse(readFileSync(mainTtlRecordPath(env), 'utf8'));
  } catch {
    record = null;
  }
  const owner = mainTtlOwner(settings, env);
  if (owner === 'environment') {
    return `main cache TTL ${String(env.CLAUDE_CODE_PROMPT_CACHE_TTL).trim()}, set by CLAUDE_CODE_PROMPT_CACHE_TTL (yours; never changed by token-optimizer).`;
  }
  const value = owner === 'settings' ? String(settings.promptCacheTtl) : null;
  if (owner === 'settings' && record && !record.undoneAt && value === record.value) {
    const pct = Math.round(100 * (record.evidence?.share || 0));
    return `main cache TTL ${value}, written by token-optimizer on ${new Date(record.at).toISOString().slice(0, 10)}: ` +
      `your last ${record.evidence?.sessions} sessions replayed ${pct}% cheaper at 1h. ` +
      'Set promptCacheTtl yourself to override it, or run token-optimizer-uninstall --apply to remove it.';
  }
  if (owner === 'settings') return `main cache TTL ${value}, set in ${settingsPath} (yours; never changed by token-optimizer).`;
  if (record) return 'main cache TTL is automatic; token-optimizer wrote 1h once and it was removed since, so it is never written again.';
  if (optedOut(env)) return 'main cache TTL is automatic; TOKEN_OPTIMIZER_MAIN_CACHE_TTL=off keeps it so.';
  return 'main cache TTL is automatic (1h on a subscription within limits, 5m otherwise); token-optimizer sets 1h once your sessions replay cheaper at 1h.';
}
