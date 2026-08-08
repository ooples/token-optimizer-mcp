/**
 * P3: semantic harvest -- turning a session into findings, out of band.
 *
 * Runs at Stop/PreCompact against a cheap model, in a separate process, so the
 * session doing the work never pays for the harvest. Without an API key the
 * whole thing is skipped and the graph keeps its structural layer, which is the
 * majority of its machinery and costs nothing.
 *
 * WHAT LEAVES THE MACHINE. By default: a STRUCTURED DIGEST -- which files were
 * touched, which symbols edited, which commands ran and their exit codes, the
 * user's prompts, and the assistant's stated conclusions. File CONTENTS are not
 * sent. That matters because a token optimizer that quietly ships source code,
 * secrets from error output, or customer data in test fixtures to a third party
 * is a security incident wearing a productivity costume.
 *
 * TOKEN_OPTIMIZER_HARVEST_FULL=true opts into sending the raw transcript delta
 * for materially better extraction. It is opt-in precisely because the default
 * must be defensible without anyone reading the docs.
 */

import { readFileSync } from 'node:fs';

const MODEL = () => process.env.TOKEN_OPTIMIZER_HARVEST_MODEL || 'claude-haiku-4-5-20251001';

/**
 * The Messages endpoint, overridable.
 *
 * Not a test seam: plenty of organisations route model traffic through an
 * internal gateway or proxy for auditing and cost attribution, and hardcoding
 * the hostname makes the harvest unusable for exactly the teams most likely to
 * care where their transcripts go. Read per call, like the other config.
 */
const ENDPOINT = () => process.env.TOKEN_OPTIMIZER_HARVEST_ENDPOINT
  || 'https://api.anthropic.com/v1/messages';

/** Findings must be one of these. Free-form claims are rejected. */
// 'feedback' is a lesson extracted from a USER CORRECTION rather than from the
// code -- the only finding type whose source is a person telling the agent it
// was wrong, which is why it is kept distinguishable from an ordinary finding.
export const FINDING_TYPES = ['finding', 'decision', 'failure', 'command', 'map', 'feedback'];

export function apiKey() {
  return process.env.TOKEN_OPTIMIZER_API_KEY || process.env.ANTHROPIC_API_KEY || null;
}

/**
 * The configured endpoint when it is on this machine, otherwise null.
 *
 * A local endpoint changes what the harvest COSTS and what it DISCLOSES, which
 * is what the enablement rule below turns on: nothing leaves the machine and
 * nothing is billed, so it needs no key and no opt-in.
 */
export function localEndpoint() {
  const configured = process.env.TOKEN_OPTIMIZER_HARVEST_ENDPOINT;
  if (!configured) return null;
  try {
    const { hostname } = new URL(configured);
    const local = hostname === 'localhost' || hostname === '127.0.0.1'
      // URL.hostname gives IPv6 literals BRACKETED, so a bare '::1' never matched
      // and http://[::1]:11434 was treated as remote -- the loopback spelling a user
      // is most likely to copy from a server that printed it that way.
      || hostname === '[::1]' || hostname === '::1' || hostname === '0.0.0.0'
      || hostname.endsWith('.local');
    return local ? configured : null;
  } catch {
    return null;
  }
}

/**
 * Why the harvest is or is not running -- a string, because "off" needs a
 * reason a user can act on and a boolean cannot carry one.
 *
 * @returns {'local' | 'remote' | 'off:mode' | 'off:opted-out' | 'off:no-key'}
 */
export function harvestMode() {
  if (process.env.TOKEN_OPTIMIZER_MODE === 'off') return 'off:mode';

  // Free and private: on by default, because there is nothing to consent to.
  if (localEndpoint()) return 'local';

  // ON BY DEFAULT, OPT-OUT. This was opt-in, and the argument was a real one: a remote harvest
  // spends money and sends a digest off the machine, and an ambient ANTHROPIC_API_KEY is not
  // consent.
  //
  // Measured against that argument on a machine running this for weeks: 340 read events recorded
  // in one project's graph and 48 in another, with ZERO findings, ZERO harvests and ZERO
  // injections in either. The graph accumulated structure and never learned anything, because
  // nobody sets an environment variable they have never heard of. Everything downstream --
  // injection, transfer between projects, consolidation, the whole claim that this stops you
  // re-deriving what you already worked out -- is inert without the harvest, so an opt-in default
  // silently withheld the product from every user who did not go looking for it.
  //
  // A default nobody discovers is not conservative. It is a dead feature.
  //
  // The consent argument is answered rather than discarded:
  //   - off:no-key still applies, so nothing starts billing on a machine with no credential.
  //   - TOKEN_OPTIMIZER_HARVEST=0|false|no|off turns it off; TOKEN_OPTIMIZER_MODE=off turns off
  //     everything.
  //   - buildDigest already drops tool results, file bodies and diffs rather than summarising
  //     them, because summarised still means sent.
  //   - probeHarvest in doctor.mjs states the mode and what is sent, so the state is legible
  //     rather than assumed.
  const optedOut = /^(0|false|no|off)$/i.test(process.env.TOKEN_OPTIMIZER_HARVEST || '');
  if (optedOut) return 'off:opted-out';
  return apiKey() ? 'remote' : 'off:no-key';
}

export function harvestEnabled() {
  const mode = harvestMode();
  return mode === 'local' || mode === 'remote';
}

/**
 * Builds the digest from a transcript.
 *
 * Reads the JSONL transcript the harness already writes and keeps only the
 * shapes listed above. Everything else -- tool results, file bodies, diffs --
 * is dropped rather than summarised, because "summarised" still means "sent".
 */
export function buildDigest(transcriptPath, { maxChars = 24_000 } = {}) {
  let lines;
  try {
    lines = readFileSync(transcriptPath, 'utf8').split('\n');
  } catch {
    return null;
  }

  const prompts = [];
  const conclusions = [];
  const files = new Set();
  const commands = [];

  for (const line of lines) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    const message = entry.message || entry;
    const role = message.role || entry.type;
    const content = message.content;

    if (role === 'user' && typeof content === 'string') {
      prompts.push(content.slice(0, 500));
      continue;
    }
    if (!Array.isArray(content)) continue;

    for (const block of content) {
      // The assistant's own prose is where conclusions live. Tool RESULTS are
      // deliberately skipped -- that is where file contents would leak in.
      if (block.type === 'text' && role === 'assistant') {
        conclusions.push(String(block.text).slice(0, 1500));
      } else if (block.type === 'tool_use') {
        const input = block.input || {};
        const path = input.file_path || input.path;
        if (path) files.add(String(path));
        if (input.command) commands.push(String(input.command).slice(0, 200));
      }
    }
  }

  if (!prompts.length && !conclusions.length) return null;

  const digest = [
    '## User asked', ...prompts.slice(-10),
    '', '## Files touched', ...[...files].slice(0, 60),
    '', '## Commands run', ...commands.slice(-25),
    '', '## Assistant conclusions', ...conclusions.slice(-25),
  ].join('\n');

  return digest.slice(0, maxChars);
}

/** The opt-in path: the raw delta, capped. */
export function buildFullDelta(transcriptPath, { maxChars = 60_000 } = {}) {
  try {
    return readFileSync(transcriptPath, 'utf8').slice(-maxChars);
  } catch {
    return null;
  }
}

const PROMPT = `Extract durable findings from this coding session for a project knowledge graph.

Return ONLY a JSON array. Each element:
{"type": "finding|decision|failure|command|map",
 "claim": "one sentence, specific and checkable",
 "confidence": 0.0-1.0,
 "anchors": ["absolute/file/path" or "absolute/file/path#symbolName"]}

RULES:
- Every finding MUST have at least one anchor naming a real file from the session.
  A finding with no anchor can never be checked for staleness, so it is worthless
  and will be discarded.
- Prefer "failure" and "decision" entries. What was TRIED AND REJECTED, and WHY,
  is the most valuable thing here because it exists nowhere in the source tree.
- Do not restate what the code plainly says. Record what someone had to work out.
- confidence reflects how well established the claim is, not how important.
- If nothing durable was learned, return [].`;

/**
 * Validates extracted findings against the schema.
 *
 * THE ANCHOR REQUIREMENT IS LOAD-BEARING, not pedantry: an unanchored finding
 * has nothing to go stale against, so it can never be invalidated and will be
 * served as current forever. That is precisely how a knowledge graph rots into
 * a pile of confident lies, so unanchored findings are discarded rather than
 * stored with a caveat.
 */
export function validate(raw, { knownFiles = null } = {}) {
  if (!Array.isArray(raw)) return [];

  const accepted = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    if (!FINDING_TYPES.includes(item.type)) continue;
    if (typeof item.claim !== 'string' || item.claim.trim().length < 8) continue;

    const confidence = Number(item.confidence);
    if (!Number.isFinite(confidence) || confidence <= 0 || confidence > 1) continue;

    let anchors = Array.isArray(item.anchors) ? item.anchors.filter((a) => typeof a === 'string' && a) : [];
    // A model asked for file paths will sometimes invent them. When the caller
    // knows which files the session actually touched, anchors are held to it.
    if (knownFiles) anchors = anchors.filter((a) => knownFiles.has(a.split('#')[0]));
    if (!anchors.length) continue;

    accepted.push({ type: item.type, claim: item.claim.trim(), confidence, anchors });
  }
  return accepted;
}

/**
 * Calls the model. Returns [] on any failure -- a harvest that errors must be
 * indistinguishable, from the caller's side, from a session with nothing to
 * learn.
 */
export async function extract(digest, { timeoutMs = 30_000, prompt = null } = {}) {
  if (!digest || !harvestEnabled()) return [];

  // A local endpoint usually has no auth at all, so requiring a key there would
  // make the free, private path unreachable -- the one the design now prefers.
  // Remote is unchanged: harvestEnabled() has already established that a key
  // exists and that the user opted in.
  const key = apiKey();
  const local = Boolean(localEndpoint());
  if (!local && !key) return [];

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(ENDPOINT(), {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        ...(key ? { 'x-api-key': key } : {}),
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL(),
        max_tokens: 2048,
        system: prompt || PROMPT,
        messages: [{ role: 'user', content: digest }],
      }),
    });

    if (!response.ok) return [];
    const body = await response.json();
    const text = (body.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');

    // Models wrap JSON in prose or fences often enough that finding the array
    // is more reliable than insisting the whole response parse.
    const start = text.indexOf('[');
    const end = text.lastIndexOf(']');
    if (start === -1 || end <= start) return [];

    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/** Approximate token count, for the cost side of the P5 balance. */
export const estimateTokens = (text) => Math.ceil(String(text || '').length / 4);
