/**
 * Does substitution destroy the evidence the NEXT action depended on?
 *
 * A recorded transcript carries ground truth: what the model actually did next,
 * with the full prefix in front of it. So the quality question needs no model
 * call and no API quota -- it needs the substituted prefix, the real next
 * action, and a check that the first still contains what the second cited.
 *
 * Stronger than a two-sample probe on one axis: that compares two generations
 * and calls agreement "quality", which cannot distinguish both arms being wrong
 * together. Here the action is a choice the model demonstrably made.
 *
 * ADVERSARIAL REVIEW BUILT IN, because the naive version of this is nearly
 * tautological and its first run flattered the feature badly. Four objections
 * and what each forced:
 *
 *  1. HAND-PICKED NEEDLES. I first read the next action, chose the interesting
 *     tokens, then checked they survived -- selecting evidence after seeing the
 *     outcome. Needles are now extracted mechanically from the action itself.
 *
 *  2. SURVIVAL IS NEARLY GUARANTEED BY CONSTRUCTION. The transform removes
 *     reasoning and keeps tool results and text, while an agent's evidence
 *     mostly lives in tool results -- so "it survived" is close to restating
 *     the design. The metric that carries information is the opposite one:
 *     how many needles appeared ONLY inside content that was removed. That is
 *     reported first and is the number to read.
 *
 *  3. A TOKEN CAN SURVIVE SOMEWHERE IRRELEVANT. Counting occurrences anywhere
 *     rewards a coincidental match. Needles are counted in the retained text,
 *     and one-character or ubiquitous tokens are discarded before counting.
 *
 *  4. THE CORPUS MAY CONTAIN NOTHING TO REMOVE. Claude Code transcripts store
 *     `thinking: ""` and keep only the signature, so on that data this measures
 *     the removal of cryptographic noise rather than of reasoning. The run
 *     REPORTS the split between removed signature bytes and removed reasoning
 *     text, and says plainly when the reasoning side is zero -- because a clean
 *     result on zero removed reasoning is not evidence about reasoning removal.
 *
 * Usage:
 *   node bench/compression/evidence-survival.mjs <transcript.jsonl> [more...]
 */

import { readFileSync } from 'node:fs';
import { substituteHistory } from '../../dist/compress/history.js';

/** Rebuild the wire shape: consecutive same-role rows are one message. */
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

/**
 * Tokens the next action depends on, taken from the action MECHANICALLY.
 *
 * Paths, identifiers and numbers out of the tool input and the assistant's own
 * text. Deliberately not chosen by a human who has already seen whether they
 * survived -- that is the selection bias objection, and it is the one that most
 * flatters a result.
 *
 * Short and ubiquitous tokens are dropped: a needle that appears in every
 * request proves nothing about this one, and a two-character match is noise.
 */
function needlesFrom(message) {
  if (!message || !Array.isArray(message.content)) return [];
  const found = new Set();
  const harvest = (s) => {
    if (typeof s !== 'string') return;
    for (const m of s.matchAll(/[A-Za-z_][A-Za-z0-9_./\\-]{5,}|\b\d{4,}\b/g)) {
      found.add(m[0]);
    }
  };
  for (const b of message.content) {
    if (b?.type === 'tool_use') {
      harvest(JSON.stringify(b.input ?? {}));
    } else if (b?.type === 'text') {
      harvest(b.text);
    }
  }
  // Words a transcript is saturated with carry no discriminating power.
  const NOISE = new Set([
    'assistant',
    'function',
    'content',
    'message',
    'command',
    'file_path',
  ]);
  return [...found].filter((n) => !NOISE.has(n.toLowerCase()));
}

/** Everything a reader can still see, as one searchable string. */
function retainedText(messages) {
  const parts = [];
  for (const m of messages) {
    for (const b of Array.isArray(m.content) ? m.content : []) {
      if (typeof b?.text === 'string') parts.push(b.text);
      else if (b?.type === 'tool_use') parts.push(JSON.stringify(b.input ?? {}));
      else if (b?.type === 'tool_result')
        parts.push(
          typeof b.content === 'string' ? b.content : JSON.stringify(b.content)
        );
    }
  }
  return parts.join('\n');
}

/** Only the reasoning, which is the content this transform removes. */
function reasoningText(messages) {
  const parts = [];
  for (const m of messages) {
    for (const b of Array.isArray(m.content) ? m.content : []) {
      if (b?.type === 'thinking' || b?.type === 'redacted_thinking') {
        if (typeof b.thinking === 'string') parts.push(b.thinking);
        if (typeof b.data === 'string') parts.push(b.data);
      }
    }
  }
  return parts.join('\n');
}

function signatureBytes(messages) {
  let n = 0;
  for (const m of messages) {
    for (const b of Array.isArray(m.content) ? m.content : []) {
      if (typeof b?.signature === 'string') n += b.signature.length;
    }
  }
  return n;
}

const totals = {
  turns: 0,
  needles: 0,
  onlyInRemoved: 0,
  lost: 0,
  removedReasoning: 0,
  removedSignature: 0,
};
const examples = [];

for (const path of process.argv.slice(2)) {
  const messages = messagesFrom(path);
  const cuts = [];
  for (let i = 0; i < messages.length - 1; i += 1) {
    if (messages[i].role === 'user' && messages[i + 1].role === 'assistant') {
      if (needlesFrom(messages[i + 1]).length) cuts.push(i + 1);
    }
  }

  let turns = 0;
  let needles = 0;
  let onlyInRemoved = 0;
  let lost = 0;

  for (const cut of cuts) {
    const control = messages.slice(0, cut);
    const sub = substituteHistory(control);
    const kept = retainedText(sub.messages);
    const removed = reasoningText(control);
    const list = needlesFrom(messages[cut]);

    turns += 1;
    for (const n of list) {
      needles += 1;
      const inKept = kept.includes(n);
      const inRemoved = removed.includes(n);
      // THE NUMBER THAT CARRIES INFORMATION. A needle present only in content
      // the transform deleted is evidence the next action depended on and can
      // no longer see.
      if (!inKept && inRemoved) {
        onlyInRemoved += 1;
        if (examples.length < 8) {
          examples.push(`${path.split(/[\\/]/).pop().slice(0, 8)} turn ${cut}: "${n}"`);
        }
      }
      if (!inKept) lost += 1;
    }

    totals.removedReasoning += removed.length;
    totals.removedSignature += signatureBytes(control) - signatureBytes(sub.messages);
  }

  totals.turns += turns;
  totals.needles += needles;
  totals.onlyInRemoved += onlyInRemoved;
  totals.lost += lost;

  console.log(
    `${path.split(/[\\/]/).pop().slice(0, 8)}  ${String(turns).padStart(4)} turns  ` +
      `${String(needles).padStart(6)} needles  ` +
      `only-in-removed ${String(onlyInRemoved).padStart(4)}  ` +
      `absent-entirely ${String(lost).padStart(5)}`
  );
}

console.log(`\n${'='.repeat(70)}`);
console.log(`turns ${totals.turns}, needles ${totals.needles}`);
console.log(
  `  needles present ONLY in removed reasoning: ${totals.onlyInRemoved}` +
    (totals.needles
      ? ` (${((100 * totals.onlyInRemoved) / totals.needles).toFixed(3)}%)`
      : '')
);
console.log(
  `  needles absent from the retained prefix entirely: ${totals.lost}` +
    ` -- includes tokens the action INVENTED, which were never in any prefix`
);
console.log(
  `\nremoved bytes: ${totals.removedReasoning.toLocaleString()} reasoning text, ` +
    `${totals.removedSignature.toLocaleString()} signature`
);

// THE INSTRUMENT REPORTS ITS OWN VACUITY, and this guard needed the same
// adversarial pass as everything else. It first tested `removedReasoning === 0`
// and did not fire on a run where reasoning was 131,935 bytes against
// 296,562,068 of signature -- 0.04%, which is vacuous in every sense that
// matters while being non-zero. An exact-zero test is the wrong shape for a
// question about whether a quantity is NEGLIGIBLE.
const reasoningShare =
  totals.removedReasoning / Math.max(1, totals.removedReasoning + totals.removedSignature);
if (reasoningShare < 0.05) {
  console.log(
    `\nINCONCLUSIVE FOR REASONING REMOVAL. Reasoning is ${(100 * reasoningShare).toFixed(3)}% of what\n` +
      'was removed; the rest is signature. Claude Code transcripts store\n' +
      '`thinking: ""` and keep only the signature, and a signature carries no\n' +
      'information the next action could have depended on -- so a clean score\n' +
      'here is NOT evidence that removing real reasoning is safe. It measures\n' +
      'the deletion of cryptographic noise.\n\n' +
      'Answering the real question needs a corpus that retains reasoning text:\n' +
      'captured wire traffic, or a client configured to persist it. The harness\n' +
      'itself is ready for that data and needs no change.'
  );
  process.exit(3);
}
if (examples.length) {
  console.log('\nneedles found only in removed reasoning:');
  for (const e of examples) console.log(`  ${e}`);
}
