/**
 * Does removing reasoning from history change what the model DOES next?
 *
 * The last open question about `v4-substitute`, and the only one no offline
 * instrument can answer. Specified in
 * docs/superpowers/specs/2026-09-14-quality-preregistration.md BEFORE any
 * measurement; this file implements that spec and must not drift from it.
 *
 * THREE CALLS PER SAMPLED TURN, NOT TWO, and the third is the whole reason this
 * is interpretable:
 *
 *   control      the prefix the client would send
 *   substituted  the prefix the proxy would send
 *   control-B    the control prefix AGAIN
 *
 * control vs control-B is the FLOOR. Sampling alone produces divergence, so a
 * raw divergence rate means nothing until you know what it is when you change
 * nothing. Omitting that pair is how a behavioural A/B produces a confident
 * number about noise.
 *
 * ACTIONS COMPARED SEMANTICALLY, never textually: tool name, target (file path
 * or command), and whether the reply is terminal. Rewording is not divergence.
 * Fixed in the spec in advance, because "compare the replies" would otherwise be
 * decided after seeing how they differ.
 *
 * TOOLS ARE RECONSTRUCTED FROM THE CONVERSATION ITSELF. A history containing
 * `tool_use` with no matching definitions is rejected by the API, and inventing
 * a plausible tool schema per arm would be a difference between arms. So the
 * tool set is derived from the transcript's own calls, identically for every
 * arm, and is part of neither treatment.
 *
 * WHAT THIS CANNOT TELL YOU. Agreement is not correctness: both arms can take
 * the same wrong action. This detects CHANGE, never absolute quality. Only the
 * task benchmark speaks to outcome.
 *
 * Usage:
 *   node bench/compression/next-action-probe.mjs <transcript.jsonl> [more...]
 *
 *   TURNS=10        how many turns to sample (default 10 -- the dry run)
 *   TEMPERATURE=0   see the note on extended thinking below
 *   DRY=1           print the plan and the projected cost, send nothing
 *
 * Run `npm run build` first: this reads dist/.
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { substituteHistory } from '../../dist/compress/history.js';

const SAMPLES = Number(process.env.TURNS) > 0 ? Number(process.env.TURNS) : 10;
const DRY = /^(1|true|yes|on)$/i.test(process.env.DRY ?? '');
const TEMPERATURE =
  process.env.TEMPERATURE !== undefined ? Number(process.env.TEMPERATURE) : 0;
const MODEL = process.env.MODEL || 'claude-sonnet-4-6';

/**
 * Published per-million rates, for the cost line only.
 *
 * Reported so a run says what it cost rather than leaving it to be discovered
 * on an invoice -- the spec requires an exact per-sample price before any real
 * spend. Wrong rates make the COST report wrong; they cannot affect the
 * divergence verdict, which is counted from replies.
 */
const RATE = { input: 3, output: 15, write: 3.75, read: 0.3 };

/** Rebuild a WIRE-shaped conversation: consecutive same-role rows are one message. */
function messagesFrom(path) {
  const out = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    const m = row?.message;
    if (!m || (m.role !== 'assistant' && m.role !== 'user')) continue;
    if (!Array.isArray(m.content) || !m.content.length) continue;
    const last = out[out.length - 1];
    if (last && last.role === m.role) last.content.push(...m.content);
    else out.push({ role: m.role, content: [...m.content] });
  }
  return out;
}

/** Every tool the conversation actually called, with a permissive schema. */
function toolsFrom(messages) {
  const names = new Map();
  for (const m of messages) {
    if (!Array.isArray(m.content)) continue;
    for (const b of m.content) {
      if (b?.type !== 'tool_use' || typeof b.name !== 'string') continue;
      if (!names.has(b.name)) {
        const keys = Object.keys(b.input ?? {});
        names.set(b.name, {
          name: b.name,
          description: `Tool used earlier in this conversation.`,
          input_schema: {
            type: 'object',
            properties: Object.fromEntries(keys.map((k) => [k, {}])),
          },
        });
      }
    }
  }
  return [...names.values()];
}

/**
 * Length bands, and the share of the sample each one gets.
 *
 * Fixed in the pre-registration, not here, and copied across deliberately: the
 * document and the instrument disagreeing about the sample is the same class of
 * error as a benchmark arm calling a primitive instead of the shipped strategy.
 */
const BANDS = [
  { label: '1-24', min: 1, max: 24 },
  { label: '25-99', min: 25, max: 99 },
  { label: '100-299', min: 100, max: 299 },
  { label: '300+', min: 300, max: Infinity },
];

/**
 * The turns to sample: an equal quota from each length band.
 *
 * EQUAL PER BAND, NOT PROPORTIONAL, and not simply spread evenly across the
 * whole conversation. Divergence risk is stated to scale with length, so the
 * mix of lengths determines the measured rate -- an even spread over a
 * 400-turn session puts most samples in bands where the transform removes
 * little, and the same probe over a 40-turn session would then be measuring
 * something else entirely.
 *
 * Deterministic within a band (even intervals, no randomness), so a re-run
 * samples the same turns and two runs are comparable.
 *
 * A short band is reported short rather than back-filled from its neighbours,
 * because back-filling would silently re-weight the mix toward whichever band
 * happened to be long.
 */
function sampledCuts(messages, n) {
  const cuts = [];
  for (let i = 0; i < messages.length; i += 1) {
    // `turn` is the conversation turn this cut represents; `cut` is where to
    // slice `messages`. Carried together because the bands are defined on the
    // first and the slicing needs the second, and reporting one as the other
    // misstates the length mix the whole quota exists to control.
    if (messages[i].role === 'user') {
      cuts.push({ cut: i + 1, turn: cuts.length + 1 });
    }
  }

  const quota = Math.max(1, Math.floor(n / BANDS.length));
  const picked = [];
  const shortfall = [];

  BANDS.forEach((band, index) => {
    // A cut's band is decided by which TURN it is, not by its message index.
    const inBand = cuts.filter(
      (c) => c.turn >= band.min && c.turn <= band.max
    );
    if (!inBand.length) {
      shortfall.push(`${band.label}: none available`);
      return;
    }
    const take = Math.min(quota, inBand.length);
    if (take < quota) {
      shortfall.push(`${band.label}: ${take} of ${quota}`);
    }
    const step = inBand.length / take;
    for (let i = 0; i < take; i += 1) {
      picked.push(inBand[Math.floor(i * step)]);
    }
    void index;
  });

  return { cuts: picked, shortfall };
}

/**
 * A reply reduced to what it DID.
 *
 * Tool name plus the identifying argument, or the fact that it answered. This
 * is the unit of comparison, and it deliberately discards wording.
 */
function actionOf(content) {
  if (!Array.isArray(content)) return 'malformed';
  const calls = [];
  let text = false;
  for (const b of content) {
    if (b?.type === 'tool_use') {
      const input = b.input ?? {};
      const target =
        ['file_path', 'path', 'command', 'pattern', 'query']
          .map((k) => input[k])
          .find((v) => typeof v === 'string' && v.trim()) ?? '';
      // THE COMPLETE TARGET, never a prefix. Truncating here would make two
      // different commands or paths that share their first 80 characters
      // compare EQUAL, recording a real divergence as agreement -- an error in
      // the one direction that matters, since it hides the effect being
      // measured. Display is truncated separately at the print site.
      calls.push(`${b.name}(${target.replace(/\s+/g, ' ').trim()})`);
    } else if (b?.type === 'text' && b.text?.trim()) {
      text = true;
    }
  }
  if (calls.length) return calls.join(' | ');
  return text ? 'ANSWER' : 'empty';
}

/**
 * Two auth paths, because they have SEPARATE rate limits.
 *
 * ANTHROPIC_API_KEY wins when set. The subscription OAuth token is what a
 * developer has to hand and costs nothing extra, but its limit is shared with
 * every other Claude Code session on the account -- which is exactly what
 * stopped this probe's first run, with a bare 16-token request getting 429
 * alongside the 180,000-token ones. A key billed to the API account is not
 * subject to that, so the probe can run while ordinary work continues.
 */
function auth() {
  const key = (process.env.ANTHROPIC_API_KEY || '').trim();
  if (key) return { headers: { 'x-api-key': key }, kind: 'ANTHROPIC_API_KEY' };
  try {
    const creds = JSON.parse(
      readFileSync(join(homedir(), '.claude', '.credentials.json'), 'utf8')
    );
    const token = creds.claudeAiOauth?.accessToken;
    if (token) {
      return {
        headers: {
          authorization: `Bearer ${token}`,
          'anthropic-beta': 'oauth-2025-04-20',
        },
        kind: 'subscription OAuth (shared limit)',
      };
    }
  } catch {
    // Falls through to the error below, which names both options.
  }
  return null;
}

const AUTH = auth();
if (!AUTH && !DRY) {
  throw new Error(
    'no credentials: set ANTHROPIC_API_KEY, or sign in so ~/.claude/.credentials.json exists'
  );
}

/** Retry budget for a 429. Beyond this the run stops rather than grinding on. */
/**
 * Ceiling on a single request, so a stalled connection cannot hang the run.
 *
 * Generous, because a 180,000-token prefix legitimately takes a while to
 * process; the point is to bound a socket that has stopped responding, not to
 * hurry a slow request.
 */
const REQUEST_TIMEOUT_MS =
  Number(process.env.REQUEST_TIMEOUT_MS) > 0
    ? Number(process.env.REQUEST_TIMEOUT_MS)
    : 180_000;

const MAX_ATTEMPTS =
  Number(process.env.MAX_ATTEMPTS) > 0 ? Number(process.env.MAX_ATTEMPTS) : 5;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const cost = { write: 0, read: 0, input: 0, output: 0, calls: 0 };

/**
 * Mark the prefix cacheable, exactly where the client marks it.
 *
 * TWO REASONS, AND THE SECOND MATTERS MORE. Without a breakpoint nothing is
 * cached, so control-A and control-B -- byte-identical prefixes -- are each
 * billed in full, and a probe over 180,000-token prefixes becomes needlessly
 * expensive. With one, control-B is a 0.1x read.
 *
 * More importantly, production HAS a breakpoint: the client sets cache_control
 * on the last message, which `wire-shape.test.ts` pins. A probe without one
 * measures a request shape the product never sends, which is the mistake this
 * whole effort keeps rediscovering. Applied identically to every arm.
 */
function marked(messages) {
  if (!messages.length) return messages;
  const last = messages[messages.length - 1];
  if (!Array.isArray(last.content) || !last.content.length) return messages;
  const content = last.content.map((b, i) =>
    i === last.content.length - 1
      ? { ...b, cache_control: { type: 'ephemeral' } }
      : b
  );
  return [...messages.slice(0, -1), { ...last, content }];
}

/**
 * Everything a failed response can tell us, since the body tells us almost nothing.
 *
 * This provider's 429 body is {"type":"rate_limit_error","message":"Error"} --
 * no detail, no retry-after, no rate-limit headers. The first run reported that
 * as "HTTP 429 Error", which is indistinguishable from a bug in this file. The
 * request id is the one durable handle, so it is always carried.
 */
function describeFailure(res, text) {
  let detail = text.slice(0, 200);
  let requestId = res.headers.get('request-id') || '';
  try {
    const parsed = JSON.parse(text);
    detail = parsed.error?.message || detail;
    requestId = requestId || parsed.request_id || '';
  } catch {
    /* keep the raw body */
  }
  const retry = res.headers.get('retry-after');
  return (
    `HTTP ${res.status} ${res.statusText || ''} ${detail}` +
    (retry ? ` retry-after=${retry}` : '') +
    (requestId ? ` [${requestId}]` : '')
  );
}

async function ask(messages, tools) {
  const body = {
    model: MODEL,
    max_tokens: 1024,
    temperature: TEMPERATURE,
    messages: marked(messages),
    ...(tools.length ? { tools } : {}),
  };

  let last = '';
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    let res;
    let text;
    try {
      res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'anthropic-version': '2023-06-01',
          ...AUTH.headers,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      text = await res.text();
    } catch (err) {
      // A DNS failure, a TLS error, a socket reset or the timeout above. These
      // reject rather than returning a response, so without this they escape
      // the sampling loop and kill the run -- losing every sample already paid
      // for. Treated as a retryable failure like a 5xx, and on the last attempt
      // returned as an error so the no-verdict path reports it.
      last = `network: ${err?.name ?? 'Error'} ${err?.message ?? ''}`.trim();
      if (attempt === MAX_ATTEMPTS) return { error: last };
      await sleep(Math.min(60_000, 2 ** attempt * 1000) + Math.random() * 1000);
      continue;
    }

    if (res.ok) {
      const parsed = JSON.parse(text);
      const u = parsed.usage ?? {};
      cost.calls += 1;
      cost.write += u.cache_creation_input_tokens ?? 0;
      cost.read += u.cache_read_input_tokens ?? 0;
      cost.input += u.input_tokens ?? 0;
      cost.output += u.output_tokens ?? 0;
      return { action: actionOf(parsed.content) };
    }

    last = describeFailure(res, text);

    // RETRY ONLY WHAT RETRYING CAN FIX. A 429 or a 5xx may pass on a second
    // attempt; a 400 is a malformed request and will be malformed forever, so
    // retrying it burns the budget and hides the real error behind a delay.
    const worthRetrying = res.status === 429 || res.status >= 500;
    if (!worthRetrying || attempt === MAX_ATTEMPTS) return { error: last };

    // Honour the server's own figure when it gives one; otherwise exponential
    // with jitter, so several stalled calls do not resume in lockstep and
    // re-trigger the same limit together.
    const stated = Number(res.headers.get('retry-after'));
    const wait =
      Number.isFinite(stated) && stated > 0
        ? stated * 1000
        : Math.min(60_000, 2 ** attempt * 1000) + Math.random() * 1000;
    process.stdout.write(
      `    ${res.status}, waiting ${(wait / 1000).toFixed(1)}s (attempt ${attempt}/${MAX_ATTEMPTS})
`
    );
    await sleep(wait);
  }
  return { error: last };
}

const dollars = () =>
  (cost.write * RATE.write +
    cost.read * RATE.read +
    cost.input * RATE.input +
    cost.output * RATE.output) /
  1_000_000;

const paths = process.argv.slice(2);
if (!paths.length) {
  console.error(
    'usage: node bench/compression/next-action-probe.mjs <transcript.jsonl> [...]'
  );
  process.exit(2);
}

/**
 * Is the account able to serve ANY request right now?
 *
 * ONE TINY CALL BEFORE THE RUN, and it exists because of how the first attempts
 * failed. A sustained account-level 429 is indistinguishable per-request from a
 * burst, so every sample entered the retry loop, waited out its backoff, failed,
 * and moved on -- a 4-turn run spent 30 seconds of sleeping to learn one fact it
 * could have learned in a single 16-token call.
 *
 * It also settles the question that matters for what to do next: a minimal
 * request failing rules out payload size, so the answer is wait or switch
 * credentials, never shrink the prefixes -- and shrinking them would destroy the
 * measurement, since removed reasoning accumulates with conversation length.
 *
 * Deliberately NOT retried. This is the check that decides whether retrying is
 * worth anything.
 */
async function preflight() {
  let res;
  try {
    res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01',
        ...AUTH.headers,
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 16,
        messages: [{ role: 'user', content: 'hi' }],
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    // An unreachable API is a reason to stop before the run, which is what
    // this function is for. Reported like any other preflight failure rather
    // than thrown out of a top-level await with a stack trace.
    return `network: ${err?.name ?? 'Error'} ${err?.message ?? ''}`.trim();
  }
  if (res.ok) return null;
  return describeFailure(res, await res.text());
}

// Say which credential is in use BEFORE spending anything. The two have
// separate limits and separate bills, and a run that silently used the wrong
// one is a result nobody can attribute.
if (!DRY) {
  console.log(
    `auth: ${AUTH.kind}   model: ${MODEL}   temperature: ${TEMPERATURE}`
  );
  const blocked = await preflight();
  if (blocked) {
    console.log(`\npreflight failed: ${blocked}`);
    console.log(
      '\nA 16-token request failed, so this is not about prefix size, and no ' +
        'amount of retrying or sampling smaller turns will help. Either the ' +
        'limit clears with time, or set ANTHROPIC_API_KEY, which is billed ' +
        'and limited separately from the subscription token.\n' +
        '\nNo samples were sent. Only the preflight request above was ' +
        'made, and there is no cost and no verdict.'
    );
    process.exit(4);
  }
}

let floorDiverged = 0;
let floorPairs = 0;
let subDiverged = 0;
let subPairs = 0;
let notFired = 0;
const failures = [];

for (const path of paths) {
  const messages = messagesFrom(path);
  const { cuts, shortfall } = sampledCuts(messages, SAMPLES);
  const name = path.split(/[\\/]/).pop();
  console.log(
    `\n${name}  --  ${messages.length} messages, sampling ${cuts.length} turn(s)`
  );
  // Reported, never silently absorbed: a band that could not be filled changes
  // the length mix, and the length mix is what the divergence rate depends on.
  if (shortfall.length) {
    console.log(`  bands under quota: ${shortfall.join(', ')}`);
  }

  for (const { cut, turn } of cuts) {
    const control = messages.slice(0, cut);
    const substitution = substituteHistory(control);
    const tools = toolsFrom(control);

    // FIRED-CHECK, before any result is read. A sample where the transform did
    // nothing is not evidence about the transform -- it is the control twice,
    // and counting it would dilute the divergence rate toward zero and flatter
    // the feature. Skipped and reported, never silently included.
    if (substitution.substituted === 0) {
      notFired += 1;
      continue;
    }

    if (DRY) {
      const chars = JSON.stringify(control).length;
      console.log(
        `  turn ${String(turn).padStart(4)}  ~${Math.round(chars / 4)} prefix tokens  x3 calls`
      );
      continue;
    }

    const a = await ask(control, tools);
    const b = await ask(control, tools);
    const s = await ask(substitution.messages, tools);

    for (const [label, r] of [
      ['control-A', a],
      ['control-B', b],
      ['substituted', s],
    ]) {
      if (r.error) failures.push(`turn ${turn} ${label}: ${r.error}`);
    }
    if (a.error || b.error || s.error) continue;

    floorPairs += 1;
    if (a.action !== b.action) floorDiverged += 1;
    subPairs += 1;
    if (a.action !== s.action) subDiverged += 1;

    const mark = a.action === s.action ? ' ' : 'X';
    console.log(
      `  turn ${String(turn).padStart(4)} ${mark} floor=${a.action === b.action ? 'same' : 'DIFF'}  control="${a.action.slice(0, 44)}"  sub="${s.action.slice(0, 44)}"`
    );
  }
}

console.log(`\n${'='.repeat(74)}`);
if (notFired) {
  console.log(
    `skipped ${notFired} turn(s) where the substitution did not fire`
  );
}
if (failures.length) {
  console.log(`\n${failures.length} request(s) failed:`);
  for (const f of failures.slice(0, 6)) console.log(`  ${f}`);
}

if (DRY) {
  console.log('\nDRY RUN -- nothing was sent.');
  process.exit(0);
}

if (!floorPairs) {
  console.log('\nNo usable samples. Nothing can be concluded.');
  process.exit(1);
}

const floorRate = floorDiverged / floorPairs;
const subRate = subDiverged / subPairs;
console.log(
  `\n  control vs control  ${floorDiverged}/${floorPairs}  = ${(floorRate * 100).toFixed(1)}%   <- the FLOOR`
);
console.log(
  `  control vs substituted  ${subDiverged}/${subPairs}  = ${(subRate * 100).toFixed(1)}%`
);

console.log(`\n  cost: ${cost.calls} calls, $${dollars().toFixed(4)}`);
console.log(
  `        per sampled turn $${(dollars() / Math.max(floorPairs, 1)).toFixed(4)}`
);
for (const n of [250, 900]) {
  console.log(
    `        projected for ${n} turns: $${((dollars() / Math.max(floorPairs, 1)) * n).toFixed(2)}`
  );
}

// THE FLOOR IS AN ASSUMPTION UNTIL MEASURED, and the spec names it as the thing
// that would stop the probe rather than be worked around. A floor that is not
// near zero means this instrument cannot separate the treatment from sampling,
// and no verdict may be read from it.
console.log('');
if (floorRate > 0.1) {
  console.log(
    `FLOOR TOO HIGH (${(floorRate * 100).toFixed(1)}%). The instrument cannot separate the\n` +
      'change from sampling noise, so the strict rule cannot be applied. Per the\n' +
      'pre-registration this stops the probe; it is not something to work around.'
  );
  process.exit(3);
}
console.log(
  `Floor is ${(floorRate * 100).toFixed(1)}%. Verdict needs the full sample -- this run is a\n` +
    'cost and sanity check, not a decision.'
);
