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

import { readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { harvestCliFor } from './capabilities.mjs';

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
 *
 * EVERY FIELD THE PROMPT ASKS FOR HAS TO BE DECLARED HERE, because the
 * object is closed. `PROMPT` asks for `scope` and `invalidators`; the schema
 * did not declare them and `additionalProperties: false` therefore FORBADE
 * them, so an enforcing server could not return either one. `validate` then
 * substituted `project` and `[]` for every finding, and the substitution is
 * silent: on the schema path, organization- and global-scope findings could
 * not be promoted and no finding could ever carry an invalidator. Both are
 * required, matching the prompt -- a finding with nothing that would
 * invalidate it is declared as an empty array rather than omitted, which is a
 * claim the model has to make on purpose.
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
        required: [
          'type',
          'claim',
          'evidence',
          'applicability',
          'confidenceLabel',
          'scope',
          'invalidators',
          'anchors',
        ],
        properties: {
          type: { type: 'string', enum: FINDING_TYPES },
          claim: { type: 'string' },
          evidence: { type: 'string' },
          applicability: { type: 'string' },
          confidenceLabel: { type: 'string', enum: ['verified', 'probable', 'speculative'] },
          scope: { type: 'string', enum: ['project', 'organization', 'global'] },
          invalidators: { type: 'array', items: { type: 'string' } },
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
  // THE HOST CLI IS A BACKEND, so the enablement check has to know about it.
  // Without this the gate answers off:no-key and `extract` never reaches the
  // CLI path -- which defeats the whole point of a backend that needs no key.
  // Caught end to end rather than reasoned about: with no endpoint and no key,
  // the first run of the opted-in host-CLI harvest returned
  // `harvest is off:no-key` in 0s, having never spawned anything.
  if (hostCliHarvest()) return 'host-cli';


  return apiKey() ? 'remote' : 'off:no-key';
}

export function harvestEnabled() {
  const mode = harvestMode();
  // host-cli belongs here for the same reason local and remote do: it is a
  // backend that can actually answer. Leaving it out would let the mode say
  // `host-cli` while every caller that asks `harvestEnabled()` -- the Stop
  // hook, the worker, extract's own first line -- skipped the harvest.
  return mode === 'local' || mode === 'remote' || mode === 'host-cli';
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
// A MODULE VARIABLE CANNOT CROSS A PROCESS, and every reader of this is in a
// different one. The harvest runs in a DETACHED worker spawned at Stop
// (stop-harvest.mjs), while `doctor` is a separate `node` invocation that
// imports a fresh copy of this module. So `probeHarvest` read `null` no matter
// what the harvest had done, and the failure branch it was given -- the whole
// point of recording a reason -- could never be reached from the diagnostic
// that exists to surface it. The reason is written where the next process can
// find it.
//
// Per user, not per project: the worker resolves a project root and `doctor`
// often cannot, and the failures recorded here (a wrong dialect, a missing
// model name, an unreachable endpoint, a CLI that is not on PATH) are
// properties of the machine's configuration rather than of a repository.
const FAILURE_FILE = () =>
  process.env.TOKEN_OPTIMIZER_HARVEST_STATE ||
  join(homedir(), '.token-optimizer', 'last-harvest.json');

// Old enough to be about a configuration that no longer exists. A harvest runs
// at the end of every session, so a record older than this means the harvest
// has not run since -- reporting it as the current state would be a guess.
const FAILURE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

let lastHarvestFailure = null;
/** True once this process has recorded an outcome, so the file is not consulted. */
let outcomeThisProcess = false;

function recordOutcome(reason) {
  lastHarvestFailure = reason;
  outcomeThisProcess = true;
  try {
    const file = FAILURE_FILE();
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ reason, at: Date.now() }), 'utf8');
  } catch {
    // Best effort. A harvest must never fail because it could not write a
    // diagnostic about itself.
  }
}

export function harvestFailure() {
  if (outcomeThisProcess) return lastHarvestFailure;
  try {
    const { reason, at } = JSON.parse(readFileSync(FAILURE_FILE(), 'utf8'));
    if (!reason || typeof at !== 'number') return null;
    return Date.now() - at > FAILURE_TTL_MS ? null : reason;
  } catch {
    return null;
  }
}

const failed = (reason) => {
  recordOutcome(reason);
  return [];
};

/**
 * Clears the recorded failure, because the harvest just worked.
 *
 * Without this the file is a one-way latch: a user fixes their endpoint, the
 * harvest starts working, and `doctor` keeps reporting the failure that was
 * true a week ago. The TTL alone would not do it -- it expires a stale record,
 * not a wrong one.
 */
const succeeded = (findings) => {
  recordOutcome(null);
  return findings;
};

/**
 * Calls the model. Returns [] on any failure -- a harvest that errors must be
 * indistinguishable, from the caller's side, from a session with nothing to
 * learn. `harvestFailure()` carries why, for the diagnostics that do care.
 */
/**
 * The findings array inside a reply, or null.
 *
 * Models wrap JSON in prose or fences often enough that locating the array is
 * more reliable than insisting the whole response parses -- and a CLI adds its
 * own banner lines and stream-json envelopes on top, so both callers need the
 * same tolerance. Shared so the two cannot drift.
 */
function findingsIn(text) {
  const raw = String(text || '');

  // FIRST BRACKET TO LAST IS NOT ENOUGH, and a CLI is where that breaks.
  // `codex exec` prints a banner line reading `sandbox: workspace-write
  // [workdir, /tmp, $TMPDIR]` before the model says anything, so the first
  // `[` in the stream belongs to the banner and the naive slice parses to
  // nothing -- an empty harvest that looks exactly like a session with
  // nothing to learn. Closing brackets are walked from the end and opening
  // brackets from the start, so the widest array that actually parses wins,
  // and prose on either side is tolerated the way it already was for HTTP.
  const closes = [];
  for (let i = raw.length - 1; i >= 0 && closes.length < CLOSE_TRIES; i -= 1) {
    if (raw[i] === ']') closes.push(i);
  }
  for (const end of closes) {
    let tries = 0;
    for (let start = raw.indexOf('['); start !== -1 && start < end; start = raw.indexOf('[', start + 1)) {
      if ((tries += 1) > OPEN_TRIES) break;
      try {
        const parsed = JSON.parse(raw.slice(start, end + 1));
        if (Array.isArray(parsed)) return parsed;
      } catch {
        /* not this pair */
      }
    }
  }
  return null;
}

// Bounded so a pathological reply cannot turn parsing into an O(n^2) walk of
// a megabyte. A real findings array is at the end of the reply and preceded
// by a banner or a sentence, not by hundreds of brackets.
const CLOSE_TRIES = 8;
const OPEN_TRIES = 40;

/**
 * Launches a Windows command through cmd.exe WITHOUT letting Node build the
 * command line.
 *
 * These CLIs all install as .cmd shims, and Node has refused to spawn .cmd
 * or .bat without a shell since the 2024 command-injection fix -- so a shell
 * is not optional. But Node's own `shell: true` builds the cmd.exe line by
 * joining argv with single spaces and no quoting at all, which breaks the
 * moment any part contains one. Caught by the first test written against
 * this: pointing the override at `C:\\Program Files\\nodejs\\node.exe`
 * produced `C:\\Program Files\\nodejs\\node.exe exited 1`, because cmd.exe
 * had been handed `C:\\Program` as the command. Quoting each part and passing
 * the line verbatim is the fix.
 */
function windowsShellCommand(file, args) {
  const quote = (part) => {
    const value = String(part);
    // Doubling is cmd.exe's own escape for a quote inside a quoted token.
    return /[\s"]/.test(value)
      ? `"${value.replace(/"/g, '""')}"`
      : value;
  };
  const line = [file, ...args].map(quote).join(' ');
  return [process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${line}"`]];
}

/**
 * States the anchor list in the prompt, for a backend that cannot be handed
 * a schema.
 *
 * THE ANCHOR GATE IS WHAT SILENTLY EATS A HARVEST. `validate` keeps only
 * anchors naming a file the session actually touched, and a model asked in
 * English for a path writes a plausible one rather than a real one. Measured
 * over four runs of qwen2.5:7b on a real digest against that gate:
 * unconstrained, 4 extracted and 0 accepted; constrained to the list, 4 of 4.
 *
 * The HTTP path gets that constraint from a server-enforced enum. A CLI has
 * no server to enforce it, so the same constraint is stated as strongly as a
 * prompt can state it -- the exact strings, and an instruction to copy rather
 * than compose. Not as good as an enum, and much better than nothing: the
 * first end-to-end run without this extracted 10 findings and kept none.
 */
function withAnchorChoices(system, choices) {
  if (!choices.length) return system;
  const list = choices.map((file) => `- ${file}`).join('\n');
  return (
    `${system}\n\n` +
    'Every entry in "anchors" MUST be copied verbatim from this list -- pick the ' +
    'entries that best match the finding, and never write a path that is not ' +
    'listed. Choosing the nearest match is right; dropping the finding is not:\n' +
    list
  );
}

/**
 * The `-p` value for a CLI whose prompt flag needs one but which still reads
 * stdin. One line, no quotes, no newlines: everything a Windows command line
 * cannot carry.
 */
export const ARG_STDIN_INSTRUCTION =
  'Follow the instructions in the input above and reply with only the JSON array they ask for.';

/** Restated at the end of a prompt file, where an agent skimming will see it. */
const TRAILER =
  'END OF SESSION DIGEST. Now follow the instructions at the top of this file: ' +
  'reply with the JSON array of findings and nothing else. If nothing in the ' +
  'session is worth recording, reply with an empty array.';

/**
 * Runs the host client's own CLI as the harvest model.
 *
 * THE CHILD MUST NOT HARVEST. The harvest runs from the Stop hook, and a
 * child session fires its own Stop hook -- verified, not assumed: a bare
 * `claude -p` with our plugin installed wrote mcp-client, episode-outcome and
 * derive events to the graph. Left unguarded that is unbounded recursion,
 * each level spending real quota.
 *
 * TOKEN_OPTIMIZER_MODE=off IS THE GUARD, and it is the one that works.
 * Measured on the same probe: TOKEN_OPTIMIZER_HARVEST=0 still ran the child's
 * Stop hook and still wrote derive events -- it disables the harvest but not
 * the hooks around it -- while MODE=off suppressed everything but a single
 * mcp-client row. The kill switch is the only setting that makes the child
 * inert, so the child is spawned with it and nothing else is relied upon.
 *
 * DELIVERY COMES FROM THE ROW, not from an assumption that every CLI reads
 * stdin. Copilot does not: asked to follow instructions on stdin it replies
 * that it cannot read stdin, exits 0, and yields no findings -- which looks
 * exactly like a session with nothing to learn. Guessing here fails silently,
 * so it is not guessed.
 */
/**
 * How long to let the host CLI run.
 *
 * THE 30s HTTP DEFAULT KILLS EVERY CLI HARVEST, so it cannot be shared. That
 * budget is sized for one completion against an endpoint that is already
 * listening. A host CLI is an agent: it starts a process, loads its plugin
 * and hook tree, opens a session, then thinks. Measured here on a 23 KB
 * digest with no key and no local model, `claude -p` returned 10 findings in
 * 104 SECONDS -- correct, and more than three times over the HTTP budget.
 * `codex exec` on the same machine defaults to xhigh reasoning effort and
 * had not finished at 300s, which is why this is configurable rather than
 * merely larger.
 *
 * A caller that asks for MORE keeps it; the floor only lifts a default that
 * was never chosen with this backend in mind.
 */
function hostCliTimeoutMs(requested) {
  const configured = Number(process.env.TOKEN_OPTIMIZER_HARVEST_CLI_TIMEOUT_MS);
  const floor = Number.isFinite(configured) && configured > 0 ? configured : 180_000;
  return Math.max(floor, Number(requested) || 0);
}

async function runHostCli(cli, system, digest, timeoutMs) {
  const payload = `${system}\n\n${digest}`;
  const fileMode = cli.delivery === 'prompt-file';
  let file = cli.command;
  let args = [...cli.args];
  let verbatim = false;
  let promptFile = null;

  if (fileMode) {
    // A PATH, NOT THE PAYLOAD. See CLIENT_HARVEST_CLI for why the payload
    // itself cannot travel as an argument on Windows. The file is written
    // under the OS temp directory, which every one of these CLIs can read by
    // default, and removed in `finish` whatever the outcome.
    try {
      // UNGUESSABLE, NOT MERELY UNIQUE. pid and clock are both predictable
      // enough for another local user to pre-create the path in a shared temp
      // directory; randomUUID removes the guess, and `flag: 'wx'` below
      // removes the race that remains.
      promptFile = join(tmpdir(), `token-optimizer-harvest-${randomUUID()}.txt`);
      // 0600. This is a digest of the user's session -- paths, commands and
      // prompts -- sitting in a shared temp directory for as long as the child
      // takes to read it. It is removed in `finish`, but a kill between the two
      // would leave it behind, so it is unreadable to other users meanwhile.
      // (Windows ignores the mode; NTFS inheritance already keeps the per-user
      // temp directory private.)
      // THE CONTRACT IS REPEATED AT THE END. The instructions lead the file and
      // the digest follows, which is the natural order and the one that failed:
      // handed 23 KB this way, copilot reported the file as "a scratchpad
      // /summary document" with no instruction in it and asked what JSON array
      // was wanted. An agent skimming a long file sees its tail; restating the
      // ask there costs one line and removes the dependence on how the file is
      // read.
      writeFileSync(promptFile, `${payload}\n\n${TRAILER}`, {
        encoding: 'utf8',
        mode: 0o600,
        // EXCLUSIVE CREATE. `mode` governs a file this call makes; it does
        // nothing about one that already exists, and the default flag 'w'
        // happily follows a symlink someone else placed at the path -- which
        // would redirect a digest of the user's session wherever they chose.
        // 'wx' fails instead of following.
        flag: 'wx',
      });
    } catch (error) {
      return { ok: false, reason: `could not write the harvest prompt file: ${error?.message || error}` };
    }
    args.push(
      `Read the whole file at ${promptFile}. It opens with instructions, then a ` +
        'digest of a coding session, then repeats what to reply. Follow those ' +
        'instructions and output the JSON array they ask for, and nothing else.'
    );
  } else if (cli.delivery === 'arg-stdin') {
    // A SHORT SINGLE LINE, NEVER THE PROMPT. The flag needs a value, and the
    // obvious value -- `system` -- is the multi-line PROMPT, which
    // withAnchorChoices extends with a newline-separated file list and which
    // is full of the JSON prompt's double quotes. That is the exact payload
    // the prompt-file route exists to keep off a Windows command line:
    // cmd.exe cannot carry a newline inside an argument, and the quoting
    // doubles every `"`. These CLIs document the flag value as being
    // APPENDED to stdin, so the whole payload rides stdin and the argument
    // is one line of ASCII that any shell survives.
    args.push(ARG_STDIN_INSTRUCTION);
  }

  if (process.platform === 'win32' && file === cli.command) {
    [file, args] = windowsShellCommand(file, args);
    verbatim = true;
  }

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(file, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        // The command line was built above where it needed cmd.exe, so Node
        // must not rebuild it: `shell: true` would join argv unquoted.
        windowsVerbatimArguments: verbatim,
        env: {
          ...process.env,
          TOKEN_OPTIMIZER_MODE: 'off',
        },
      });
    } catch (error) {
      resolve({ ok: false, reason: `${cli.command} could not start: ${error?.message || error}` });
      return;
    }

    let out = '';
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      if (promptFile) {
        try {
          rmSync(promptFile, { force: true });
        } catch {
          /* a leftover in the temp directory is not worth failing a harvest */
        }
      }
      resolve(value);
    };
    const timer = setTimeout(
      () => finish({ ok: false, reason: `${cli.command} timed out after ${timeoutMs}ms` }),
      timeoutMs
    );

    child.stdout.on('data', (c) => {
      out += c;
    });
    // stderr is drained so a chatty CLI cannot fill the pipe and deadlock.
    child.stderr.on('data', () => {});
    child.on('error', (error) =>
      finish({ ok: false, reason: `${cli.command} failed: ${error?.message || error}` })
    );
    // NON-ZERO IS NOT ALWAYS EMPTY. Some of these print the reply and then
    // exit non-zero over an unrelated cleanup complaint, so a parseable array
    // already in hand beats the exit code; the code decides only when there is
    // nothing to parse.
    child.on('close', (code) =>
      code === 0 || findingsIn(out)
        ? finish({ ok: true, text: out })
        : finish({ ok: false, reason: `${cli.command} exited ${code}` })
    );

    // EPIPE ARRIVES AS AN EVENT, NOT AS A THROW. The try/catch below sees
    // only a synchronous failure; a child that exits without reading stdin
    // fails the write asynchronously, and Node delivers that on the stream.
    // With no listener it is an uncaught exception that takes down the hook
    // process instead of resolving this promise -- and the path is not
    // hypothetical: copilot, asked to read a prompt on stdin, answers that it
    // cannot and exits 0, which is why its row is prompt-file at all.
    child.stdin.on('error', (error) =>
      finish({
        ok: false,
        reason: `could not write the digest to ${cli.command}: ${error?.message || error}`,
      })
    );

    try {
      // Closed either way: a child left waiting on a pipe that will never
      // carry anything hangs until the timeout, which is the slowest possible
      // way to produce nothing.
      if (fileMode) child.stdin.end();
      else child.stdin.end(payload);
    } catch {
      finish({ ok: false, reason: `could not write the digest to ${cli.command}` });
    }
  });
}

/**
 * Is the host CLI available as a harvest backend for this client?
 *
 * OPT-IN, deliberately, and this is the one default in this file that is not
 * on. Every other path either reads local files or spends a key the user
 * already configured for this purpose; this one spends the subscription that
 * runs their editor, automatically, at the end of every session. HeadRoom
 * makes the equivalent call user-invoked (`headroom learn`, cli/learn.py) and
 * its own design note says to log events and analyse offline. Charging someone
 * quota they did not ask to spend is not a default worth taking.
 */
export function hostCliHarvest(client = undefined, env = process.env) {
  const enabled = /^(1|true|yes|on)$/i.test(env.TOKEN_OPTIMIZER_HARVEST_CLI || '');
  if (!enabled) return null;
  return harvestCliFor(client === undefined ? env.TOKEN_OPTIMIZER_CLIENT : client, env);
}

export async function extract(
  digest,
  { timeoutMs = 30_000, prompt = null, knownFiles = null } = {}
) {
  lastHarvestFailure = null;
  outcomeThisProcess = false;
  if (!digest) return failed('no digest');
  if (!harvestEnabled()) return failed(`harvest is ${harvestMode()}`);

  // A local endpoint usually has no auth at all, so requiring a key there would
  // make the free, private path unreachable -- the one the design now prefers.
  // Remote is unchanged: harvestEnabled() has already established that a key
  // exists and that the user opted in.
  const key = apiKey();
  const local = Boolean(localEndpoint());
  // The host CLI carries its own auth -- the user is already signed into the
  // client that is running this -- so the key requirement is about the HTTP
  // backends only.
  if (!local && !key && !hostCliHarvest()) {
    return failed('no api key for a remote endpoint');
  }

  const endpoint = ENDPOINT();
  const dialect = endpointDialect(endpoint);
  const system = prompt || PROMPT;

  // Computed before the CLI branch because BOTH backends need it. It used to
  // sit below, so the host CLI was the one path that never learned which
  // files it was allowed to anchor to -- and the anchor gate is what silently
  // eats a harvest. Caught end to end on a real session: 10 findings
  // extracted through `claude -p`, 0 surviving `validate`.
  const anchorChoices = knownFiles ? [...knownFiles].filter(Boolean) : [];

  // The host client's own CLI, when the user has opted in. Tried first
  // because it needs no key and no local model -- the two things whose
  // absence has kept this path at 3 harvested findings on this machine.
  const hostCli = hostCliHarvest();
  if (hostCli) {
    const result = await runHostCli(
      hostCli,
      withAnchorChoices(system, anchorChoices),
      digest,
      hostCliTimeoutMs(timeoutMs)
    );
    if (!result.ok) return failed(result.reason);
    const parsed = findingsIn(result.text);
    if (!parsed) return failed(`no JSON array in the ${hostCli.command} reply`);
    return succeeded(parsed);
  }

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

    const parsed = findingsIn(text);
    return parsed ? succeeded(parsed) : failed('no usable JSON array in the reply');
  } catch (error) {
    return failed(error?.name === 'AbortError' ? `timed out after ${timeoutMs}ms` : `${error?.message || error}`);
  } finally {
    clearTimeout(timer);
  }
}

/** Approximate token count, for the cost side of the P5 balance. */
export const estimateTokens = (text) => Math.ceil(String(text || '').length / 4);
