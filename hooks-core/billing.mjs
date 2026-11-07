/**
 * Which way the person pays, and therefore what "cheaper" means for them.
 *
 * TWO DIFFERENT OBJECTIVES. An API user pays per token, so the thing to
 * minimise is cache-aware dollars per finished task: a cached re-read at 0.1x,
 * a rewrite at 1.25x, output at 5x. A subscription user pays a flat fee and is
 * limited by a rolling quota (Claude's 5-hour and weekly windows, Codex's plan
 * limits, Copilot's premium requests), so the thing to maximise is finished
 * work per unit of quota -- and a turn that loops burns quota with nothing to
 * show, which is the most expensive thing that can happen to them.
 *
 * Competing cost controllers price everything at API list prices whatever the
 * person pays with. That reports a dollar saving to someone who was never
 * going to be billed a dollar, and it misses the quota they actually run out of.
 *
 * WHAT THIS READS, AND WHAT IT REFUSES TO READ. Only environment variables and
 * one non-secret field: `oauthAccount.billingType` in `~/.claude.json`, which
 * Claude Code writes beside the account's display metadata. Credential files
 * (`~/.claude/.credentials.json`, `~/.codex/auth.json`) hold live tokens and
 * are never opened -- a cost optimizer has no business holding a credential,
 * even transiently, and the environment answers the question without them.
 *
 * `TOKEN_OPTIMIZER_BILLING=subscription|api|auto` always wins, so a machine
 * whose signals are misleading (an exported API key the client ignores, say)
 * is one setting away from the right objective.
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Objective per mode: what a saving is measured in, and what is reported. */
export const OBJECTIVES = Object.freeze({
  api: Object.freeze({
    mode: 'api',
    unit: 'cache-aware dollars per task',
    // A model call the optimizer makes on its own behalf is billed money.
    judgeCallsBilled: true,
  }),
  subscription: Object.freeze({
    mode: 'subscription',
    unit: 'finished work per unit of quota',
    // Billed against the same quota the person's work draws from.
    judgeCallsBilled: true,
  }),
  unknown: Object.freeze({
    mode: 'unknown',
    unit: 'billed-token equivalents',
    judgeCallsBilled: true,
  }),
});

const set = (value) => typeof value === 'string' && value.trim() !== '';
const truthy = (value) => /^(1|true|yes|on)$/i.test(String(value ?? '').trim());

/** The explicit override, or null when unset, `auto`, or not a known mode. */
export function billingOverride(env = process.env) {
  const value = String(env.TOKEN_OPTIMIZER_BILLING ?? '').trim().toLowerCase();
  return value === 'subscription' || value === 'api' ? value : null;
}

function readClaudeBillingType(home) {
  try {
    const parsed = JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8'));
    const value = parsed?.oauthAccount?.billingType;
    return typeof value === 'string' ? value : null;
  } catch {
    return null;
  }
}

function claudeMode(env, home) {
  if (truthy(env.CLAUDE_CODE_USE_BEDROCK)) return { mode: 'api', source: 'env:CLAUDE_CODE_USE_BEDROCK' };
  if (truthy(env.CLAUDE_CODE_USE_VERTEX)) return { mode: 'api', source: 'env:CLAUDE_CODE_USE_VERTEX' };
  if (truthy(env.CLAUDE_CODE_USE_FOUNDRY)) return { mode: 'api', source: 'env:CLAUDE_CODE_USE_FOUNDRY' };
  if (set(env.ANTHROPIC_AUTH_TOKEN)) return { mode: 'api', source: 'env:ANTHROPIC_AUTH_TOKEN' };
  const billingType = readClaudeBillingType(home);
  // An OAuth login is what makes a subscription; an exported API key next to
  // one is commonly left over from other tools, so the login wins. A machine
  // with a key and no login is an API user.
  if (billingType && /subscription/i.test(billingType)) {
    return { mode: 'subscription', source: `claude.json:${billingType}` };
  }
  if (set(env.ANTHROPIC_API_KEY)) return { mode: 'api', source: 'env:ANTHROPIC_API_KEY' };
  if (billingType) return { mode: 'api', source: `claude.json:${billingType}` };
  return { mode: 'unknown', source: 'no-signal' };
}

function codexMode(env) {
  if (set(env.CODEX_API_KEY)) return { mode: 'api', source: 'env:CODEX_API_KEY' };
  if (set(env.OPENAI_API_KEY) && !truthy(env.CODEX_CHATGPT_LOGIN)) {
    return { mode: 'api', source: 'env:OPENAI_API_KEY' };
  }
  return { mode: 'unknown', source: 'no-signal' };
}

function copilotMode(env) {
  // Copilot with your own model key (COPILOT_PROVIDER_*) bills that provider.
  if (set(env.COPILOT_PROVIDER_BASE_URL) || set(env.COPILOT_PROVIDER_API_KEY)) {
    return { mode: 'api', source: 'env:COPILOT_PROVIDER_*' };
  }
  return { mode: 'subscription', source: 'copilot-plan' };
}

function geminiMode(env) {
  if (truthy(env.GOOGLE_GENAI_USE_VERTEXAI)) return { mode: 'api', source: 'env:GOOGLE_GENAI_USE_VERTEXAI' };
  if (set(env.GEMINI_API_KEY)) return { mode: 'api', source: 'env:GEMINI_API_KEY' };
  if (set(env.GOOGLE_API_KEY)) return { mode: 'api', source: 'env:GOOGLE_API_KEY' };
  return { mode: 'subscription', source: 'google-login' };
}

/**
 * How this client is paid for.
 *
 * @param {{client?: string, env?: object, home?: string, codexPlan?: string|null}} [options]
 *   `codexPlan` is the `rate_limits.plan_type` a Codex rollout reports, when the
 *   caller has one; it is the only first-party Codex signal and it is not secret.
 * @returns {{mode: 'subscription'|'api'|'unknown', source: string, objective: object}}
 */
export function billingMode({ client = 'claude-code', env = process.env, home = homedir(), codexPlan = null } = {}) {
  const forced = billingOverride(env);
  let result;
  if (forced) {
    result = { mode: forced, source: 'env:TOKEN_OPTIMIZER_BILLING' };
  } else if (client === 'claude-code') {
    result = claudeMode(env, home);
  } else if (client === 'codex') {
    result = codexPlan
      ? { mode: /api/i.test(codexPlan) ? 'api' : 'subscription', source: `codex-plan:${codexPlan}` }
      : codexMode(env);
  } else if (client === 'copilot' || client === 'copilot-cli') {
    result = copilotMode(env);
  } else if (client === 'gemini' || client === 'gemini-cli') {
    result = geminiMode(env);
  } else {
    result = { mode: 'unknown', source: 'unsupported-client' };
  }
  return { ...result, objective: OBJECTIVES[result.mode] };
}

/** One human line for status output; never injected into the model's context. */
export function describeBilling(result) {
  if (!result) return 'billing: unknown';
  return `billing: ${result.mode} (${result.source}) -- optimizing ${result.objective.unit}`;
}
