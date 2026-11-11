/**
 * The loop guard: notice a turn that is stuck, and redirect it once.
 *
 * WHY. Failed work is the most expensive work there is. In TokenEconomizer's
 * SWE-Bench traces failed tasks were 17% of tasks and 32% of spend, and 45
 * trajectories repeated a failure signature they had already hit. On an API
 * plan that is money; on a subscription it is quota that ends the person's day
 * early with nothing to show for it.
 *
 * WHAT COUNTS AS STUCK. A turn (the agent's work on one prompt) is stuck when
 * the same failure keeps coming back. Three signals, strongest first:
 *
 *   CERTAIN    the same failure signature `certainRepeats` (4) times in one turn,
 *              or a turn past `backstop` x this repository's usual length that is
 *              churning: one file edited again and again between the same
 *              failures. Redirected at once, with no model call.
 *   SUSPECT    the same signature `suspectRepeats` (3) times, or many failures in
 *              a turn already longer than 90% of this repository's good turns.
 *              Redirected at once when the judge is off; sent to the judge when
 *              it is on, and redirected only at `judgeConfidence` or more.
 *   NOTHING    everything else. A turn that is failing differently each time is
 *              usually making progress, and is left alone.
 *
 * At most `nudges` (1) redirects per turn. A turn still stuck after that gets one
 * line shown to the PERSON (systemMessage) saying how to stop it; the guard never
 * stops a turn itself -- that is the person's call.
 *
 * WHERE IT GOES FURTHER THAN THE PRIOR ART.
 *
 *   1. THE REDIRECT CARRIES WHAT THE PROJECT ALREADY KNOWS. A generic "try
 *      another approach" is what TokenEconomizer's redirect writer produces.
 *      Here the redirect names the failure, how many times it came back, and the
 *      knowledge graph's findings about the files the failing calls touched --
 *      the dead ends and working commands an earlier session recorded -- so the
 *      new approach starts from evidence instead of from a guess.
 *   2. IT ACTS FROM THE FIRST SESSION. The prior art waits for five good turns
 *      in a repository before it acts at all. The CERTAIN signals here need no
 *      learned envelope: four identical failures in one turn are a loop in any
 *      repository. The envelope sharpens the SUSPECT and backstop signals once
 *      it exists.
 *   3. THE JUDGE IS OPTIONAL AND ACCOUNTED. With `TOKEN_OPTIMIZER_LOOPGUARD_JUDGE
 *      =on` an ambiguous case goes to a small model through the person's own
 *      `claude` CLI, in the background, so the hook never waits on it; its usage
 *      is recorded so reports charge the guard for what it spent.
 *
 * Configuration (all optional):
 *   TOKEN_OPTIMIZER_LOOPGUARD=on|off                 default on
 *   TOKEN_OPTIMIZER_LOOPGUARD_JUDGE=on|off           default off
 *   TOKEN_OPTIMIZER_LOOPGUARD_JUDGE_CONFIDENCE=0.7
 *   TOKEN_OPTIMIZER_LOOPGUARD_NUDGES=1
 *   TOKEN_OPTIMIZER_LOOPGUARD_BACKSTOP=2.5
 *   TOKEN_OPTIMIZER_LOOPGUARD_ENVELOPE_MIN=5         good turns before the envelope is used
 */

import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  appendFileSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { failureInOutput, maskedRunner } from './piped-failure.mjs';
import { writeAtomically } from './policy.mjs';
import { stateRoot } from './runtime-switch.mjs';
import { safeLine } from './safe-text.mjs';

export const ENVELOPE_FILE = 'loopguard-envelope.json';
export const EVENTS_FILE = 'loopguard-events.jsonl';
export const MAX_ENVELOPE = 50;
export const TAIL_BYTES = 4 * 1024 * 1024;
export const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);

const OFF = /^(0|false|no|off)$/i;
const ON = /^(1|true|yes|on)$/i;
const num = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

export function loopguardSettings(env = process.env) {
  return {
    enabled: !OFF.test(String(env.TOKEN_OPTIMIZER_LOOPGUARD ?? '').trim()),
    judge: ON.test(String(env.TOKEN_OPTIMIZER_LOOPGUARD_JUDGE ?? '').trim()),
    judgeConfidence: Math.min(1, num(env.TOKEN_OPTIMIZER_LOOPGUARD_JUDGE_CONFIDENCE, 0.7)),
    nudges: Math.floor(num(env.TOKEN_OPTIMIZER_LOOPGUARD_NUDGES, 1)),
    backstop: num(env.TOKEN_OPTIMIZER_LOOPGUARD_BACKSTOP, 2.5),
    envelopeMin: Math.floor(num(env.TOKEN_OPTIMIZER_LOOPGUARD_ENVELOPE_MIN, 5)),
    suspectRepeats: 3,
    certainRepeats: 4,
    churnEdits: 3,
  };
}

// ---------------------------------------------------------------------------
// Failure signatures.

/**
 * The part of an error that stays the same when the same thing fails again.
 * Numbers, hex ids, paths, durations and quoted values vary between attempts
 * at the same mistake; they are masked so the repeats compare equal.
 */
export function normalizeError(text) {
  const lines = String(text ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !/^exit code \d+$/i.test(line));
  // The first informative lines carry the error; a stack's tail varies.
  return lines
    .slice(0, 2)
    .join(' | ')
    .toLowerCase()
    .replace(/(?:[a-z]:)?[\\/][^\s:'"`)]+/gi, '<path>')
    .replace(/\b0x[0-9a-f]+\b/g, '<hex>')
    .replace(/\b[0-9a-f]{7,}\b/g, '<hex>')
    .replace(/\d+(?:\.\d+)?/g, '#')
    .replace(/(['"`]).*?\1/g, '<q>')
    .replace(/\s+/g, ' ')
    .slice(0, 240);
}

/**
 * Results that are an error to the host but not a failure of the work: the
 * person interrupted, declined a permission, or a hook (this package's own
 * refusals among them) redirected the call. Counting them would make a session
 * that is simply being steered look like a loop -- and this package's refusals
 * differ only in the path, which the signature masks, so four refusals of four
 * different files would otherwise read as one failure repeated four times.
 */
const NOT_A_FAILURE = [
  /TOKEN_OPTIMIZER_MODE/,
  /\[Request interrupted by user/i,
  /\[Tool call interrupted/i,
  /The user doesn't want to proceed with this tool use/i,
  /tool use was rejected/i,
  /hook (?:error|blocked)|blocked by (?:a )?(?:PreToolUse )?hook/i,
];

export function isSteering(errorText) {
  const text = String(errorText ?? '');
  return NOT_A_FAILURE.some((pattern) => pattern.test(text));
}

/**
 * `key` and `text` are the normalized error, which is what makes two runs the
 * same failure. `raw` is the error as it read, for the redirect: quoting the
 * normalized form showed a live model "config.version must be #, got #" for an
 * error that said "must be 3, got 2" -- the very numbers the fix depends on.
 */
export function failureSignature(toolName, errorText) {
  const normalized = normalizeError(errorText);
  const raw = String(errorText ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !/^exit code \d+$/i.test(line))
    .slice(0, 2)
    .join(' | ')
    .slice(0, 240);
  return {
    key: createHash('sha256').update(`${toolName}\u0000${normalized}`).digest('hex').slice(0, 16),
    text: normalized,
    raw,
  };
}

// ---------------------------------------------------------------------------
// The current turn, read from the transcript.

function readTail(path, bytes) {
  try {
    const size = statSync(path).size;
    const start = Math.max(0, size - bytes);
    const length = size - start;
    const buffer = Buffer.alloc(length);
    const fd = openSync(path, 'r');
    try {
      let offset = 0;
      while (offset < length) {
        const read = readSync(fd, buffer, offset, length - offset, start + offset);
        if (!read) break;
        offset += read;
      }
    } finally {
      closeSync(fd);
    }
    const text = buffer.toString('utf8');
    return start ? text.slice(text.indexOf('\n') + 1) : text;
  } catch {
    return '';
  }
}

function resultText(block) {
  if (typeof block?.content === 'string') return block.content;
  if (Array.isArray(block?.content)) {
    return block.content.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('\n');
  }
  return '';
}

function isTypedPrompt(entry, content) {
  if (entry.isMeta || entry.isSidechain) return false;
  let text = '';
  if (typeof content === 'string') text = content;
  else if (Array.isArray(content)) {
    if (content.some((block) => block?.type === 'tool_result')) return false;
    text = content.filter((block) => block?.type === 'text').map((block) => String(block.text)).join('\n');
  }
  text = text.trim();
  return Boolean(text) && !/^<(?:command-|local-command|system-reminder|bash-)/.test(text);
}

/**
 * The turn in progress: every call since the person's last prompt, in order.
 * @returns {{turnKey: string|null, calls: Array<{name: string, path: string|null, ok: boolean|null, sig: object|null}>}}
 */
export function currentTurn(transcriptPath, { tailBytes = TAIL_BYTES } = {}) {
  const text = transcriptPath ? readTail(transcriptPath, tailBytes) : '';
  let turnKey = null;
  let calls = [];
  const byId = new Map();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.isSidechain) continue;
    const message = entry.message || entry;
    const role = message.role || entry.type;
    const content = message.content;
    if (role === 'user' && isTypedPrompt(entry, content)) {
      turnKey = String(entry.uuid || entry.timestamp || calls.length);
      calls = [];
      byId.clear();
      continue;
    }
    if (role === 'assistant' && Array.isArray(content)) {
      for (const block of content) {
        if (block?.type !== 'tool_use' || typeof block.name !== 'string') continue;
        const call = {
          id: block.id ? String(block.id) : null,
          name: block.name,
          path: block.input?.file_path || block.input?.notebook_path || null,
          command: typeof block.input?.command === 'string' ? block.input.command.slice(0, 200) : null,
          // Read from the WHOLE command: the pipe that hides the exit status is
          // usually at the end, past where `command` is cut.
          masked: maskedRunner(block.input?.command),
          ok: null,
          sig: null,
        };
        calls.push(call);
        if (block.id) byId.set(String(block.id), call);
      }
      continue;
    }
    if (role === 'user' && Array.isArray(content)) {
      for (const block of content) {
        if (block?.type !== 'tool_result') continue;
        const call = byId.get(String(block.tool_use_id || ''));
        if (!call) continue;
        const body = resultText(block);
        if (block.is_error === true && isSteering(body)) {
          call.ok = null;
          continue;
        }
        call.ok = block.is_error !== true;
        if (!call.ok) call.sig = failureSignature(call.name, body);
        else if (call.masked) {
          // `npm test | tail` exits 0 whatever the tests did (piped-failure.mjs).
          // Keyed on the runner's summary line, so the same red run repeated is
          // one repeating failure rather than a run of fresh successes.
          const hidden = failureInOutput(body);
          if (hidden) {
            call.ok = false;
            call.sig = failureSignature(call.name, hidden.line);
          }
        }
      }
    }
  }
  return { turnKey, calls };
}

/** What the turn's calls add up to. */
export function turnStats(calls) {
  const repeats = new Map();
  const editsByPath = new Map();
  let failures = 0;
  let lastEdit = -1;
  let failureAfterLastEdit = false;
  calls.forEach((call, index) => {
    if (EDIT_TOOLS.has(call.name) && call.ok !== false) {
      lastEdit = index;
      failureAfterLastEdit = false;
      if (call.path) editsByPath.set(call.path, (editsByPath.get(call.path) || 0) + 1);
    }
    if (call.ok === false && call.sig) {
      failures += 1;
      const entry = repeats.get(call.sig.key) || { count: 0, text: call.sig.text, tool: call.name, paths: new Set() };
      entry.count += 1;
      // The latest wording: the numbers in it are the current ones.
      if (call.sig.raw) entry.raw = call.sig.raw;
      if (call.path) entry.paths.add(call.path);
      repeats.set(call.sig.key, entry);
      if (index > lastEdit) failureAfterLastEdit = true;
    }
  });
  let top = null;
  for (const [key, entry] of repeats) if (!top || entry.count > top.count) top = { key, ...entry };
  const maxEdits = Math.max(0, ...editsByPath.values());
  return {
    calls: calls.length,
    failures,
    top,
    maxEdits,
    editedPaths: [...editsByPath.keys()],
    endedWell: calls.length > 0 && !failureAfterLastEdit,
  };
}

// ---------------------------------------------------------------------------
// The per-repository envelope: how long a good turn usually is here.

export function loadEnvelope(dir) {
  try {
    const parsed = JSON.parse(readFileSync(join(dir, ENVELOPE_FILE), 'utf8'));
    return Array.isArray(parsed?.turns) ? parsed : { turns: [] };
  } catch {
    return { turns: [] };
  }
}

function quantile(sorted, q) {
  if (!sorted.length) return null;
  const position = (sorted.length - 1) * q;
  const low = Math.floor(position);
  const high = Math.ceil(position);
  return sorted[low] + (sorted[high] - sorted[low]) * (position - low);
}

export function envelopeSummary(envelope, settings = loopguardSettings()) {
  const sorted = envelope.turns.map((turn) => turn.calls).filter((n) => n > 0).sort((a, b) => a - b);
  if (sorted.length < settings.envelopeMin) return { ready: false, samples: sorted.length };
  return { ready: true, samples: sorted.length, median: quantile(sorted, 0.5), p90: quantile(sorted, 0.9) };
}

/** Called at Stop: a turn that ended well teaches the envelope its length. */
export function recordTurnEnd(dir, transcriptPath, { now = Date.now() } = {}) {
  const { turnKey, calls } = currentTurn(transcriptPath);
  if (!turnKey || !calls.length) return null;
  const stats = turnStats(calls);
  if (!stats.endedWell) return { recorded: false, stats };
  const envelope = loadEnvelope(dir);
  if (envelope.turns.some((turn) => turn.turnKey === turnKey)) return { recorded: false, stats };
  envelope.turns = [...envelope.turns, { turnKey, calls: stats.calls, at: now }].slice(-MAX_ENVELOPE);
  try {
    mkdirSync(dir, { recursive: true });
    writeAtomically(join(dir, ENVELOPE_FILE), JSON.stringify(envelope));
  } catch {
    return { recorded: false, stats };
  }
  return { recorded: true, stats };
}

// ---------------------------------------------------------------------------
// The decision.

/**
 * @returns {{level: 'certain'|'suspect'|'none', reason: string}}
 */
export function classifyTurn(stats, envelope, settings = loopguardSettings()) {
  const repeats = stats.top?.count || 0;
  if (repeats >= settings.certainRepeats) {
    return { level: 'certain', reason: `same failure ${repeats}x` };
  }
  const churning = stats.maxEdits >= settings.churnEdits && repeats >= 2;
  if (envelope.ready && churning && stats.calls > settings.backstop * envelope.median) {
    return { level: 'certain', reason: `churning at ${stats.calls} calls (usual ${Math.round(envelope.median)})` };
  }
  if (repeats >= settings.suspectRepeats) return { level: 'suspect', reason: `same failure ${repeats}x` };
  if (envelope.ready && stats.failures >= 4 && stats.calls > envelope.p90) {
    return { level: 'suspect', reason: `${stats.failures} failures in a ${stats.calls}-call turn (p90 ${Math.round(envelope.p90)})` };
  }
  return { level: 'none', reason: '' };
}

// ---------------------------------------------------------------------------
// Per-session state: redirects given this turn, judge verdicts.

function sessionStatePath(sessionId) {
  const safe = String(sessionId || 'default').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 96) || 'default';
  return join(stateRoot(), 'loopguard', `${safe}.json`);
}

export function loadSessionState(sessionId) {
  try {
    return JSON.parse(readFileSync(sessionStatePath(sessionId), 'utf8')) || {};
  } catch {
    return {};
  }
}

export function saveSessionState(sessionId, state) {
  try {
    const path = sessionStatePath(sessionId);
    mkdirSync(join(stateRoot(), 'loopguard'), { recursive: true, mode: 0o700 });
    writeAtomically(path, JSON.stringify(state));
  } catch {
    // Lost state means at worst one extra redirect.
  }
}

function recordEvent(dir, event) {
  try {
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, EVENTS_FILE), `${JSON.stringify(event)}\n`);
  } catch {
    // Accounting is best effort.
  }
}

/** What happened, for status reports: redirects, notices, judge calls and their cost. */
export function readEvents(dir) {
  try {
    return readFileSync(join(dir, EVENTS_FILE), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// The redirect.

/**
 * @param {object} stats turnStats
 * @param {string} reason
 * @param {Array<{type?: string, claim: string}>} findings from the graph, already selected
 */
export function redirectText(stats, reason, findings = []) {
  const lines = [
    `Loop guard: this turn looks stuck (${reason}).`,
  ];
  // Tool output and stored claims are untrusted text: one line each, so
  // neither can forge a line of this message (safe-text.mjs).
  const failure = stats.top?.raw || stats.top?.text;
  if (failure) lines.push(`The failure that keeps returning: ${safeLine(failure)}`);
  lines.push(
    'Stop repeating the last approach. Re-read that error, name the assumption behind the last fix and test it directly, or try a different route. If you are blocked on something only the user can answer, ask.'
  );
  if (findings.length) {
    lines.push('Recorded earlier about the files involved:');
    for (const finding of findings.slice(0, 3)) {
      lines.push(`- [${safeLine(String(finding.type || 'finding'))}] ${safeLine(String(finding.claim)).slice(0, 220)}`);
    }
  }
  return lines.join('\n');
}

/** Findings the graph holds about the files this turn's failures and edits touched. */
export async function findingsForTurn(dir, stats) {
  const paths = new Set([...(stats.top?.paths || []), ...stats.editedPaths]);
  if (!paths.size) return [];
  try {
    const { load, findingsFor, nodeId } = await import('./wiki.mjs');
    const graph = load(dir);
    const out = [];
    const seen = new Set();
    for (const path of paths) {
      for (const finding of findingsFor(graph, nodeId('file', path), { limit: 5 })) {
        if (seen.has(finding.id)) continue;
        seen.add(finding.id);
        out.push(finding);
      }
    }
    // Dead ends and failures first: they are what a stuck turn most needs.
    const rank = (finding) => (/dead|fail|pitfall|gotcha|avoid/i.test(String(finding.type)) ? 0 : 1);
    return out.sort((a, b) => rank(a) - rank(b)).slice(0, 3);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// The optional judge.

function judgeVerdictPath(sessionId, turnKey) {
  const safe = (value) => String(value || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
  return join(stateRoot(), 'loopguard', `judge-${safe(sessionId)}-${safe(turnKey)}.json`);
}

/** A digest of the turn's actions -- tool names, paths, failure signatures, never file contents. */
export function turnDigest(calls) {
  return calls
    .slice(-30)
    .map((call, index) => {
      const target = call.path || call.command || '';
      const outcome = call.ok === false ? `FAILED: ${call.sig?.text || ''}` : call.ok ? 'ok' : 'pending';
      return `${index + 1}. ${call.name} ${String(target).slice(0, 120)} -> ${outcome}`;
    })
    .join('\n');
}

export function judgePrompt(digest) {
  return [
    'You are checking whether a coding agent is stuck in a failure loop on its current task.',
    'Below are its most recent tool calls and their outcomes.',
    'A turn is STUCK if it keeps retrying variations of the same failing approach without new information.',
    'It is NOT stuck if each failure teaches something new or the failures are narrowing toward a fix.',
    'Answer with JSON only: {"stuck": true|false, "confidence": 0..1, "hint": "<one sentence on what to try instead>"}',
    '',
    digest,
  ].join('\n');
}

export function parseJudge(text) {
  const match = String(text ?? '').match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]);
    const confidence = Number(parsed.confidence);
    if (typeof parsed.stuck !== 'boolean' || !Number.isFinite(confidence)) return null;
    return { stuck: parsed.stuck, confidence: Math.max(0, Math.min(1, confidence)), hint: String(parsed.hint || '').slice(0, 300) };
  } catch {
    return null;
  }
}

function launchJudge(sessionId, turnKey, digest, dir, env) {
  try {
    const child = spawn(
      process.execPath,
      [fileURLToPath(import.meta.url), '--judge', sessionId, turnKey, dir],
      { cwd: tmpdir(), detached: true, stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true, env: { ...env } }
    );
    child.stdin.end(digest);
    child.unref();
    return true;
  } catch {
    return false;
  }
}

async function judgeMain([sessionId, turnKey, dir]) {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const digest = Buffer.concat(chunks).toString('utf8');
  const output = await new Promise((resolveRun) => {
    let out = '';
    let child;
    try {
      // The prompt goes on stdin: under `shell: true` (needed for the .cmd shim
      // on Windows) an argument with spaces would be split.
      child = spawn('claude', ['-p', '--model', 'haiku', '--output-format', 'json', '--max-turns', '1'], {
        cwd: tmpdir(),
        env: { ...process.env, TOKEN_OPTIMIZER_SIDECALL: '1' },
        stdio: ['pipe', 'pipe', 'ignore'],
        windowsHide: true,
        shell: process.platform === 'win32',
      });
    } catch {
      resolveRun(null);
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // Gone.
      }
      resolveRun(null);
    }, 90_000);
    child.on('error', () => {
      clearTimeout(timer);
      resolveRun(null);
    });
    child.stdout.on('data', (chunk) => {
      out += chunk.toString('utf8');
    });
    child.on('close', () => {
      clearTimeout(timer);
      resolveRun(out);
    });
    child.stdin.end(judgePrompt(digest));
  });
  let verdict = null;
  let usage = null;
  try {
    const parsed = JSON.parse(output || '');
    verdict = parseJudge(parsed.result);
    usage = parsed.usage || null;
    recordEvent(dir, { kind: 'judge', at: Date.now(), sessionId, turnKey, verdict, usage, costUsd: parsed.total_cost_usd ?? null });
  } catch {
    recordEvent(dir, { kind: 'judge-failed', at: Date.now(), sessionId, turnKey });
  }
  try {
    mkdirSync(join(stateRoot(), 'loopguard'), { recursive: true, mode: 0o700 });
    writeAtomically(judgeVerdictPath(sessionId, turnKey), JSON.stringify(verdict || { stuck: false, confidence: 0 }));
  } catch {
    // The turn simply goes unjudged.
  }
}

function readJudgeVerdict(sessionId, turnKey) {
  try {
    return JSON.parse(readFileSync(judgeVerdictPath(sessionId, turnKey), 'utf8'));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// The hook entry point.

/**
 * Called on a failed tool call (PostToolUseFailure on Claude Code).
 *
 * @returns {Promise<{additionalContext?: string, systemMessage?: string} | null>}
 */
export async function onToolFailure({ dir, sessionId, transcriptPath, payload = {}, env = process.env, now = Date.now() }) {
  const settings = loopguardSettings(env);
  if (!settings.enabled || env.TOKEN_OPTIMIZER_SIDECALL) return null;
  // Subagent turns have no person to notify and their own short horizon.
  if (payload.agent_id || payload.agentId) return null;
  const turn = currentTurn(transcriptPath);
  // The failing call may not be in the transcript yet; count it from the payload.
  const name = String(payload.tool_name || payload.toolName || 'tool');
  const error = typeof payload.error === 'string' ? payload.error : JSON.stringify(payload.error ?? '');
  if (payload.is_interrupt === true || payload.isInterrupt === true || isSteering(error)) return null;
  const id = String(payload.tool_use_id || payload.toolUseId || '');
  const known = id && turn.calls.some((call) => call.id === id);
  const calls = known
    ? turn.calls
    : [
        ...turn.calls,
        {
          name,
          path: payload.tool_input?.file_path || null,
          command: typeof payload.tool_input?.command === 'string' ? payload.tool_input.command.slice(0, 200) : null,
          ok: false,
          sig: failureSignature(name, error),
        },
      ];
  const turnKey = turn.turnKey || 'unknown';
  const stats = turnStats(calls);
  const envelope = envelopeSummary(loadEnvelope(dir), settings);
  const verdict = classifyTurn(stats, envelope, settings);
  if (verdict.level === 'none') return null;

  let turnState = loadSessionState(sessionId);
  if (turnState.turnKey !== turnKey) turnState = { turnKey, redirects: 0, notified: false, judgeLaunched: false };

  if (turnState.redirects >= settings.nudges) {
    if (turnState.notified) return null;
    turnState.notified = true;
    saveSessionState(sessionId, turnState);
    recordEvent(dir, { kind: 'notice', at: now, sessionId, turnKey, reason: verdict.reason, calls: stats.calls });
    return {
      systemMessage: `token-optimizer: this turn still looks stuck after a redirect (${verdict.reason}, ${stats.calls} tool calls). Press Esc to interrupt it.`,
    };
  }

  let reason = verdict.reason;
  let hint = '';
  if (verdict.level === 'suspect' && settings.judge) {
    const judged = readJudgeVerdict(sessionId, turnKey);
    if (!judged) {
      if (!turnState.judgeLaunched) {
        turnState.judgeLaunched = launchJudge(sessionId, turnKey, turnDigest(calls), dir, env);
        saveSessionState(sessionId, turnState);
      }
      return null;
    }
    if (!judged.stuck || judged.confidence < settings.judgeConfidence) return null;
    reason = `${reason}; judge ${judged.confidence.toFixed(2)}`;
    hint = judged.hint || '';
  }

  turnState.redirects += 1;
  saveSessionState(sessionId, turnState);
  const findings = await findingsForTurn(dir, stats);
  recordEvent(dir, {
    kind: 'redirect',
    at: now,
    sessionId,
    turnKey,
    level: verdict.level,
    reason,
    calls: stats.calls,
    findings: findings.length,
  });
  let text = redirectText(stats, reason, findings);
  if (hint) text += `\nA reviewer suggests: ${safeLine(hint)}`;
  return { additionalContext: text };
}

if (process.argv[2] === '--judge' && process.argv[1] && fileURLToPath(import.meta.url) === resolvePath(process.argv[1])) {
  judgeMain(process.argv.slice(3)).catch(() => {
    // The turn simply goes unjudged.
  });
}
