#!/usr/bin/env node
/**
 * token-optimizer-learned: what the learned cost controls know about this
 * repository and what they did, and the commands to change it.
 *
 *   token-optimizer-learned status              billing mode, tool pruning, loop guard, injection holdout
 *   token-optimizer-learned toolprune           the pruned, pending and restored tools, with evidence
 *   token-optimizer-learned toolprune restore [Tool ...]   give tools back (all when none named); never pruned again
 *   token-optimizer-learned toolprune fold      fold finished sessions and decide now
 *     add --codex to any toolprune command for Codex capability pruning (.codex/config.toml)
 *     add --copilot for Copilot CLI tool pruning (--excluded-tools, added by the managed launcher)
 *   token-optimizer-learned statusline install  record quota usage from Claude Code's status line
 *                                               (wraps an existing status line; prints a quota line otherwise)
 *   token-optimizer-learned statusline uninstall  put the previous status line back
 *
 * Options: --cwd <dir> (default: the current directory), --json.
 * Read-only except `restore` and `fold`. From a terminal this costs no model
 * turn and no tokens.
 */

import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeAtomically } from '../hooks-core/policy.mjs';
import { paceDecision, subscriptionPolicy } from '../hooks-core/quota-policy.mjs';
import { billingMode, describeBilling } from '../hooks-core/billing.mjs';
import { analyze, holdoutSettings, injectedTotals, loadPolicy } from '../hooks-core/injection-holdout.mjs';
import { envelopeSummary, loadEnvelope, loopguardSettings, readEvents } from '../hooks-core/loopguard.mjs';
import {
  candidates,
  evidenceFor,
  loadStore,
  restoreTools,
  runFold,
  toolpruneSettings,
} from '../hooks-core/toolprune.mjs';
import { learnedLocation } from '../hooks-core/toolprune.mjs';
import { CODEX_STORE_FILE, restoreCodex, runCodexFold } from '../hooks-core/codexprune.mjs';
import { copilotStatus, leanSwitchState, restoreCopilot, restoreLeanSwitches, runCopilotFold } from '../hooks-core/copilotprune.mjs';

const TAP = join(dirname(fileURLToPath(import.meta.url)), 'statusline-tap.mjs');
const TAP_MARKER = 'statusline-tap.mjs';

function userSettingsPath(home = homedir()) {
  return join(home, '.claude', 'settings.json');
}

function readUserSettings(home) {
  const path = userSettingsPath(home);
  if (!existsSync(path)) return { ok: true, json: {} };
  try {
    if (lstatSync(path).isSymbolicLink()) return { ok: false, reason: 'settings.json is a symlink' };
    const json = JSON.parse(readFileSync(path, 'utf8'));
    if (!json || typeof json !== 'object' || Array.isArray(json)) return { ok: false, reason: 'settings.json is not a JSON object' };
    return { ok: true, json };
  } catch {
    return { ok: false, reason: 'settings.json is not valid JSON' };
  }
}

/** Install the tap as the user's status line, wrapping whatever was there. */
export function installStatusline({ home = homedir(), tap = TAP } = {}) {
  const read = readUserSettings(home);
  if (!read.ok) return read;
  const current = read.json.statusLine;
  if (current?.command && String(current.command).includes(TAP_MARKER)) return { ok: true, already: true };
  const wrapped = current?.type === 'command' && current.command ? String(current.command) : null;
  const command = `node "${tap}"${wrapped ? ` --wrap-b64 ${Buffer.from(wrapped, 'utf8').toString('base64')}` : ''}`;
  const next = { ...read.json, statusLine: { ...(current || {}), type: 'command', command } };
  mkdirSync(dirname(userSettingsPath(home)), { recursive: true });
  writeAtomically(userSettingsPath(home), `${JSON.stringify(next, null, 2)}\n`);
  return { ok: true, wrapped };
}

/** Put back exactly what the tap wrapped, or remove the status line it added. */
export function uninstallStatusline({ home = homedir() } = {}) {
  const read = readUserSettings(home);
  if (!read.ok) return read;
  const current = read.json.statusLine;
  if (!current?.command || !String(current.command).includes(TAP_MARKER)) return { ok: true, absent: true };
  const match = String(current.command).match(/--wrap-b64 ([A-Za-z0-9+/=]+)/);
  const next = { ...read.json };
  if (match) next.statusLine = { ...current, command: Buffer.from(match[1], 'base64').toString('utf8') };
  else delete next.statusLine;
  writeAtomically(userSettingsPath(home), `${JSON.stringify(next, null, 2)}\n`);
  return { ok: true, restored: Boolean(match) };
}

/** Where Claude Code keeps this project's transcripts. */
export function claudeProjectDir(root, home = homedir()) {
  return join(home, '.claude', 'projects', String(root).replace(/[^A-Za-z0-9]/g, '-'));
}

function parseArgs(argv) {
  const args = { positional: [], json: false, codex: false, copilot: false, cwd: process.cwd() };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--json') args.json = true;
    else if (value === '--codex') args.codex = true;
    else if (value === '--copilot') args.copilot = true;
    else if (value === '--cwd') args.cwd = argv[++index] || args.cwd;
    else args.positional.push(value);
  }
  return args;
}

export function collectStatus(cwd, { env = process.env } = {}) {
  const { root, dir } = learnedLocation(cwd);
  const billing = billingMode({ env });
  const pacing = paceDecision({ env });
  const prune = toolpruneSettings(env);
  const store = loadStore(dir);
  const wanted = candidates(store, prune);
  const guard = loopguardSettings(env);
  const events = readEvents(dir);
  const judgeCalls = events.filter((event) => event.kind === 'judge');
  const holdout = holdoutSettings(env);
  return {
    root,
    billing: { mode: billing.mode, source: billing.source, objective: billing.objective.unit },
    pacing: { policy: subscriptionPolicy(env), allowed: pacing.allowed, reason: pacing.reason },
    toolprune: {
      mode: prune.mode,
      sessionsFolded: store.sessions.length,
      catalogTools: store.catalog.tools.length,
      catalogProbedAt: store.catalog.probedAt || null,
      applied: store.applied.map((name) => ({ name, ...evidenceFor(store, name) })),
      pending: wanted.filter((item) => !store.applied.includes(item.name)),
      restored: store.restored,
      blocked: store.blocked,
    },
    codexprune: (() => {
      const codex = loadStore(dir, CODEX_STORE_FILE);
      return {
        sessionsFolded: codex.sessions.length,
        applied: codex.applied.map((name) => ({ name, ...evidenceFor(codex, name) })),
        pending: candidates(codex, prune).filter((item) => !codex.applied.includes(item.name) && !codex.restored.includes(item.name)),
        restored: codex.restored,
        blocked: codex.blocked,
      };
    })(),
    copilotprune: copilotStatus(dir, env),
    copilotLeanSwitches: leanSwitchState(env),
    loopguard: {
      enabled: guard.enabled,
      judge: guard.judge,
      envelope: envelopeSummary(loadEnvelope(dir), guard),
      redirects: events.filter((event) => event.kind === 'redirect').length,
      notices: events.filter((event) => event.kind === 'notice').length,
      judgeCalls: judgeCalls.length,
      judgeCostUsd: judgeCalls.reduce((sum, event) => sum + (Number(event.costUsd) || 0), 0),
    },
    holdout: {
      enabled: holdout.enabled,
      fraction: holdout.fraction,
      gated: loadPolicy(dir).gated,
      classes: analyze(dir),
      injectedChars: injectedTotals(dir),
    },
  };
}

const pct = (value) => (value == null ? '-' : `${value > 0 ? '+' : ''}${(value * 100).toFixed(1)}%`);

export function renderStatus(status) {
  const lines = [`token-optimizer learned controls -- ${status.root}`, ''];
  lines.push(describeBilling({ mode: status.billing.mode, source: status.billing.source, objective: { unit: status.billing.objective } }));
  if (status.billing.mode === 'subscription' && status.pacing.policy !== 'report') {
    lines.push(
      status.pacing.policy === 'pace'
        ? `quota pacing: ${status.pacing.allowed ? 'may spend leftover capacity' : 'holding'} -- ${status.pacing.reason}`
        : 'quota pacing: off (policy suggest). TOKEN_OPTIMIZER_SUBSCRIPTION_POLICY=pace spends leftover capacity only when the week is on pace.'
    );
    if (/no recent usage data/.test(status.pacing.reason)) {
      lines.push('  run `token-optimizer-learned statusline install` so pacing can see real 5-hour and weekly usage');
    }
  }
  const prune = status.toolprune;
  lines.push('', `tool pruning: ${prune.mode}; ${prune.sessionsFolded} session(s) learned from; catalog ${prune.catalogTools ? `${prune.catalogTools} tools` : 'not probed yet'}`);
  for (const item of prune.applied) lines.push(`  left out  ${item.name}  (unused for ${item.prompts} prompts / ${item.sessions} sessions)`);
  for (const item of prune.pending) lines.push(`  pending   ${item.name}  (unused for ${item.prompts} prompts / ${item.sessions} sessions; written once sessions here are idle)`);
  if (prune.restored.length) lines.push(`  restored  ${prune.restored.join(', ')}  (never pruned again)`);
  if (prune.blocked) lines.push(`  not written: ${prune.blocked}`);
  const codex = status.codexprune;
  if (codex?.sessionsFolded) {
    lines.push('', `Codex capability pruning: ${prune.mode}; ${codex.sessionsFolded} Codex session(s) learned from`);
    for (const item of codex.applied) lines.push(`  switched off  ${item.name}  (unused for ${item.prompts} prompts / ${item.sessions} sessions)`);
    for (const item of codex.pending) lines.push(`  pending       ${item.name}  (unused for ${item.prompts} prompts / ${item.sessions} sessions)`);
    if (codex.restored.length) lines.push(`  restored  ${codex.restored.join(', ')}  (never switched off again)`);
    if (codex.blocked) lines.push(`  not written: ${codex.blocked}`);
  }
  const copilot = status.copilotprune;
  if (copilot?.sessionsFolded) {
    lines.push('', `Copilot tool pruning: ${copilot.mode}; ${copilot.sessionsFolded} Copilot session(s) learned from; applied by the managed \`copilot\` launcher`);
    for (const item of copilot.applied) lines.push(`  left out  ${item.name}  (unused for ${item.prompts} prompts / ${item.sessions} sessions)`);
    for (const item of copilot.pending) lines.push(`  proposed  ${item.name}  (unused for ${item.prompts} prompts / ${item.sessions} sessions)`);
    if (copilot.restored.length) lines.push(`  restored  ${copilot.restored.join(', ')}  (never left out again)`);
  }
  const lean = status.copilotLeanSwitches;
  if (lean?.copilotInstalled) {
    const off = lean.switches.filter((item) => item.off).map((item) => `${item.key}${item.writtenHere ? ' (written here)' : ''}`);
    lines.push(`Copilot user switches: ${lean.mode}${lean.declined ? ', restored and not written again' : ''}; off: ${off.join(', ') || 'none'}`);
  }
  const guard = status.loopguard;
  const envelope = guard.envelope.ready
    ? `usual turn ${Math.round(guard.envelope.median)} calls, p90 ${Math.round(guard.envelope.p90)}`
    : `learning (${guard.envelope.samples} good turns so far)`;
  lines.push('', `loop guard: ${guard.enabled ? 'on' : 'off'}${guard.judge ? ' + judge' : ''}; ${envelope}`);
  lines.push(`  ${guard.redirects} redirect(s), ${guard.notices} still-stuck notice(s), ${guard.judgeCalls} judge call(s)${guard.judgeCalls ? ` ($${guard.judgeCostUsd.toFixed(4)})` : ''}`);
  const holdout = status.holdout;
  lines.push('', `injection holdout: ${holdout.enabled ? `on, ${Math.round(holdout.fraction * 100)}% of sessions` : 'off'}${holdout.gated.length ? `; gated: ${holdout.gated.join(', ')}` : ''}`);
  for (const row of holdout.classes) {
    const chars = holdout.injectedChars[row.cls] || 0;
    lines.push(
      `  ${row.cls.padEnd(14)} ${row.verdict.padEnd(26)} withheld ${String(row.withheld).padStart(3)} / served ${String(row.served).padStart(4)}  cost when withheld ${pct(row.effect)}${row.p != null ? ` (p=${row.p.toFixed(3)})` : ''}  ~${Math.round(chars / 4)} tokens injected`
    );
  }
  return lines.join('\n');
}

async function main(argv) {
  const args = parseArgs(argv);
  const [command = 'status', action, ...names] = args.positional;
  const { root, dir } = learnedLocation(args.cwd);
  if (command === 'statusline') {
    const result = action === 'uninstall' ? uninstallStatusline() : installStatusline();
    if (!result.ok) {
      console.log(`status line not changed: ${result.reason}`);
      return 1;
    }
    if (action === 'uninstall') console.log(result.absent ? 'the tap was not installed' : result.restored ? 'previous status line restored' : 'status line removed');
    else console.log(result.already ? 'already installed' : result.wrapped ? 'installed, wrapping your existing status line' : 'installed');
    return 0;
  }
  if (command === 'toolprune' && action === 'restore' && args.copilot) {
    const result = restoreCopilot({ dir, names });
    console.log(`restored: ${result.restored.join(', ') || '(nothing was left out)'}`);
    // No names = everything, the user-level lean switches included.
    if (!names.length) {
      const lean = restoreLeanSwitches();
      if (lean.restored.length) console.log(`copilot switches restored: ${lean.restored.join(', ')} (${lean.how})`);
    }
    return 0;
  }
  if (command === 'toolprune' && action === 'fold' && args.copilot) {
    console.log(JSON.stringify(runCopilotFold({ dir, root }), null, 2));
    return 0;
  }
  if (command === 'toolprune' && action === 'restore' && args.codex) {
    const result = restoreCodex({ dir, root, ids: names });
    console.log(result.ok ? `restored: ${result.restored.join(', ') || '(nothing was switched off)'}` : `not restored: ${result.reason}`);
    return result.ok ? 0 : 1;
  }
  if (command === 'toolprune' && action === 'fold' && args.codex) {
    console.log(JSON.stringify(runCodexFold({ dir, root }), null, 2));
    return 0;
  }
  if (command === 'toolprune' && action === 'restore') {
    const result = restoreTools({ dir, root, names });
    console.log(result.ok ? `restored: ${result.restored.join(', ') || '(nothing was pruned)'}` : `not restored: ${result.reason}`);
    return result.ok ? 0 : 1;
  }
  if (command === 'toolprune' && action === 'fold') {
    const summary = runFold({ dir, root, transcriptDir: claudeProjectDir(root), currentSession: null });
    console.log(JSON.stringify(summary, null, 2));
    return 0;
  }
  if (command !== 'status' && command !== 'toolprune' && command !== 'statusline') {
    console.error(`unknown command: ${command}`);
    return 2;
  }
  const status = collectStatus(args.cwd);
  console.log(args.json ? JSON.stringify(command === 'toolprune' ? status.toolprune : status, null, 2) : renderStatus(status));
  return 0;
}

// Run only as a command, so tests can import the installers without a process exit.
// realpath, because a global install on POSIX runs this through a bin symlink.
const realArg = (() => {
  try {
    return realpathSync(resolvePath(process.argv[1] || ''));
  } catch {
    return resolvePath(process.argv[1] || '');
  }
})();
const invoked = Boolean(process.argv[1]) && realpathSync(fileURLToPath(import.meta.url)).toLowerCase() === realArg.toLowerCase();
if (invoked) main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error) => {
    console.error(error?.message || String(error));
    process.exit(1);
  }
);
