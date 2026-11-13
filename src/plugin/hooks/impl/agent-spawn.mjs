#!/usr/bin/env node
/**
 * PreToolUse for Agent/Task: say what the spawn will cost before it happens, and
 * ask the agent for a short report (lib/agent-spawn.mjs, #567).
 *
 * The prompt is rewritten through `updatedInput`, which Claude Code applies only
 * beside a permission decision. `allow` is used because the Agent tool needs no
 * permission in Claude Code's default rules, so the decision changes nothing but
 * the prompt. Users who gate Agent behind a rule, or want the prompt untouched,
 * set TOKEN_OPTIMIZER_AGENT_REPORT_BUDGET=off; the hook then rewrites nothing and
 * only ever adds context. A fork is refused only in enforce mode.
 *
 * Fail open: any error prints nothing, and the agent starts exactly as asked.
 */
import { readFileSync } from 'node:fs';
import { DEFAULT_AGENT_BASE, parentState, planSpawn } from '../lib/agent-spawn.mjs';
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
      const { contextTokens, batch, first } = parentState(
        payload.transcript_path ?? payload.transcriptPath,
        payload.tool_use_id ?? payload.toolUseId
      );
      const measured = agentOverhead(readLedger()).medianBase;
      const plan = planSpawn({
        input,
        contextTokens,
        batch,
        first,
        agentBase: measured > 0 ? measured : DEFAULT_AGENT_BASE,
        mode: current,
      });
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
