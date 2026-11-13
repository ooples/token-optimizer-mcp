#!/usr/bin/env node
/**
 * PreToolUse for Agent/Task: say what the spawn will cost before it happens, and
 * ask the agent for a short report (lib/agent-spawn.mjs, #567).
 *
 * The prompt is rewritten through `updatedInput`, which Claude Code applies only
 * beside a permission decision. `allow` is used because the Agent tool needs no
 * permission in Claude Code's default rules, so the decision changes nothing but
 * the prompt. Users who gate Agent behind a rule, or want the prompt untouched,
 * set TOKEN_OPTIMIZER_AGENT_REPORT_BUDGET=off and TOKEN_OPTIMIZER_AGENT_DIGEST=off
 * (the shared briefing); the hook then rewrites nothing and only ever adds context. A fork is refused only in enforce mode.
 *
 * Fail open: any error prints nothing, and the agent starts exactly as asked.
 */
import { readFileSync } from 'node:fs';
import {
  BATCH_ADVISE,
  DEFAULT_AGENT_BASE,
  parentState,
  planSpawn,
  recordSpawn,
  saveSpawnState,
} from '../lib/agent-spawn.mjs';
import { sessionStartedAt } from '../lib/agent-brief.mjs';
import { agentOverhead, readLedger } from '../lib/agent-ledger.mjs';
import { mode } from '../lib/policy.mjs';

try {
  const current = mode();
  if (current !== 'off') {
    const handed = globalThis.__tokenOptimizerStdin;
    const payload = JSON.parse((handed ? handed.raw : readFileSync(0, 'utf8')) || '{}');
    const tool = payload.tool_name ?? payload.toolName;
    const input = payload.tool_input ?? payload.toolInput;
    if ((tool === 'Agent' || tool === 'Task') && input && typeof input === 'object') {
      const transcript = payload.transcript_path ?? payload.transcriptPath;
      const state = parentState(transcript, payload.tool_use_id ?? payload.toolUseId);
      const { contextTokens, found, model } = state;
      // The transcript sees a batch only when the client wrote its calls before
      // the hook ran; Claude Code does not, so the session's spawn record counts
      // the burst instead, and the batch note speaks once it reaches the threshold.
      const sessionId = payload.session_id ?? payload.sessionId;
      const spawn = recordSpawn(sessionId);
      const fromRecord = state.batch <= 1 && spawn !== null;
      const measured = agentOverhead(readLedger()).medianBase;
      const plan = planSpawn({
        input,
        contextTokens,
        batch: fromRecord ? spawn.burst : state.batch,
        first: fromRecord ? spawn.burst === 1 : state.first,
        batchSpeaks: fromRecord ? spawn.burst === BATCH_ADVISE : null,
        routedNoted: spawn?.routedNoted === true,
        found,
        parentModel: model,
        agentBase: measured > 0 ? measured : DEFAULT_AGENT_BASE,
        sessionStart: sessionStartedAt(transcript),
        ...(typeof payload.cwd === 'string' && payload.cwd ? { cwd: payload.cwd } : {}),
      });
      if (plan.routedNote && spawn) {
        try {
          saveSpawnState(sessionId, { ...spawn, routedNoted: true });
        } catch {
          /* the note is said again next time; the spawn itself is unaffected */
        }
      }
      const out = { hookEventName: 'PreToolUse' };
      if (plan.deny) {
        out.permissionDecision = 'deny';
        out.permissionDecisionReason = plan.deny;
      } else if (plan.updatedInput) {
        out.permissionDecision = 'allow';
        out.updatedInput = plan.updatedInput;
      }
      if (plan.context && !plan.deny) out.additionalContext = plan.context;
      if (Object.keys(out).length > 1) process.stdout.write(`${JSON.stringify({ hookSpecificOutput: out })}\n`);
    }
  }
} catch {
  // Fail open: the agent starts exactly as asked.
}
