#!/usr/bin/env node
/**
 * SubagentStop: record what the finished agent cost, and set the subagent cache
 * TTL tier when this machine's own agents show 1h is cheaper (lib/agent-ledger.mjs).
 *
 * One transcript read per finished agent -- the agent's own, bounded -- never a
 * scan of the session. Prints nothing: any output from a SubagentStop hook can
 * keep the agent running, and this hook must never change what an agent does.
 * Every failure is swallowed; the ledger is evidence, not a dependency.
 */
import { readFileSync } from 'node:fs';
import { agentRow, applySubagentTtl, recordAgent } from '../lib/agent-ledger.mjs';
import { claudeSettingsPath } from '../lib/install-health.mjs';
import { mode } from '../lib/policy.mjs';
import { agentTranscriptFor, tallyFile } from '../lib/subagents.mjs';

try {
  if (mode() !== 'off') {
    const handed = globalThis.__tokenOptimizerStdin;
    const payload = JSON.parse((handed ? handed.raw : readFileSync(0, 'utf8')) || '{}');
    const path = agentTranscriptFor(payload);
    const tally = path ? tallyFile(path) : null;
    if (tally?.turns) {
      recordAgent(
        agentRow(tally, {
          sessionId: payload.session_id ?? payload.sessionId ?? null,
          agentId: payload.agent_id ?? payload.agentId ?? null,
        })
      );
      applySubagentTtl(claudeSettingsPath());
    }
  }
} catch {
  // Fail open and silent: see above.
}
