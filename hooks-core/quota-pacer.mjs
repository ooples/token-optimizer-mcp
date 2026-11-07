/**
 * Proactive Subscription Quota-Pacing & Multi-Repo Autonomous Queue Runner.
 *
 * Flat-rate AI coding subscriptions (Claude Max 5-hour rolling windows, ChatGPT
 * Pro, Gemini / Antigravity) reset capacity on fixed windows. When an agent
 * stops early with unverified edits, pending multi-repo backlog items, or an
 * unrun nightly verification sweep while rolling-window capacity remains, the
 * unused subscription allocation expires wasted.
 *
 * Opt-in environment controls:
 *   - TOKEN_OPTIMIZER_MAXIMIZE_SUBSCRIPTION=1
 *       Enables unverified-edit continuation, STOP_BACKLOG continuation, and
 *       rolling-window quota pacing.
 *   - TOKEN_OPTIMIZER_WINDOW_HOURS=5
 *       Rolling subscription window duration in hours (default: 5).
 *   - TOKEN_OPTIMIZER_REPO_QUEUE="pathA;pathB"
 *       Multi-repo autonomous backlog queue scanned for `- [ ]` tasks at Stop.
 *   - TOKEN_OPTIMIZER_NIGHTLY_SWEEP_CMD="npm test"
 *       Proactive verification/research sweep command executed once per session
 *       when rolling-window capacity remains at Stop.
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { writeAtomically } from './policy.mjs';
import { paceDecision } from './quota-policy.mjs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const stateRoot = () =>
  process.env.TOKEN_OPTIMIZER_STATE_DIR || join(tmpdir(), 'token-optimizer-hooks');

export function quotaWindowPath() {
  return join(stateRoot(), 'quota-window.json');
}

export function pacerEnabled(env = process.env) {
  return (
    /^(1|true|yes|on)$/i.test(
      String(env.TOKEN_OPTIMIZER_MAXIMIZE_SUBSCRIPTION ?? '').trim()
    ) ||
    Boolean(env.TOKEN_OPTIMIZER_STOP_BACKLOG) ||
    Boolean(env.TOKEN_OPTIMIZER_REPO_QUEUE) ||
    Boolean(env.TOKEN_OPTIMIZER_NIGHTLY_SWEEP_CMD)
  );
}

/**
 * Record tool activity into the current rolling subscription window.
 */
export function recordWindowActivity({ calls = 1, edits = 0, now = Date.now(), env = process.env } = {}) {
  const windowHours = Number(env.TOKEN_OPTIMIZER_WINDOW_HOURS) || 5;
  const windowMs = windowHours * 3600_000;
  const file = quotaWindowPath();
  let data = { windowStart: now, calls: 0, edits: 0 };
  try {
    if (existsSync(file)) {
      const parsed = JSON.parse(readFileSync(file, 'utf8'));
      if (parsed && typeof parsed.windowStart === 'number' && now - parsed.windowStart < windowMs) {
        data = parsed;
      }
    }
  } catch {
    // Fail open on corrupt window state.
  }
  data.calls = (Number(data.calls) || 0) + calls;
  data.edits = (Number(data.edits) || 0) + edits;
  data.lastActive = now;
  try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    writeAtomically(file, JSON.stringify(data));
  } catch {
    // Non-fatal.
  }
  const remainingMs = Math.max(0, data.windowStart + windowMs - now);
  return {
    ...data,
    windowHours,
    remainingMinutes: Math.round(remainingMs / 60_000),
  };
}

function candidateBacklogFiles(cwd, env = process.env) {
  const files = [];
  if (env.TOKEN_OPTIMIZER_STOP_BACKLOG) {
    files.push(resolve(cwd, env.TOKEN_OPTIMIZER_STOP_BACKLOG));
  }

  const queueRaw = String(env.TOKEN_OPTIMIZER_REPO_QUEUE ?? '').trim();
  const repoDirs = queueRaw
    ? queueRaw
        .split(/[;,]/)
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => resolve(cwd, s))
    : [];
  for (const repoDir of repoDirs) {
    files.push(join(repoDir, 'STOP_BACKLOG'));
    files.push(join(repoDir, '.token-optimizer', 'backlog.md'));
  }
  return [...new Set(files)];
}

/**
 * Determine the next autonomous continuation prompt at Stop, or null if none.
 */
export function nextPacedContinuation({ cwd, state, now = Date.now(), env = process.env, client = 'claude-code', home }) {
  // Explicit configuration paces as it always has. Otherwise a subscription
  // under the default `pace` policy paces only when real usage leaves room in
  // the 5-hour window AND the week (quota-policy.mjs).
  const explicit = pacerEnabled(env);
  const paced = explicit ? null : paceDecision({ client, env, now, home });
  if (!explicit && !paced.allowed) return null;
  const configuredLimit = Number(env.TOKEN_OPTIMIZER_MAX_CONTINUATIONS ?? 3);
  const maxCont = Number.isFinite(configuredLimit) ? Math.max(0, Math.floor(configuredLimit)) : 3;
  const status = recordWindowActivity({ calls: 0, edits: 0, now, env });
  const windowTag = paced
    ? `[quota: ${paced.reason}]`
    : `[window: ${status.calls} calls used, ${status.remainingMinutes}m until ${status.windowHours}h reset]`;

  // 1. Unverified edits gate
  const maximize = Boolean(paced?.allowed) || /^(1|true|yes|on)$/i.test(
    String(env.TOKEN_OPTIMIZER_MAXIMIZE_SUBSCRIPTION ?? '').trim()
  );
  const unverified = Number(state.edits || 0) > Number(state.verifiedEdits || 0);
  if (maximize && unverified && !state.verificationContinued) {
    state.verificationContinued = true;
    const recent = (state.editedFiles || []).slice(0, 5).join(', ');
    return `[token-optimizer subscription-maximizer] ${windowTag} ${state.edits} edit(s) were made in this session (${recent || 'files modified'}) without a subsequent passing test/build verification run. Run the project's test or build suite to verify your changes before stopping.`;
  }

  // 2. Multi-repo / local STOP_BACKLOG queue
  const usedCont = Number(state.backlogContinuations || 0);
  if (usedCont < maxCont) {
    for (const backlogPath of candidateBacklogFiles(cwd, env)) {
      if (!existsSync(backlogPath)) continue;
      try {
        const text = readFileSync(backlogPath, 'utf8');
        const nextTask = text
          .split(/\r?\n/)
          .map((l) => l.trim())
          .find((l) => /^[-*]\s+\[\s\]\s+.+/.test(l));
        if (nextTask) {
          state.backlogContinuations = usedCont + 1;
          return `[token-optimizer subscription-maximizer] ${windowTag} Pending backlog task (${usedCont + 1}/${maxCont}) in ${backlogPath}: ${nextTask}. Continue autonomous execution and mark the item [x] when complete.`;
        }
      } catch {
        // Ignore unreadable backlog file.
      }
    }
  }

  // 3. Proactive Nightly / Off-Peak Sweep Command
  const sweepCmd = String(env.TOKEN_OPTIMIZER_NIGHTLY_SWEEP_CMD ?? '').trim();
  if (sweepCmd && !state.nightlySweepContinued && usedCont < maxCont) {
    state.nightlySweepContinued = true;
    state.backlogContinuations = usedCont + 1;
    return `[token-optimizer subscription-maximizer] ${windowTag} Unused subscription window capacity available. Execute configured proactive sweep command: \`${sweepCmd}\` and report any failures.`;
  }

  return null;
}
