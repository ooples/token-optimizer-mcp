// GENERATED FILE -- do not edit.
// Source of truth: hooks-core/lessons.mjs. Regenerate with `npm run sync:hooks`.
/**
 * Turning corrections into lessons the next session actually receives.
 *
 * The signal this exists to capture is sparse and specific: the moments where
 * the user pushed back. Everything else in a session is ordinary work. Measured
 * on one real session, the graph recorded 4,053 file touches and none of the
 * three corrections the user actually gave -- which are the only turns that
 * carried information the code could not.
 *
 * TWO THINGS THIS MODULE REFUSES TO GUESS.
 *
 * 1. WHO SAID IT. A lesson is stored as a human assertion only when the
 *    extractor supplies the user's words verbatim AND those words are found in
 *    the archive. curate.mjs warns that "a hand-written assertion and a machine
 *    guess look identical three months later", and human origin carries the
 *    highest ranking weight -- so claiming it on a model's paraphrase would let
 *    an inference outrank the correction it was inferred from. Unverifiable
 *    quotes still store, as ORIGIN_HARVESTED.
 *
 * 2. WHEN IT APPLIES. Every lesson must carry a trigger. A lesson with no
 *    trigger can only surface if someone happens to open the file it is anchored
 *    to, which is not when advice about doing something is needed.
 *
 * AND ONE THING IT INSISTS ON: the action first. Measured in the injection A/B,
 * a correctly stored and correctly delivered finding was still ignored because
 * its instruction sat at the end of three sentences of context. Delivery is
 * necessary and not sufficient; phrasing is the other half.
 */

import { ORIGIN_HARVESTED, ORIGIN_HUMAN } from './curate.mjs';

/** Lessons longer than this are prose, not instructions. */
const MAX_CLAIM = 400;

/**
 * The extraction prompt.
 *
 * Deliberately narrow. Asked for "lessons" a model will summarise the session;
 * asked for corrections it returns the handful of turns that actually taught
 * something, which is the whole point of keeping the store sparse.
 */
export const LESSON_PROMPT = `You are reading a transcript between a user and a coding agent.

Extract ONLY the moments where the USER corrected, rejected, or redirected the agent —
where the agent did something the user did not want, and the user said so. Ignore
ordinary instructions, questions, and approvals. Most transcripts contain between zero
and five of these. Returning an empty list is a correct and common answer.

For each correction return an object with:
  "claim"   - the lesson, as an IMPERATIVE with the action FIRST. Start with a verb.
              Not "the user prefers X because Y" but "Do X. Y is why."
              Under ${MAX_CLAIM} characters. This is the sentence a future agent reads
              at the moment it is about to make the same mistake, so it must lead with
              what to do, not with background.
  "quote"   - the user's own words that constitute the correction, copied EXACTLY from
              the transcript. Do not paraphrase, do not fix typos, do not add quotes.
  "trigger" - a JavaScript regex source matching the situation where this applies, e.g.
              "\\\\bnpx\\\\s+jest\\\\b" or "git\\\\s+push" or "\\\\.csproj". If the lesson is about a
              tool or command, match that. Required.
  "anchors" - array of absolute file paths the lesson concerns. May be empty.

Return ONLY a JSON array. No prose, no markdown fence.`;

/**
 * Builds the extractor input from archived turns.
 *
 * Assistant tool RESULTS never entered the archive, so they cannot enter here.
 * What is sent is the conversation: what was asked, what was answered, and which
 * commands were run.
 */
export function buildFeedbackDigest(turns, { maxChars = 40_000 } = {}) {
  if (!Array.isArray(turns) || !turns.length) return null;

  const rendered = turns.map((t) => {
    if (t.role === 'user') return `USER: ${t.text}`;
    const tools = (t.tools || [])
      .map((x) => (x.command ? `${x.name}(${x.command})` : x.name))
      .filter(Boolean)
      .slice(0, 8)
      .join(', ');
    const head = t.text ? `AGENT: ${t.text}` : 'AGENT:';
    return tools ? `${head}\n  [tools: ${tools}]` : head;
  });

  // KEEP THE END, not the beginning. Corrections cluster where the work went
  // wrong, and a transcript that needed correcting tends to have gone wrong
  // later rather than sooner.
  let out = [];
  let total = 0;
  for (let i = rendered.length - 1; i >= 0; i--) {
    const piece = rendered[i];
    if (total + piece.length > maxChars) break;
    out.unshift(piece);
    total += piece.length;
  }
  return out.length ? out.join('\n\n') : null;
}

/**
 * True when the quote really appears in the archive, allowing for whitespace.
 *
 * CASE IS PART OF VERBATIM. Lower-casing both sides accepted a quote whose
 * capitalisation never occurred -- `NO, USE NPM TEST` matched a transcript
 * saying `no, use npm test` -- and that quote then earned ORIGIN_HUMAN and 0.95
 * confidence on the strength of a check it had not actually passed. The prompt
 * asks for an exact copy, so this asks for one.
 *
 * Whitespace IS still normalised: line wrapping is an artefact of how the turn
 * was stored, not something the user chose.
 */
export function quoteIsVerbatim(quote, turns) {
  // A missing archive is not a match. `buildFeedbackDigest` guards its input in
  // this same module; without the same guard here a null archive threw a
  // TypeError out of a validator whose entire job is to reject bad input.
  if (!Array.isArray(turns)) return false;
  const needle = String(quote || '').trim().replace(/\s+/g, ' ');
  if (needle.length < 8) return false;
  return turns
    .filter((t) => t && t.role === 'user')
    .some((t) => String(t.text).replace(/\s+/g, ' ').includes(needle));
}

/**
 * A claim that leads with a bare verb, which is what makes it an instruction.
 *
 * A POSITIVE RULE, NOT A DENYLIST. The denylist rejected the openings a
 * paraphrase usually starts with -- `the user prefers`, `you should` -- and
 * accepted everything else, so `npm test is preferred over npx jest.` passed
 * and was stored as a standing rule despite being a description rather than an
 * instruction. Any noun-led sentence walked straight through.
 *
 * The test is now positive: the first word must be a bare verb form. That is
 * still not a parts-of-speech tagger, but it fails CLOSED -- an unrecognised
 * opening is rejected rather than admitted, which is the right direction for a
 * gate on text that becomes an always-on instruction.
 */
const IMPERATIVE_VERBS = new Set([
  'use', 'run', 'call', 'prefer', 'avoid', 'never', 'always', 'do', "don't", 'dont',
  'stop', 'start', 'check', 'verify', 'confirm', 'read', 'write', 'edit', 'add',
  'remove', 'delete', 'fix', 'keep', 'make', 'set', 'pass', 'build', 'test',
  'install', 'update', 'rebase', 'merge', 'commit', 'push', 'pull', 'fetch',
  'branch', 'open', 'close', 'ask', 'report', 'measure', 'record', 'skip',
  'ignore', 'include', 'exclude', 'treat', 'assume', 'ensure', 'require',
  'apply', 'revert', 'restore', 'replace', 'rename', 'move', 'copy', 'create',
  'wait', 'retry', 'log', 'print', 'return', 'throw', 'catch', 'handle',
  'quote', 'escape', 'sanitise', 'sanitize', 'validate', 'reject', 'accept',
]);

export function isImperative(claim) {
  const first = String(claim || '')
    .trim()
    .split(/\s+/)[0]
    .replace(/[^A-Za-z']/g, '')
    .toLowerCase();
  if (!first) return false;
  return IMPERATIVE_VERBS.has(first);
}

/**
 * Validates extractor output and decides each lesson's origin.
 *
 * Returns { lessons, rejected } so a caller can report what was dropped rather
 * than silently storing less than it was given.
 */
export function validateLessons(raw, turns) {
  let parsed = raw;
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g, ''));
    } catch {
      return { lessons: [], rejected: [{ reason: 'unparseable', raw: String(raw).slice(0, 200) }] };
    }
  }
  if (!Array.isArray(parsed)) {
    return { lessons: [], rejected: [{ reason: 'not-an-array' }] };
  }

  const lessons = [];
  const rejected = [];

  for (const item of parsed) {
    const claim = String(item?.claim || '').trim();
    const trigger = String(item?.trigger || '').trim();
    const quote = String(item?.quote || '').trim();

    if (claim.length < 12) {
      rejected.push({ reason: 'claim-too-short', claim });
      continue;
    }
    if (claim.length > MAX_CLAIM) {
      rejected.push({ reason: 'claim-too-long', claim: claim.slice(0, 80) });
      continue;
    }
    if (!trigger) {
      // Without one it can only surface by file touch, which is not when advice
      // about an action is needed.
      rejected.push({ reason: 'no-trigger', claim: claim.slice(0, 80) });
      continue;
    }
    try {
      new RegExp(trigger);
    } catch {
      rejected.push({ reason: 'bad-trigger-regex', trigger });
      continue;
    }
    if (!isImperative(claim)) {
      rejected.push({ reason: 'not-imperative', claim: claim.slice(0, 80) });
      continue;
    }

    // THE PROVENANCE TEST. Verbatim and present means the user really said it.
    const verified = quoteIsVerbatim(quote, turns);

    lessons.push({
      type: 'feedback',
      claim,
      trigger,
      quote: verified ? quote : undefined,
      origin: verified ? ORIGIN_HUMAN : ORIGIN_HARVESTED,
      // A verified human correction is as close to ground truth as this system
      // gets. An unverified paraphrase is a model's reading of one.
      confidence: verified ? 0.95 : 0.6,
      anchors: Array.isArray(item?.anchors)
        ? item.anchors.filter((a) => typeof a === 'string' && a.trim())
        : [],
    });
  }

  return { lessons, rejected };
}
