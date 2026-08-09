import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function audit(event) {
  const path = process.env.TOKEN_OPTIMIZER_EVAL_AUDIT;
  if (!path) return;
  const writerId = process.env.TOKEN_OPTIMIZER_EVAL_WRITER_ID;
  const scenarioId = process.env.TOKEN_OPTIMIZER_EVAL_SCENARIO_ID;
  const phase = process.env.TOKEN_OPTIMIZER_EVAL_PHASE;
  if (!writerId || !scenarioId || !phase) {
    throw new Error('evaluation audit requires writer, scenario, and phase provenance');
  }
  mkdirSync(dirname(path), { recursive: true });
  // Runner-owned provenance and time are authoritative. Fixture code must not
  // be able to spoof another writer or move an event across the causal order.
  appendFileSync(path, `${JSON.stringify({
    ...event,
    writerId,
    scenarioId,
    phase,
    at: Date.now(),
  })}\n`);
}
