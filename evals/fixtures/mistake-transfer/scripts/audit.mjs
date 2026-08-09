import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function audit(event) {
  const path = process.env.TOKEN_OPTIMIZER_EVAL_AUDIT;
  if (!path) return;
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify({ at: Date.now(), ...event })}\n`);
}
