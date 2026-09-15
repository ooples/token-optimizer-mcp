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
 * The turns to sample, spread across the conversation's length.
 *
 * SPREAD, NOT THE FIRST N. The amount of reasoning removed grows with
 * conversation length, so sampling only early turns would test the transform
 * where it does least. The spec fixes this in advance.
 */
function sampledCuts(messages, n) {
  const cuts = [];
  for (let i = 0; i < messages.length; i += 1) {
    if (messages[i].role === 'user') cuts.push(i + 1);
  }
  if (cuts.length <= n) return cuts;
  const step = cuts.length / n;
  const picked = [];
  for (let i = 0; i < n; i += 1) picked.push(cuts[Math.floor(i * step)]);
  return picked;
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
      calls.push(`${b.name}(${target.replace(/\s+/g, ' ').trim().slice(0, 80)})`);
    } else if (b?.type === 'text' && b.text?.trim()) {
      text = true;
    }
  }
  if (calls.length) return calls.join(' | ');
  return text ? 'ANSWER' : 'empty';
}

const creds = JSON.parse(
  readFileSync(join(homedir(), '.claude', '.credentials.json'), 'utf8')
);
const token = creds.claudeAiOauth?.accessToken;
if (!token && !DRY) throw new Error('no OAuth access token');

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

async function ask(messages, tools) {
  const body = {
    model: MODEL,
    max_tokens: 1024,
    temperature: TEMPERATURE,
    messages: marked(messages),
    ...(tools.length ? { tools } : {}),
  };
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'oauth-2025-04-20',
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    let detail = text.slice(0, 300);
    try {
      detail = JSON.parse(text).error?.message ?? detail;
    } catch {
      /* keep the raw body */
    }
    return { error: `HTTP ${res.status} ${detail}` };
  }
  const parsed = JSON.parse(text);
  const u = parsed.usage ?? {};
  cost.calls += 1;
  cost.write += u.cache_creation_input_tokens ?? 0;
  cost.read += u.cache_read_input_tokens ?? 0;
  cost.input += u.input_tokens ?? 0;
  cost.output += u.output_tokens ?? 0;
  return { action: actionOf(parsed.content) };
}

const dollars = () =>
  (cost.write * RATE.write +
    cost.read * RATE.read +
    cost.input * RATE.input +
    cost.output * RATE.output) /
  1_000_000;

const paths = process.argv.slice(2);
if (!paths.length) {
  console.error('usage: node bench/compression/next-action-probe.mjs <transcript.jsonl> [...]');
  process.exit(2);
}

let floorDiverged = 0;
let floorPairs = 0;
let subDiverged = 0;
let subPairs = 0;
let notFired = 0;
const failures = [];

for (const path of paths) {
  const messages = messagesFrom(path);
  const cuts = sampledCuts(messages, SAMPLES);
  const name = path.split(/[\\/]/).pop();
  console.log(`\n${name}  --  ${messages.length} messages, sampling ${cuts.length} turn(s)`);

  for (const cut of cuts) {
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
        `  turn ${String(cut).padStart(4)}  ~${Math.round(chars / 4)} prefix tokens  x3 calls`
      );
      continue;
    }

    const a = await ask(control, tools);
    const b = await ask(control, tools);
    const s = await ask(substitution.messages, tools);

    for (const [label, r] of [['control-A', a], ['control-B', b], ['substituted', s]]) {
      if (r.error) failures.push(`turn ${cut} ${label}: ${r.error}`);
    }
    if (a.error || b.error || s.error) continue;

    floorPairs += 1;
    if (a.action !== b.action) floorDiverged += 1;
    subPairs += 1;
    if (a.action !== s.action) subDiverged += 1;

    const mark = a.action === s.action ? ' ' : 'X';
    console.log(
      `  turn ${String(cut).padStart(4)} ${mark} floor=${a.action === b.action ? 'same' : 'DIFF'}  control="${a.action.slice(0, 44)}"  sub="${s.action.slice(0, 44)}"`
    );
  }
}

console.log(`\n${'='.repeat(74)}`);
if (notFired) {
  console.log(`skipped ${notFired} turn(s) where the substitution did not fire`);
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
console.log(`\n  control vs control  ${floorDiverged}/${floorPairs}  = ${(floorRate * 100).toFixed(1)}%   <- the FLOOR`);
console.log(`  control vs substituted  ${subDiverged}/${subPairs}  = ${(subRate * 100).toFixed(1)}%`);

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
