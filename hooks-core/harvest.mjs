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

/**
 * The shape a reply must take, for servers that can enforce one.
 *
 * A SMALL LOCAL MODEL WILL NOT FOLLOW THE PROMPT ON ITS OWN. Measured against
 * qwen2.5:3b through ollama on the real digest from this session:
 *
 *   no constraint                    prose summary, 0 findings
 *   response_format json_object      valid JSON, an invented schema
 *   response_format json_schema      1 finding in the exact shape, 9s
 *
 * That is the difference between the free private path working and not, so
 * the schema is sent rather than hoped for. The wrapper object exists because
 * the OpenAI structured-output contract takes an object at the root; `extract`
 * already locates the array inside whatever it is handed, so nothing
 * downstream needs to know.
 */
export const FINDINGS_SCHEMA = Object.freeze({
  type: 'object',
  required: ['findings'],
  additionalProperties: false,
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['type', 'claim', 'evidence', 'applicability', 'confidenceLabel', 'anchors'],
        properties: {
          type: { type: 'string', enum: FINDING_TYPES },
          claim: { type: 'string' },
          evidence: { type: 'string' },
          applicability: { type: 'string' },
          confidenceLabel: { type: 'string', enum: ['verified', 'probable', 'speculative'] },
          anchors: { type: 'array', items: { type: 'string' } },
          trigger: { type: 'string' },
        },
      },
    },
  },
});

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
  // AN EXPLICIT CHOICE OUTRANKS EVERY CAPABILITY CHECK, and it has to be tested first.
  //
  // The opt-out used to sit after the local-endpoint branch, which meant a user who configured a
  // local endpoint AND set TOKEN_OPTIMIZER_HARVEST=0 kept harvesting: `localEndpoint()` returned
  // 'local' before anything looked at the variable. Turning a feature off must not depend on how
  // it happens to be configured.
  const optedOut = /^(0|false|no|off)$/i.test(process.env.TOKEN_OPTIMIZER_HARVEST || '');
  if (optedOut) return 'off:opted-out';

  // Free and private, so nothing further to weigh: no credential, no billing, no digest leaving
  // the machine.
  if (localEndpoint()) return 'local';

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
 "evidence": "the concrete observation, command result, or rejected approach that proved it",
 "applicability": "the condition under which a future model should use it",
 "confidenceLabel": "verified|probable|speculative",
 "scope": "project|organization|global",
 "invalidators": ["what change would require this to be checked again"],
 "anchors": ["absolute/file/path" or "absolute/file/path#symbolName"]}

RULES:
- Every finding MUST have at least one anchor naming a real file from the session.
  A finding with no anchor can never be checked for staleness, so it is worthless
  and will be discarded.
- Prefer "failure" and "decision" entries. What was TRIED AND REJECTED, and WHY,
  is the most valuable thing here because it exists nowhere in the source tree.
- Do not restate what the code plainly says. Record what someone had to work out.
- verified requires direct evidence; probable means strong but incomplete evidence;
  speculative is a hypothesis and must be labelled as such.
- Use project scope unless the lesson is genuinely independent of this repository.
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

    const evidence = typeof item.evidence === 'string' ? item.evidence.trim() : '';
    const applicability = typeof item.applicability === 'string' ? item.applicability.trim() : '';
    if (evidence.length < 8 || applicability.length < 8) continue;

    const confidenceLabel = ['verified', 'probable', 'speculative'].includes(item.confidenceLabel)
      ? item.confidenceLabel
      : null;
    if (!confidenceLabel) continue;
    const defaults = { verified: 0.95, probable: 0.75, speculative: 0.45 };
    const supplied = Number(item.confidence);
    if (
      item.confidence !== undefined
      && (!Number.isFinite(supplied) || supplied <= 0 || supplied > 1)
    ) continue;
    const confidence = item.confidence === undefined
      ? defaults[confidenceLabel]
      : supplied;
    const scope = ['project', 'organization', 'global'].includes(item.scope)
      ? item.scope
      : 'project';
    const invalidators = Array.isArray(item.invalidators)
      ? item.invalidators.filter((value) => typeof value === 'string' && value.trim()).slice(0, 10)
      : [];

    let anchors = Array.isArray(item.anchors) ? item.anchors.filter((a) => typeof a === 'string' && a) : [];
    // A model asked for file paths will sometimes invent them. When the caller
    // knows which files the session actually touched, anchors are held to it.
    if (knownFiles) anchors = anchors.filter((a) => knownFiles.has(a.split('#')[0]));
    if (!anchors.length) continue;

    accepted.push({
      type: item.type,
      claim: item.claim.trim(),
      evidence,
      applicability,
      confidence,
      confidenceLabel,
      scope,
      invalidators,
      anchors,
      trigger: typeof item.trigger === 'string' ? item.trigger : undefined,
    });
  }
  return accepted;
}

/**
 * Which wire format the configured endpoint speaks.
 *
 * THE ADVERTISED LOCAL PATH DID NOT WORK. Both the SessionStart notice and
 * `doctor` tell the user to point TOKEN_OPTIMIZER_HARVEST_ENDPOINT at a local
 * model, and this client only ever spoke the Anthropic Messages dialect --
 * `system` as a top-level field, `content[]` blocks in the reply. ollama, LM
 * Studio and llama.cpp all serve OpenAI-compatible /v1/chat/completions,
 * which takes the system prompt as a message and answers with
 * `choices[].message.content`. Measured against a stand-in server answering
 * both dialects with the identical finding: the Anthropic path returned 1 and
 * the OpenAI path returned 0.
 *
 * Chosen from the URL rather than by trying one and falling back. A fallback
 * doubles the latency of every genuine failure on a hook path, and the user
 * configures the whole URL here, so the path is something they stated rather
 * than something we guess.
 */
/**
 * Which credential, if any, may travel to this endpoint.
 *
 * `apiKey()` falls back to ANTHROPIC_API_KEY, which is set on most machines
 * that run Claude and says nothing about where this request is going. There is
 * exactly one destination that key belongs to: a REMOTE ANTHROPIC endpoint.
 *
 *   anthropic + remote   the key -- this is what it is for
 *   anthropic + local    explicit only -- loopback is not Anthropic
 *   openai    + remote   explicit only -- a third-party gateway must not
 *                        receive an Anthropic credential as a Bearer token
 *   openai    + local    explicit only
 *
 * The first version of this scoped on `local` alone, which review caught: it
 * closed the loopback leak and left the remote-gateway one wide open. Exported
 * so all four combinations are testable without contriving DNS.
 */
export function credentialFor(dialect, local, env = process.env) {
  const explicit = env.TOKEN_OPTIMIZER_API_KEY || null;
  if (dialect === 'openai' || local) return explicit;
  return explicit || env.ANTHROPIC_API_KEY || null;
}

export function endpointDialect(endpoint = ENDPOINT()) {
  return /\/chat\/completions\b/.test(String(endpoint || '')) ? 'openai' : 'anthropic';
}

/**
 * The last reason a harvest produced nothing, or null.
 *
 * `return []` on every failure made a misconfigured endpoint IDENTICAL to a
 * session with nothing to learn -- which is how a local endpoint answering the
 * wrong dialect stayed invisible. The empty result is kept, because a caller
 * on the hook path must not care; the reason is recorded beside it so
 * `doctor` and a human can tell the two apart.
 */
let lastHarvestFailure = null;
export const harvestFailure = () => lastHarvestFailure;
const failed = (reason) => {
  lastHarvestFailure = reason;
  return [];
};

/**
 * Calls the model. Returns [] on any failure -- a harvest that errors must be
 * indistinguishable, from the caller's side, from a session with nothing to
 * learn. `harvestFailure()` carries why, for the diagnostics that do care.
 */
export async function extract(
  digest,
  { timeoutMs = 30_000, prompt = null, knownFiles = null } = {}
) {
  lastHarvestFailure = null;
  if (!digest) return failed('no digest');
  if (!harvestEnabled()) return failed(`harvest is ${harvestMode()}`);

  // A local endpoint usually has no auth at all, so requiring a key there would
  // make the free, private path unreachable -- the one the design now prefers.
  // Remote is unchanged: harvestEnabled() has already established that a key
  // exists and that the user opted in.
  const key = apiKey();
  const local = Boolean(localEndpoint());
  if (!local && !key) return failed('no api key for a remote endpoint');

  const endpoint = ENDPOINT();
  const dialect = endpointDialect(endpoint);
  const system = prompt || PROMPT;

  // ANCHORS OFFERED AS A CHOICE, NOT REQUESTED IN PROSE.
  //
  // `validate` holds anchors to the files the session actually touched, and a
  // model asked in English for a path writes a plausible one instead of a real
  // one -- so every finding was discarded at the gate. Measured over four runs
  // of qwen2.5:7b on this session's real digest, against that same gate:
  //
  //   anchors unconstrained     4 extracted -> 0 accepted
  //   anchors enum-constrained  4 extracted -> 4 accepted
  //
  // Nothing else differed. The server enforces the enum, so the model picks
  // from the real list rather than inventing one, and the gate stops being
  // the thing that silently eats the harvest.
  //
  // Only when the caller knows the list. `buildFullDelta` is raw transcript
  // with no file heading, and its caller passes no knownFiles for the same
  // reason -- an empty enum would forbid every anchor rather than free it.
  const anchorChoices = knownFiles ? [...knownFiles].filter(Boolean) : [];
  const schema = anchorChoices.length
    ? {
        ...FINDINGS_SCHEMA,
        properties: {
          ...FINDINGS_SCHEMA.properties,
          findings: {
            ...FINDINGS_SCHEMA.properties.findings,
            items: {
              ...FINDINGS_SCHEMA.properties.findings.items,
              properties: {
                ...FINDINGS_SCHEMA.properties.findings.items.properties,
                anchors: { type: 'array', items: { type: 'string', enum: anchorChoices } },
              },
            },
          },
        },
      }
    : FINDINGS_SCHEMA;

  // AN AMBIENT KEY IS NOT CONSENT TO SEND IT TO A LOCAL SERVER.
  //
  // `apiKey()` falls back to ANTHROPIC_API_KEY, which is set on most
  // machines that run Claude at all and says nothing about the endpoint the
  // user pointed this at -- which may be any process listening on loopback.
  // A local server that genuinely wants auth is still reachable: set
  // TOKEN_OPTIMIZER_API_KEY, which is explicit about being for this.
  //
  // Remote is unchanged; there the key is the whole reason the call is
  // allowed to happen.
  const credential = credentialFor(dialect, local);

  // THE DEFAULT MODEL IS AN ANTHROPIC ONE, AND A LOCAL SERVER HAS NEVER HEARD
  // OF IT. `MODEL()` falls back to claude-haiku, so an endpoint configured per
  // the documented advice -- which names only TOKEN_OPTIMIZER_HARVEST_ENDPOINT --
  // asks ollama for a model it does not have and is refused. I hit this myself
  // while proving the dialect fix and set the variable by hand without noticing
  // that a user could not know to.
  //
  // Refused with an actionable reason rather than guessed at. Picking a default
  // like `llama3.2` would be a guess about what the user pulled, and being wrong
  // costs the same silent nothing this whole branch exists to remove.
  if (dialect === 'openai' && !process.env.TOKEN_OPTIMIZER_HARVEST_MODEL) {
    return failed(
      'set TOKEN_OPTIMIZER_HARVEST_MODEL for an OpenAI-compatible endpoint ' +
        `(the default ${MODEL()} is an Anthropic model no local server serves)`
    );
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  /**
   * One request. `structured` asks the server to enforce FINDINGS_SCHEMA.
   *
   * Separated out so the schema can be dropped and the call retried WITHOUT
   * repeating the request shape in two places, which is how the two would
   * drift.
   */
  const send = (structured) =>
    fetch(endpoint, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        // A local server usually wants no credential at all, and sending one
        // to localhost is a leak, not a courtesy -- so a key is attached only
        // when there is one, in the scheme the dialect expects.
        ...(credential && dialect === 'anthropic' ? { 'x-api-key': credential } : {}),
        ...(credential && dialect === 'openai'
          ? { authorization: `Bearer ${credential}` }
          : {}),
        ...(dialect === 'anthropic' ? { 'anthropic-version': '2023-06-01' } : {}),
      },
      body: JSON.stringify(
        dialect === 'openai'
          ? {
              model: MODEL(),
              max_tokens: 2048,
              // No top-level `system` in this dialect; it is the first message.
              messages: [
                { role: 'system', content: system },
                { role: 'user', content: digest },
              ],
              ...(structured
                ? {
                    response_format: {
                      type: 'json_schema',
                      json_schema: { name: 'findings', schema },
                    },
                  }
                : {}),
            }
          : {
              model: MODEL(),
              max_tokens: 2048,
              system,
              messages: [{ role: 'user', content: digest }],
            }
      ),
    });

  try {
    // Structured output only where the contract exists. Anthropic Messages has
    // no `response_format`, and sending one is at best ignored.
    let response = await send(dialect === 'openai');

    // RETRIED ONCE, AND ONLY FOR A REFUSAL OF THE SCHEMA ITSELF. A server that
    // predates structured outputs rejects the request outright, and the
    // unconstrained call still works there -- that is the configuration this
    // whole function used to be. Narrow on purpose: a 4xx is the server saying
    // it will not take what was sent, while a 5xx or a timeout is a condition a
    // second identical call would only pay for twice, on a hook path.
    // NARROWED FROM ANY 4xx. Review is right that the first version retried
    // things a retry cannot help and should not touch: a 429 is a rate limit
    // and an immediate repeat makes it worse, while 401/403/404 are settled
    // answers about credentials and routing. Only a 400/422 whose body names
    // `response_format` is the server saying it will not take THE SCHEMA,
    // which is the one case where the same request without it still works.
    if (
      !response.ok
      && dialect === 'openai'
      && (response.status === 400 || response.status === 422)
    ) {
      let complaint = '';
      try {
        complaint = await response.clone().text();
      } catch {
        complaint = '';
      }
      if (/response_format|json_schema/i.test(complaint)) response = await send(false);
    }

    if (!response.ok) return failed(`endpoint returned HTTP ${response.status}`);
    const body = await response.json();

    // BOTH SHAPES READ, whichever dialect was sent. A gateway may answer in the
    // other one, and reading both costs a property access.
    const text =
      (Array.isArray(body.content)
        ? body.content.filter((b) => b?.type === 'text').map((b) => b.text).join('')
        : '') ||
      (Array.isArray(body.choices)
        ? body.choices.map((c) => c?.message?.content || '').join('')
        : '') ||
      '';
    if (!text) return failed('endpoint answered in an unrecognised shape');

    // Models wrap JSON in prose or fences often enough that finding the array
    // is more reliable than insisting the whole response parse.
    const start = text.indexOf('[');
    const end = text.lastIndexOf(']');
    if (start === -1 || end <= start) return failed('no JSON array in the reply');

    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {
      return failed('the JSON array in the reply did not parse');
    }
  } catch (error) {
    return failed(error?.name === 'AbortError' ? `timed out after ${timeoutMs}ms` : `${error?.message || error}`);
  } finally {
    clearTimeout(timer);
  }
}

/** Approximate token count, for the cost side of the P5 balance. */
export const estimateTokens = (text) => Math.ceil(String(text || '').length / 4);
