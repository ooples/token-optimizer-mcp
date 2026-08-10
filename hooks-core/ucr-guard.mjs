import {
  appendFileSync,
  existsSync,
  readFileSync,
  statSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';

const MAX_INDEX_BYTES = 1_000_000;

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function digest(value) {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

function indexRoot() {
  return process.env.TOKEN_OPTIMIZER_UCR_DIR
    ? resolve(process.env.TOKEN_OPTIMIZER_UCR_DIR)
    : resolve(process.cwd(), '.token-optimizer', 'ucr');
}

export function loadActiveUcrGuards() {
  const path = join(indexRoot(), 'active-guards.json');
  if (!existsSync(path) || statSync(path).size > MAX_INDEX_BYTES) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    const { indexHash, ...body } = parsed;
    if (parsed.schemaVersion !== 'ucr.active-guards/1') return [];
    if (digest(body) !== indexHash) return [];
    return Array.isArray(parsed.guards)
      ? parsed.guards.filter(
          (guard) => guard?.id && guard.state === 'active' && guard.scope
        )
      : [];
  } catch {
    return [];
  }
}

function valueAtPath(value, field) {
  return String(field || '')
    .split('.')
    .filter(Boolean)
    .reduce((current, key) => current?.[key], value);
}

function conditionMatches(condition, action) {
  const actual = valueAtPath(action, condition.field);
  const expected = condition.value;
  if (condition.operator === 'equals') return actual === expected;
  if (condition.operator === 'contains')
    return String(actual || '').includes(String(expected));
  if (condition.operator === 'startsWith')
    return String(actual || '').startsWith(String(expected));
  if (condition.operator === 'in')
    return Array.isArray(expected) && expected.includes(actual);
  if (condition.operator === 'matches') {
    try {
      return new RegExp(String(expected), condition.flags || '').test(
        String(actual || '')
      );
    } catch {
      return false;
    }
  }
  return false;
}

function scoped(guard, context) {
  for (const field of ['taskId', 'projectId', 'workspaceId']) {
    if (guard.scope?.[field] && guard.scope[field] !== context?.[field])
      return false;
  }
  return true;
}

function audit(record) {
  try {
    appendFileSync(
      join(indexRoot(), 'guard-audit.jsonl'),
      `${JSON.stringify(record)}\n`,
      { encoding: 'utf8', mode: 0o600 }
    );
  } catch {
    // Guard enforcement remains useful even when optional audit persistence is
    // unavailable. The materialized index itself is never modified here.
  }
}

export function evaluateUcrGuards(payload, paths = []) {
  const context = {
    taskId: process.env.TOKEN_OPTIMIZER_TASK_ID || null,
    projectId: process.env.TOKEN_OPTIMIZER_PROJECT_ID || null,
    workspaceId: process.env.TOKEN_OPTIMIZER_WORKSPACE_ID || null,
  };
  const candidates = [
    payload?.tool_input || {},
    ...paths.map((path) => ({ ...(payload?.tool_input || {}), path })),
  ];
  for (const guard of loadActiveUcrGuards()) {
    if (!scoped(guard, context)) continue;
    const matched = candidates.some((action) =>
      guard.triggers.every((condition) => conditionMatches(condition, action))
    );
    if (!matched) continue;
    const record = {
      at: Date.now(),
      guardId: guard.id,
      taskId: context.taskId,
      toolName: payload?.tool_name || null,
      actionHash: digest({ tool: payload?.tool_name, input: payload?.tool_input }),
      decision: 'deny',
      executed: false,
    };
    audit(record);
    return {
      key: `ucr-guard:${guard.id}:${record.actionHash}`,
      guardId: guard.id,
      reason: [
        'Verified prior correction blocked this repeated action before execution.',
        `Use instead: ${JSON.stringify(guard.replacementAction)}`,
        `Evidence: ${(guard.evidence || []).join(', ')}`,
      ].join(' '),
      replacementAction: guard.replacementAction,
      persistent: true,
    };
  }
  return null;
}
