/**
 * THE SUBSCRIPTION METER, READ RATHER THAN MODELLED.
 *
 * Every cost number this project has published so far was a MODEL of what a
 * subscription charges: a local tokeniser, and three multipliers copied off a
 * price list (`bench/compression/cost-model.mjs`). No part of it had ever been
 * compared against the thing it claims to predict.
 *
 * It does not have to be modelled. Anthropic exposes the meter that a Claude
 * subscription is actually rationed by:
 *
 *     GET https://api.anthropic.com/api/oauth/usage
 *     anthropic-beta: oauth-2025-04-20
 *     Authorization: Bearer <oauth access token>
 *
 * and it answers with the live utilisation of each rolling window.
 *
 * WHAT THE ANSWER CONTAINS, AND WHAT IT DOES NOT. On a Max plan the dollar
 * fields (`limit_dollars`, `used_dollars`, `remaining_dollars`) come back null,
 * and `limits[].percent` is an INTEGER. So the ground truth available to us is
 * a percentage at 1% granularity and nothing finer. That is the single most
 * important property of this instrument and every consumer has to respect it:
 *
 *   - One reading is not a measurement of anything small. A workload that moves
 *     a five-hour window by less than a percent is INVISIBLE here, however
 *     precisely we counted its tokens.
 *   - A reading of `16` means "at least 16 and less than 17". `calibrate.mjs`
 *     treats every observation as that interval, not as the number 16, because
 *     fitting weights to a rounded value and reporting a tight residual would
 *     be inventing precision the endpoint never offered.
 *
 * NO QUOTA IS SPENT BY READING THIS. It is a GET against a usage endpoint; it
 * is not an inference request and does not consume the window it reports. That
 * is what makes it safe to sample often, which is the only way to get enough
 * observations to solve for anything.
 *
 * THE TOKEN IS THE USER'S OWN, AND IT GOES ONLY TO ITS OWN ISSUER. This file
 * reads the credential Claude Code already stores and sends it to the Anthropic
 * endpoint that minted it. It must never be written to a log, a record, or any
 * other host -- `snapshot()` returns the response body and nothing else.
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const BETA_HEADER = 'oauth-2025-04-20';

/** Windows this project reasons about, and how long each one runs. */
export const WINDOWS = Object.freeze({
  five_hour: { seconds: 5 * 60 * 60, label: '5h' },
  seven_day: { seconds: 7 * 24 * 60 * 60, label: '7d' },
});

/**
 * The OAuth access token, in the same precedence order Claude Code uses.
 *
 * `CLAUDE_CONFIG_DIR` is honoured because a machine with a relocated config
 * would otherwise silently fall back to a stale token in the default location,
 * and a stale token fails as a 401 rather than as an obviously wrong answer.
 */
export function readOAuthToken() {
  const fromEnv = (process.env.CLAUDE_CODE_OAUTH_TOKEN ?? '').trim();
  if (fromEnv) return { token: fromEnv, source: 'CLAUDE_CODE_OAUTH_TOKEN' };

  const dir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
  const path = join(dir, '.credentials.json');
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    throw new Error(
      `no OAuth token: set CLAUDE_CODE_OAUTH_TOKEN, or log in so that ` +
        `${path} exists (${error.code ?? error.message})`
    );
  }

  const oauth = JSON.parse(raw)?.claudeAiOauth ?? {};
  const token = (oauth.accessToken ?? '').trim();
  if (!token) throw new Error(`no claudeAiOauth.accessToken in ${path}`);

  // EXPIRY IS REPORTED, NOT ENFORCED. A token that expired a minute ago still
  // often works, and refusing locally would turn a recoverable 401 into a hard
  // stop with no diagnosis. The caller gets the fact and decides.
  const expiresAt =
    typeof oauth.expiresAt === 'number' ? new Date(oauth.expiresAt) : null;
  return {
    token,
    source: path,
    expiresAt,
    expired: expiresAt ? expiresAt.getTime() < Date.now() : null,
    subscriptionType: oauth.subscriptionType ?? null,
    rateLimitTier: oauth.rateLimitTier ?? null,
  };
}

/**
 * One reading of the meter.
 *
 * Returns `{ at, raw, windows }` where `at` is the local clock at the moment of
 * the read and `windows` is the subset this project uses, normalised. `raw` is
 * kept whole because the endpoint carries fields that are null on this plan but
 * are not null on others, and a record that dropped them could not later be
 * re-analysed for a plan we have not seen.
 */
export async function snapshot({ token } = {}) {
  const auth = token ? { token, source: 'argument' } : readOAuthToken();

  const response = await fetch(USAGE_URL, {
    headers: {
      authorization: `Bearer ${auth.token}`,
      'anthropic-beta': BETA_HEADER,
      accept: 'application/json',
    },
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(
      `usage endpoint ${response.status}: ${body.slice(0, 300)}` +
        (response.status === 401 ? ' (token expired? re-run `claude` to refresh)' : '')
    );
  }

  const raw = await response.json();
  const at = new Date();

  const windows = {};
  for (const [key, spec] of Object.entries(WINDOWS)) {
    const entry = raw?.[key];
    if (!entry) continue;
    const resetsAt = entry.resets_at ? new Date(entry.resets_at) : null;
    windows[key] = {
      // THE INTEGER IS THE MEASUREMENT. `utilization` arrives as a float that
      // is always whole (16.0, 23.0) and `limits[].percent` as the same value
      // typed as an int. Both are the SAME rounded quantity, so this records
      // the bracket it implies rather than pretending to the decimal.
      percent: Math.round(Number(entry.utilization ?? 0)),
      percentLow: Math.round(Number(entry.utilization ?? 0)),
      percentHigh: Math.round(Number(entry.utilization ?? 0)) + 1,
      resetsAt: resetsAt ? resetsAt.toISOString() : null,
      // The window is a fixed-duration block ending at `resets_at`, so this is
      // the timestamp a transcript record must be at or after to be inside it.
      startsAt: resetsAt
        ? new Date(resetsAt.getTime() - spec.seconds * 1000).toISOString()
        : null,
      secondsToReset: resetsAt
        ? Math.max(0, Math.round((resetsAt.getTime() - at.getTime()) / 1000))
        : null,
      lockedReason: entry.locked_reason ?? null,
      // Null on Max, non-null on plans that expose a dollar cap. Carried so a
      // record taken on such a plan needs no second pass to be useful.
      limitDollars: entry.limit_dollars ?? null,
      usedDollars: entry.used_dollars ?? null,
    };
  }

  return { at: at.toISOString(), windows, raw };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const auth = readOAuthToken();
  const shot = await snapshot();
  const parts = [`token from ${auth.source}`];
  if (auth.subscriptionType) parts.push(`plan ${auth.subscriptionType}`);
  if (auth.rateLimitTier) parts.push(`tier ${auth.rateLimitTier}`);
  if (auth.expired) parts.push('EXPIRED');
  console.log(parts.join('  '));
  console.log(`read at ${shot.at}`);
  for (const [key, w] of Object.entries(shot.windows)) {
    const mins = w.secondsToReset === null ? '?' : Math.round(w.secondsToReset / 60);
    console.log(
      `  ${WINDOWS[key].label.padEnd(3)} ${String(w.percent).padStart(3)}%  ` +
        `[${w.percentLow}, ${w.percentHigh})  resets in ${mins}m  ` +
        `window ${w.startsAt} .. ${w.resetsAt}`
    );
  }
}
