// GENERATED FILE -- do not edit.
// Source of truth: src/hooks-core/quota-policy.mjs. Regenerate with `npm run sync:hooks`.
/**
 * What a subscription user's leftover quota is for, decided from real usage.
 *
 * A flat-rate plan has two limits that matter: Claude's 5-hour rolling window,
 * and a weekly limit that every window draws from. The pacer in quota-pacer.mjs
 * spends capacity a window would otherwise let expire -- it continues an agent
 * that stopped with unverified edits. Pacing on the 5-hour window alone is a
 * trap: capacity "left over" today is capacity taken from later in the week,
 * and the weekly limit is the one people actually run out of.
 *
 * So pacing is WEEKLY-AWARE. It continues only when BOTH hold:
 *
 *   * the 5-hour window has room (under `FIVE_HOUR_CEILING` percent used), and
 *   * the week is on or under pace: weekly percent used is no more than the
 *     share of the week already elapsed (plus `WEEKLY_SLACK` points). A week
 *     that is 40% gone with 35% used has room; one with 55% used does not.
 *
 * The numbers are Claude Code's own: its status-line payload carries
 * `rate_limits.five_hour` and `rate_limits.seven_day` (`used_percentage`,
 * `resets_at`), verified on 2.1.319. Hooks do not receive them, so the status
 * line tap (src/scripts/statusline-tap.mjs) records them to a local file. No data,
 * or data older than `MAX_AGE_MS`, means no pacing: the policy falls back to
 * suggesting, never to guessing.
 *
 * Policies (TOKEN_OPTIMIZER_SUBSCRIPTION_POLICY):
 *   pace         default. Weekly-aware pacing when the usage data allows it:
 *                backlog continuations only.
 *   pace-verify  pace, plus one "verify your edits" continuation per session.
 *                Opt-in: in a 15-pair learned SWE-bench pilot it fired in 8 of
 *                13 sessions, added 33% turns and 29% cost, and changed no
 *                outcome (12/15 resolved in both arms, the same twelve).
 *   suggest  never paces; status names the option.
 *   report   never paces and says nothing about it.
 * TOKEN_OPTIMIZER_MAXIMIZE_SUBSCRIPTION=1 remains the explicit override that
 * paces regardless of these limits, as it always has.
 */

import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { billingMode } from './billing.mjs';
import { writeAtomically } from './policy.mjs';
import { stateRoot } from './runtime-switch.mjs';

export const SUBSCRIPTION_POLICIES = Object.freeze(['pace', 'pace-verify', 'suggest', 'report']);
/** The policies that pace at all. */
const PACING = new Set(['pace', 'pace-verify']);
export const RATE_LIMITS_FILE = 'rate-limits.json';
export const MAX_AGE_MS = 15 * 60 * 1000;
export const FIVE_HOUR_CEILING = 90;
export const WEEKLY_SLACK = 2;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export function subscriptionPolicy(env = process.env) {
  const value = String(env.TOKEN_OPTIMIZER_SUBSCRIPTION_POLICY ?? '').trim().toLowerCase();
  return SUBSCRIPTION_POLICIES.includes(value) ? value : 'pace';
}

export function rateLimitsPath(env = process.env) {
  return join(stateRoot(env), RATE_LIMITS_FILE);
}

const percent = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
};

/** `resets_at` arrives as epoch seconds; accept milliseconds and ISO text too. */
function epochMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value < 1e12 ? value * 1000 : value;
  const parsed = Date.parse(String(value ?? ''));
  return Number.isFinite(parsed) ? parsed : null;
}

/** Normalise a status-line payload's `rate_limits` into what pacing needs. */
export function normalizeRateLimits(rateLimits) {
  if (!rateLimits || typeof rateLimits !== 'object') return null;
  const window = (entry) =>
    entry && typeof entry === 'object'
      ? { used: percent(entry.used_percentage), resetsAt: epochMs(entry.resets_at) }
      : null;
  const fiveHour = window(rateLimits.five_hour);
  const sevenDay = window(rateLimits.seven_day);
  if (!fiveHour && !sevenDay) return null;
  return { fiveHour, sevenDay };
}

/** Called by the status-line tap with the payload Claude Code hands it. */
export function recordRateLimits(payload, { now = Date.now(), env = process.env } = {}) {
  const limits = normalizeRateLimits(payload?.rate_limits);
  if (!limits) return false;
  try {
    mkdirSync(stateRoot(env), { recursive: true, mode: 0o700 });
    writeAtomically(rateLimitsPath(env), JSON.stringify({ ...limits, at: now }));
    return true;
  } catch {
    return false;
  }
}

export function readRateLimits({ now = Date.now(), env = process.env, maxAgeMs = MAX_AGE_MS } = {}) {
  try {
    const parsed = JSON.parse(readFileSync(rateLimitsPath(env), 'utf8'));
    if (!parsed || typeof parsed.at !== 'number' || now - parsed.at > maxAgeMs) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Whether usage leaves room to spend, and why not when it does not.
 * @returns {{ok: boolean, reason: string, weekElapsedPct?: number}}
 */
export function quotaHeadroom(limits, { now = Date.now() } = {}) {
  if (!limits) return { ok: false, reason: 'no recent usage data (install the status line tap)' };
  const five = limits.fiveHour;
  if (!five || five.used == null) return { ok: false, reason: '5-hour usage unknown' };
  if (five.used >= FIVE_HOUR_CEILING) return { ok: false, reason: `5-hour window ${five.used}% used` };
  const week = limits.sevenDay;
  if (!week || week.used == null || !week.resetsAt) return { ok: false, reason: 'weekly usage unknown' };
  const remaining = Math.min(WEEK_MS, Math.max(0, week.resetsAt - now));
  const elapsedPct = (1 - remaining / WEEK_MS) * 100;
  if (week.used > elapsedPct + WEEKLY_SLACK) {
    return { ok: false, reason: `week ${week.used}% used at ${Math.round(elapsedPct)}% elapsed`, weekElapsedPct: elapsedPct };
  }
  return { ok: true, reason: `5h ${five.used}%, week ${week.used}% at ${Math.round(elapsedPct)}% elapsed`, weekElapsedPct: elapsedPct };
}

/**
 * Whether the pacer may spend leftover capacity now, by policy.
 * @returns {{allowed: boolean, reason: string, policy: string, mode: string}}
 */
export function paceDecision({ client = 'claude-code', env = process.env, now = Date.now(), home } = {}) {
  const policy = subscriptionPolicy(env);
  const billing = billingMode({ client, env, ...(home ? { home } : {}) });
  if (billing.mode !== 'subscription') {
    return { allowed: false, reason: `billing is ${billing.mode}`, policy, mode: billing.mode };
  }
  if (!PACING.has(policy)) return { allowed: false, reason: `policy is ${policy}`, policy, mode: billing.mode };
  const headroom = quotaHeadroom(readRateLimits({ now, env }), { now });
  return { allowed: headroom.ok, reason: headroom.reason, policy, mode: billing.mode };
}

/** The compact quota line the status-line tap prints when it wraps nothing. */
export function quotaLine(payload, { now = Date.now() } = {}) {
  const limits = normalizeRateLimits(payload?.rate_limits);
  const model = payload?.model?.display_name ? `${payload.model.display_name} · ` : '';
  if (!limits) return `${model}token-optimizer`;
  const parts = [];
  if (limits.fiveHour?.used != null) parts.push(`5h ${Math.round(limits.fiveHour.used)}%`);
  if (limits.sevenDay?.used != null) {
    const headroom = quotaHeadroom(limits, { now });
    const pace = headroom.weekElapsedPct != null ? ` (pace ${Math.round(headroom.weekElapsedPct)}%)` : '';
    parts.push(`week ${Math.round(limits.sevenDay.used)}%${pace}`);
  }
  return `${model}${parts.join(' · ')}`;
}
