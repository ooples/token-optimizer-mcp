/**
 * Phase 0: does the API accept history with old thinking blocks REMOVED?
 *
 * The whole substitution design rests on this. `frontier.ts` refuses to touch a
 * signed block, citing HeadRoom's issue #3456 -- but that is THEIR bug report,
 * we have never tested it, and removal is not the same operation as rewriting.
 * A signature covers block CONTENT: delete the block and there is nothing left
 * to mismatch; rewrite it and a mismatch is guaranteed.
 *
 * Three variants against one real conversation carrying real signatures:
 *
 *   control   untouched -- proves the request shape itself is valid, so a
 *             failure in the others is attributable to the edit and not to me
 *   removed   thinking dropped from every assistant turn but the newest
 *   rewritten thinking text changed, signature kept -- tests the inherited claim
 *
 * Cheap by construction: the smallest max_tokens the thinking budget allows,
 * and the reply is discarded.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const transcript = process.argv[2];
const rows = readFileSync(transcript, 'utf8')
  .split('\n')
  .filter((l) => l.trim())
  .map((l) => {
    try {
      return JSON.parse(l);
    } catch {
      return null;
    }
  })
  .filter(Boolean);

// Rebuild a wire-shaped conversation from the session log. Only assistant and
// user turns with array content, which is what the API takes.
const messages = [];
for (const r of rows) {
  const m = r.message;
  if (!m || (m.role !== 'assistant' && m.role !== 'user')) continue;
  if (!Array.isArray(m.content) || !m.content.length) continue;
  messages.push({ role: m.role, content: m.content });
}

// A tool_use with no matching tool_result is a 400 for reasons unrelated to
// thinking, so the probe stops at the last clean boundary: a user turn whose
// blocks are all tool_result, or a plain assistant text turn.
// It must also END on a user turn -- the model does not accept an assistant
// prefill, which the control arm caught on the first attempt.
// This transcript has no plain-text user turns at all -- every user message is
// tool_result, which is the shape of an agentic loop. Ending on one is valid;
// what must hold is that every tool_result in the slice has its tool_use.
function pairingHolds(msgs) {
  const ids = new Set();
  for (const m of msgs) {
    for (const b of m.content) if (b.type === 'tool_use' && b.id) ids.add(b.id);
  }
  for (const m of msgs) {
    for (const b of m.content) {
      if (b.type === 'tool_result' && !ids.has(b.tool_use_id)) return false;
    }
  }
  // And no tool_use may be left unanswered by the end of the slice.
  const answered = new Set();
  for (const m of msgs) {
    for (const b of m.content)
      if (b.type === 'tool_result') answered.add(b.tool_use_id);
  }
  return [...ids].every((id) => answered.has(id));
}

let cut = -1;
for (let i = 0; i < messages.length; i++) {
  if (messages[i].role !== 'user') continue;
  if (pairingHolds(messages.slice(0, i + 1))) cut = i;
}
if (cut < 0) throw new Error('no user turn with complete tool pairing');
const base = messages.slice(0, cut + 1);

const thinkingCount = (msgs) =>
  msgs.reduce(
    (n, m) => n + m.content.filter((b) => b.type === 'thinking').length,
    0
  );

// Newest assistant turn keeps its thinking; every earlier one loses it, and a
// message left with no blocks is dropped rather than sent empty.
function removeOldThinking(msgs) {
  let lastAssistant = -1;
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === 'assistant') {
      lastAssistant = i;
      break;
    }
  }
  return msgs
    .map((m, i) => {
      if (m.role !== 'assistant' || i === lastAssistant) return m;
      return { ...m, content: m.content.filter((b) => b.type !== 'thinking') };
    })
    .filter((m) => m.content.length > 0);
}

function rewriteThinking(msgs) {
  return msgs.map((m) => ({
    ...m,
    content: m.content.map((b) =>
      b.type === 'thinking'
        ? { ...b, thinking: `${b.thinking} (edited by the proxy)` }
        : b
    ),
  }));
}

const creds = JSON.parse(
  readFileSync(join(homedir(), '.claude', '.credentials.json'), 'utf8')
);
const token = creds.claudeAiOauth?.accessToken;
if (!token) throw new Error('no OAuth access token');

async function send(label, msgs) {
  const body = {
    model: 'claude-sonnet-4-6',
    // max_tokens must EXCEED thinking.budget_tokens; the control arm caught
    // this as a 400 on all three variants, which is what a control is for.
    max_tokens: 1100,
    thinking: { type: 'enabled', budget_tokens: 1024 },
    messages: msgs,
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
  let detail = '';
  if (!res.ok) {
    try {
      detail = JSON.parse(text).error?.message ?? text.slice(0, 200);
    } catch {
      detail = text.slice(0, 200);
    }
  }
  console.log(
    `${label.padEnd(10)} msgs=${String(msgs.length).padStart(2)} thinking=${String(thinkingCount(msgs)).padStart(2)}  HTTP ${res.status}` +
      (res.ok ? '  ACCEPTED' : `  REJECTED  ${detail}`)
  );
  return res.ok;
}

const removed = removeOldThinking(base);
const rewritten = rewriteThinking(base);

console.log(
  `base conversation: ${base.length} messages, ${thinkingCount(base)} thinking blocks\n`
);
const okControl = await send('control', base);
const okRemoved = await send('removed', removed);
const okRewritten = await send('rewritten', rewritten);

console.log('\n--- verdict ---');
if (!okControl) {
  console.log('INCONCLUSIVE: the untouched request was rejected, so nothing');
  console.log('below is attributable to the edits.');
} else {
  console.log(
    `removal of old thinking : ${okRemoved ? 'ACCEPTED -> substitution is buildable' : 'REJECTED -> stop, per the plan'}`
  );
  console.log(
    `rewriting a thinking block: ${okRewritten ? 'ACCEPTED -> the inherited #3456 constraint does NOT hold for us' : 'REJECTED -> the inherited constraint is real'}`
  );
}
