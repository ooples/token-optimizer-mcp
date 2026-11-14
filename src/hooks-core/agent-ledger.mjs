/**
 * What each finished subagent cost, kept machine-wide, and the one setting that
 * evidence justifies changing: the prompt-cache TTL tier subagents write at.
 *
 * WHY THIS EXISTS. Claude Code writes the main thread's prompt cache at the
 * 1-hour tier and everything else -- subagents included -- at the 5-minute tier
 * unless `subagentPromptCacheTtl` says otherwise. An agent that waits on a build
 * or a test suite for more than five minutes loses its whole cached context and
 * writes it again at 1.25x. Measured on 2026-11-12 over 37 real agents: 223 of
 * 242 cache breaks followed such a gap, and they were 90% of all the agents'
 * cache writes. Replayed at the 1-hour tier the same requests cost 25% less.
 *
 * THE DECISION IS MADE FROM THIS MACHINE'S OWN AGENTS, NOT ASSUMED. A 1-hour
 * write costs 2x against 1.25x, so agents that never pause are cheaper at 5m,
 * and the setting is written only when the replay of the agents recorded here
 * says 1h is cheaper by a margin. One cheap record per finished agent
 * (SubagentStop hands us one transcript), never a scan of whole sessions.
 *
 * NEVER OVER THE USER. An explicit `subagentPromptCacheTtl` in settings, or the
 * CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL variable, is the user's choice and is
 * left alone -- including a value we wrote and they later changed. What we wrote
 * is recorded with a backup so `undoSubagentTtl` can put it back exactly.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { editSettings } from './settings-edit.mjs';
import { expiryRewrites, replayTtl } from './subagents.mjs';

/** Machine-wide state, as the other user-global records resolve it. */
export const homeDir = (env = process.env) => env.TOKEN_OPTIMIZER_HOME || join(homedir(), '.token-optimizer');
export const ledgerPath = (env = process.env) => join(homeDir(env), 'agents.jsonl');
export const ttlRecordPath = (env = process.env) => join(homeDir(env), 'subagent-cache-ttl.json');

const LEDGER_WINDOW_MS = 30 * 24 * 3600 * 1000;
const MAX_LEDGER_BYTES = 8 * 1024 * 1024;

/** One finished agent, as a ledger row. Pure: the caller tallied the transcript. */
export function agentRow(tally, { sessionId = null, agentId = null, now = Date.now() } = {}) {
  const expiry = expiryRewrites(tally.requests, '5m');
  return {
    at: now,
    sessionId,
    agentId,
    turns: tally.turns,
    baseContext: tally.baseContext,
    cacheRead: tally.cacheRead,
    cacheWrite: tally.cacheWrite,
    input: tally.input,
    output: tally.output,
    toolOutput: tally.toolOutput,
    write5m: tally.write5m,
    write1h: tally.write1h,
    // What the same requests cost replayed at each tier, so the decision needs
    // nothing but these rows.
    at5m: replayTtl(tally.requests, '5m'),
    at1h: replayTtl(tally.requests, '1h'),
    expiries: expiry.count,
    expiryTokens: expiry.tokens,
  };
}

/** Append a row. Never throws: the ledger is evidence, not a dependency. */
export function recordAgent(row, env = process.env) {
  try {
    const path = ledgerPath(env);
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(row)}\n`);
    return true;
  } catch {
    return false;
  }
}

/** The rows of the last 30 days, newest last. Malformed lines are skipped. */
export function readLedger(env = process.env, { now = Date.now() } = {}) {
  const path = ledgerPath(env);
  if (!existsSync(path)) return [];
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return [];
  }
  if (text.length > MAX_LEDGER_BYTES) text = text.slice(text.length - MAX_LEDGER_BYTES);
  const rows = [];
  for (const line of text.split('\n')) {
    if (!line.startsWith('{')) continue;
    try {
      const row = JSON.parse(line);
      if (now - Number(row.at) <= LEDGER_WINDOW_MS) rows.push(row);
    } catch {
      /* skip */
    }
  }
  return rows;
}

/**
 * Should subagents write at the 1-hour tier, on the evidence of these rows?
 *
 * Only rows written at the 5m tier count -- a row already at 1h says nothing
 * about what 5m would have cost on this machine's real gaps. Needs a few agents
 * and a material saving, so one odd agent cannot flip a machine-wide setting.
 */
export function ttlDecision(rows, { minAgents = 3, minSaving = 200_000, minShare = 0.05 } = {}) {
  const at5mRows = (rows || []).filter((r) => (r.write5m || 0) > (r.write1h || 0));
  const at5m = at5mRows.reduce((sum, r) => sum + (r.at5m || 0), 0);
  const at1h = at5mRows.reduce((sum, r) => sum + (r.at1h || 0), 0);
  const saving = at5m - at1h;
  const share = at5m ? saving / at5m : 0;
  const enough = at5mRows.length >= minAgents && saving >= minSaving && share >= minShare;
  return {
    recommend: enough ? '1h' : null,
    agents: at5mRows.length,
    at5m,
    at1h,
    saving,
    share,
    expiries: at5mRows.reduce((sum, r) => sum + (r.expiries || 0), 0),
  };
}

/** Is the subagent TTL already the user's (or the environment's) to decide? */
export function ttlOwner(settings, env = process.env) {
  if (String(env.CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL || '').trim()) return 'environment';
  if (settings && Object.prototype.hasOwnProperty.call(settings, 'subagentPromptCacheTtl')) return 'settings';
  return null;
}

/**
 * Write `subagentPromptCacheTtl: "1h"` when the decision says so and nobody has
 * set it. Atomic (temp file and rename), with a backup of the exact prior bytes,
 * and never on a file it cannot parse.
 *
 * Opt out with TOKEN_OPTIMIZER_SUBAGENT_CACHE_TTL=off.
 *
 * @returns {{written: boolean, reason: string, backup?: string, decision?: object}}
 */
export function applySubagentTtl(settingsPath, { env = process.env, rows = readLedger(env), now = Date.now() } = {}) {
  if (/^(off|0|false|no)$/i.test(String(env.TOKEN_OPTIMIZER_SUBAGENT_CACHE_TTL || '').trim())) {
    return { written: false, reason: 'opted out' };
  }
  if (!settingsPath) return { written: false, reason: 'no settings path' };
  // WRITTEN ONCE, EVER. An undo is a decline, and so is the user deleting the key
  // by hand: either way a record of our write exists while the key does not, and
  // the next finished agent must not write it straight back.
  if (existsSync(ttlRecordPath(env))) {
    return { written: false, reason: 'written once before; a removal is the user declining it' };
  }
  const decision = ttlDecision(rows);
  // Read, ownership check, merge and write under the lock every settings writer
  // shares (settings-edit.mjs), so a concurrent write is never replaced.
  const edit = editSettings(
    settingsPath,
    (settings) => {
      const owner = ttlOwner(settings, env);
      if (owner) return { skip: `already set in ${owner}` };
      if (!decision.recommend) return { skip: 'evidence does not favour 1h' };
      return { next: { ...settings, subagentPromptCacheTtl: decision.recommend } };
    },
    { now, backupTag: 'token-optimizer-ttl' }
  );
  if (edit.status !== 'written') {
    return { written: false, reason: edit.reason, ...(edit.status === 'skipped' && !decision.recommend ? { decision } : {}) };
  }
  const backup = edit.backup;
  try {
    const record = {
      at: now,
      settingsPath,
      value: decision.recommend,
      backup,
      existed: edit.existed,
      evidence: {
        agents: decision.agents,
        at5m: decision.at5m,
        at1h: decision.at1h,
        share: Number(decision.share.toFixed(4)),
        expiries: decision.expiries,
      },
    };
    mkdirSync(homeDir(env), { recursive: true });
    writeFileSync(ttlRecordPath(env), `${JSON.stringify(record, null, 2)}\n`);
    return { written: true, reason: 'evidence favours 1h', backup, decision };
  } catch (error) {
    return { written: false, reason: `write failed: ${error?.message || error}` };
  }
}

/**
 * Remove the setting we wrote, if it is still the value we wrote. A value the
 * user has since changed is theirs and is left alone.
 */
export function undoSubagentTtl({ env = process.env, now = Date.now() } = {}) {
  let record;
  try {
    record = JSON.parse(readFileSync(ttlRecordPath(env), 'utf8'));
  } catch {
    return { undone: false, reason: 'nothing was written by token-optimizer' };
  }
  if (!existsSync(record.settingsPath)) return { undone: false, reason: 'settings not parseable; never rewritten' };
  const edit = editSettings(
    record.settingsPath,
    (settings) => {
      if (settings.subagentPromptCacheTtl !== record.value) return { skip: 'the value was changed since; it is yours now' };
      const next = { ...settings };
      delete next.subagentPromptCacheTtl;
      return { next };
    },
    { now }
  );
  if (edit.status !== 'written') return { undone: false, reason: edit.reason };
  writeFileSync(ttlRecordPath(env), `${JSON.stringify({ ...record, undoneAt: now }, null, 2)}\n`);
  return { undone: true, reason: 'removed' };
}

/**
 * What agents cost beyond their work, in uncached-input token equivalents, for
 * the savings report. The report's "verified saved" counts trimmed tool output
 * only; this is the other side of the ledger, which it never showed:
 *
 *   fixedReread   every turn after the first re-reads the agent's starting
 *                 context (system prompt, tools, instructions, memory) at 0.1x
 *   expiryRewrite cache re-written after a gap outlived the TTL, at the tier's
 *                 write price
 *   avoidableAt1h what the 1h tier would have saved on the rows written at 5m
 *                 (zero or less means 5m was right)
 */
export function agentOverhead(rows, { since = 0, until = Infinity } = {}) {
  const inRange = (rows || []).filter((r) => r.at >= since && r.at <= until);
  const sum = (key) => inRange.reduce((total, r) => total + (Number(r[key]) || 0), 0);
  const fixedReread = Math.round(
    inRange.reduce((total, r) => total + 0.1 * (r.baseContext || 0) * Math.max(0, (r.turns || 0) - 1), 0)
  );
  const expiryRewrite = Math.round(
    inRange.reduce((total, r) => total + (r.expiryTokens || 0) * ((r.write1h || 0) > (r.write5m || 0) ? 2 : 1.25), 0)
  );
  const at5mRows = inRange.filter((r) => (r.write5m || 0) > (r.write1h || 0));
  const weighted = Math.round(
    inRange.reduce(
      (total, r) =>
        total +
        (r.input || 0) +
        0.1 * (r.cacheRead || 0) +
        1.25 * (r.write5m || 0) +
        2 * (r.write1h || 0),
      0
    )
  );
  return {
    agents: inRange.length,
    turns: sum('turns'),
    weighted,
    output: sum('output'),
    toolOutput: sum('toolOutput'),
    medianBase: median(inRange.map((r) => r.baseContext || 0)),
    fixedReread,
    expiryRewrite,
    expiries: sum('expiries'),
    avoidableAt1h: at5mRows.reduce((total, r) => total + ((r.at5m || 0) - (r.at1h || 0)), 0),
  };
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/**
 * One line on who owns the subagent cache TTL and how to change it, for the
 * doctor. The setting is written into the user's own settings file, so where it
 * came from and how to take it back must be askable without reading the source.
 */
export function describeSubagentTtl(settingsPath, env = process.env) {
  let settings = null;
  try {
    settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
  } catch {
    /* an unreadable file owns nothing */
  }
  const record = ttlRecord(env);
  const owner = ttlOwner(settings, env);
  const value = owner === 'environment'
    ? String(env.CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL).trim()
    : owner === 'settings'
      ? String(settings.subagentPromptCacheTtl)
      : null;
  const optedOut = /^(off|0|false|no)$/i.test(String(env.TOKEN_OPTIMIZER_SUBAGENT_CACHE_TTL || '').trim());
  if (owner === 'environment') return `subagent cache TTL ${value}, set by CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL (yours; never changed by token-optimizer).`;
  if (owner === 'settings' && record && !record.undoneAt && value === record.value) {
    return `subagent cache TTL ${value}, written by token-optimizer on ${new Date(record.at).toISOString().slice(0, 10)} from measured agent cache expiry. ` +
      'Set subagentPromptCacheTtl yourself to override it, or run token-optimizer-uninstall --apply to remove it.';
  }
  if (owner === 'settings') return `subagent cache TTL ${value}, set in ${settingsPath} (yours; never changed by token-optimizer).`;
  if (record) return 'subagent cache TTL is the 5-minute default; token-optimizer wrote 1h once and it was removed since, so it is never written again.';
  if (optedOut) return 'subagent cache TTL is the 5-minute default; TOKEN_OPTIMIZER_SUBAGENT_CACHE_TTL=off keeps it so.';
  return 'subagent cache TTL is the 5-minute default; token-optimizer sets 1h once finished agents show that cache expiry costs more than it would.';
}

/** The subagent TTL record, if token-optimizer ever wrote the setting. */
export function ttlRecord(env = process.env) {
  try {
    return JSON.parse(readFileSync(ttlRecordPath(env), 'utf8'));
  } catch {
    return null;
  }
}
