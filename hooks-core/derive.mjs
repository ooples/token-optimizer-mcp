/**
 * Findings from data we already hold, with no model call.
 *
 * WHY THIS EXISTS. The semantic harvest is on by default but its real gate is a
 * credential: `harvestMode()` returns `off:no-key` on any machine without one,
 * which is CI, corporate laptops, and every subscription-only login. This
 * repository's own graph is the evidence -- 2,965 symbol nodes, 904 file nodes,
 * 128 task nodes and ONE finding -- because the structural layer accumulates
 * from ordinary tool traffic while every verdict needed an API key this machine
 * does not have.
 *
 * Everything here is derived from outcomes, transitions and corrections that are
 * ALREADY RECORDED LOCALLY. Nothing is sent anywhere, nothing is billed, so
 * there is nothing to consent to and this runs by default. It is the only
 * finding producer on a machine without a key.
 *
 * PRECISION IS CAPPED, NOT CLAIMED. "Failed then succeeded" does not prove the
 * second command fixed the first -- an intervening edit, a dependency install or
 * a flaky test explains it just as well. So each detector carries a confidence
 * ceiling, the claim text says only what was OBSERVED, and the two shapes where
 * the observation supports no claim at all are refused rather than downgraded
 * (see `attemptKey` and the identical-text guard below).
 *
 * THIS MODULE WRITES NOTHING. It returns candidates; storing them, under a
 * budget, belongs to the caller.
 */

import { readMetrics, rereadsByAnchor } from './metrics.mjs';
import { readArchive, readTurns } from './transcript.mjs';
import { redact } from './redact.mjs';

/**
 * Ceilings, ordered by how much the evidence actually supports.
 *
 * A command that succeeded where a DIFFERENT command failed is close to a direct
 * observation. A test or build going red-to-green is weaker, because the usual
 * cause is the code changing between the two runs rather than anything about the
 * command. A correction is a lexical guess about what a human meant. Churn
 * describes our own reading behaviour and says nothing about the code at all.
 */
export const CONFIDENCE = { command: 0.9, test: 0.85, correction: 0.6, churn: 0.4 };

/** Claim text cap. A finding is one sentence; a paragraph is evidence. */
const CLAIM_MAX = 300;
const EVIDENCE_MAX = 400;

/** Bounded so a pathological log cannot turn session end into real work. */
const MAX_CANDIDATES = 200;

/**
 * Commands whose red-to-green transition is usually explained by the CODE
 * changing rather than by the command. They get the lower ceiling.
 */
const CODE_SENSITIVE = /\b(test|tests|jest|vitest|pytest|mocha|build|compile|tsc|lint|typecheck)\b/i;

/**
 * Openers that mark a user turn as a correction rather than an instruction.
 *
 * DELIBERATELY NARROW, and anchored to the START of the turn. The model-based
 * extractor in `lessons.mjs` can read intent; this cannot, so it only claims the
 * shapes where the first few words carry the whole signal. Recall is poor by
 * design: a missed correction costs one finding, a false one puts words in the
 * user's mouth at 0.6 confidence.
 */
const CORRECTION_OPENER =
  /^\s*(?:no+[,.!\s]|nope\b|wrong\b|stop\b|don'?t\b|do not\b|never\b|revert\b|undo\b|that'?s (?:not|wrong)\b|you (?:broke|were told|didn'?t|did not|ignored)\b|i (?:said|told you|already said)\b|as i said\b|why did you\b)/i;

/**
 * The prefix that makes two invocations "the same attempt".
 *
 * UP TO THREE NON-FLAG TOKENS, and both halves of that were found by working
 * through what the alternatives do to real command lines:
 *
 *   Two tokens conflates `npm run build` with `npm run test`, and the pair then
 *   produces "`npm run test` works where `npm run build` failed" -- a claim that
 *   is simply false.
 *
 *   Counting flags splits `deploy` from `deploy --retry`, which is the single
 *   most useful pair this detector can find, into two groups that never meet.
 *
 * Conservative in the remaining direction: `npm run build:prod` and
 * `npm run build` do not pair. A missed pair costs one finding; a wrong pair
 * ships a false claim into model context.
 */
export function attemptKey(command) {
  return String(command || '')
    .trim()
    .split(/\s+/)
    .filter((token) => token && !token.startsWith('-'))
    .slice(0, 3)
    .join(' ')
    .toLowerCase();
}

/** Normalised claim text, so the same lesson derived twice is one candidate. */
const claimKey = (type, claim) =>
  `${type}|${String(claim).toLowerCase().replace(/\s+/g, ' ').trim()}`;

/** 0.95 is reserved for verified; everything here is inference. */
const labelFor = (confidence) => (confidence >= 0.75 ? 'probable' : 'speculative');

/** A literal command prefix, safe to hand to `safeTrigger`. */
const triggerFor = (command) =>
  attemptKey(command).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').slice(0, 120) || undefined;

/**
 * Derives finding candidates from one project's local evidence.
 *
 * @param {string} dir wiki directory.
 * @param {object} options
 * @param {string|null} options.sessionId session this ran for, for provenance.
 * @param {string|null} options.transcriptPath live transcript, read only when the
 *   archive holds nothing for this session yet.
 * @param {string|null} options.projectRoot the anchor every derived claim gets.
 *   Without it nothing is derived: an unanchored finding cannot be invalidated
 *   and is refused by `writeHarvested` anyway, so emitting one would only spend
 *   the caller's budget on junk.
 * @param {string|null} options.authoritativeSessionId the session id as the HOOK
 *   PAYLOAD reported it, never a value a model typed. Returned untouched for the
 *   caller to pass to `writeHarvested`, which needs it to resolve the `answers`
 *   edge -- `taskForAnchors` returns null without one, so an unverified string
 *   would silently produce no edge. Threaded rather than defaulted from
 *   `sessionId`: defaulting would promote any caller's string to trusted.
 */
export function derive(dir, options = {}) {
  // `options || {}` rather than a destructuring default. A default only fires on
  // `undefined`, so a caller passing an explicitly null options object -- which
  // is what a hook does when it has nothing to say -- threw a TypeError out of
  // the parameter list itself, before any of the try/catch below could fail open.
  const {
    sessionId = null,
    transcriptPath = null,
    projectRoot = null,
    authoritativeSessionId = null,
  } = options || {};

  const result = {
    candidates: [],
    observations: [],
    written: [],
    sessionId,
    authoritativeSessionId,
  };

  let events;
  try {
    events = readMetrics(dir);
  } catch {
    // Session end must cost nothing. No evidence is not an error.
    return result;
  }
  if (!Array.isArray(events)) return result;

  const seen = new Set();
  const add = (candidate) => {
    if (result.candidates.length >= MAX_CANDIDATES) return;
    const key = claimKey(candidate.type, candidate.claim);
    if (seen.has(key)) return;
    seen.add(key);
    result.candidates.push(candidate);
  };

  // ---- 1 & 2: a failed attempt followed by a succeeding one ---------------
  //
  // The event is `tool-outcome` and THE COMMAND TEXT IS IN `anchor`: there is no
  // separate command field, because the anchor of a command surface IS the
  // command. It is capped at 120 characters at the boundary, so a very long
  // command line is compared and quoted truncated.
  try {
    if (projectRoot) {
      const outcomes = events
        .filter(
          (e) =>
            e &&
            e.kind === 'tool-outcome' &&
            e.surface === 'command' &&
            typeof e.anchor === 'string' &&
            e.anchor.trim()
        )
        .map((e) => ({
          command: e.anchor.trim(),
          output: typeof e.output === 'string' ? e.output : '',
          exit: Number.isInteger(e.exit) ? e.exit : null,
          at: e.at ?? 0,
          // `success` FIRST, `exit` only as a refinement. MCP tools report no
          // numeric code at all, so a classifier keyed on `exit !== 0` would be
          // inert for most clients -- and `exit` is null rather than 0 precisely
          // so that absence is not read as a clean exit.
          failed: e.success === false || (Number.isInteger(e.exit) && e.exit !== 0),
        }))
        .sort((a, b) => a.at - b.at);

      const byAttempt = new Map();
      for (const outcome of outcomes) {
        const key = attemptKey(outcome.command);
        if (!key) continue;
        if (!byAttempt.has(key)) byAttempt.set(key, []);
        byAttempt.get(key).push(outcome);
      }

      for (const run of byAttempt.values()) {
        // The NEAREST preceding failure, not the first one in the session. With
        // `find` over the whole run, a command that failed at 09:00 and
        // succeeded at 17:00 after nine unrelated attempts is reported as one
        // story.
        let lastFailure = null;
        for (const outcome of run) {
          if (outcome.failed) {
            lastFailure = outcome;
            continue;
          }
          if (!lastFailure) continue;
          const failed = lastFailure;
          // One pair per failure: a command that succeeds twice afterwards has
          // not taught two lessons.
          lastFailure = null;

          // THE GUARD THAT REMOVES THE LARGEST JUNK CLASS. The commonest shape
          // in a coding session is `npm run build` failing, the code being
          // fixed, and `npm run build` succeeding -- identical text. From that
          // pair the two available claims are "`npm run build` works where
          // `npm run build` failed", which is incoherent, and "`npm run build`
          // fails", which the same evidence has just disproved. The observation
          // is real and supports NEITHER claim, so nothing is emitted. This is
          // not a confidence question; a ceiling cannot rescue a claim whose
          // content is wrong.
          if (failed.command === outcome.command) continue;

          const codeSensitive =
            CODE_SENSITIVE.test(outcome.command) || CODE_SENSITIVE.test(failed.command);
          const confidence = codeSensitive ? CONFIDENCE.test : CONFIDENCE.command;
          const derivedBy = codeSensitive ? 'test-transition' : 'command-transition';

          // "SUCCEEDED WHERE", NOT "FIXES". What is observed is two outcomes in
          // order on the same attempt; that the difference in the command line
          // CAUSED the difference in outcome is not observed and is not claimed.
          add({
            type: 'command',
            claim: redact(
              `\`${outcome.command}\` succeeded in this project where \`${failed.command}\` failed`,
              { max: CLAIM_MAX }
            ),
            evidence: redact(
              `observed in one session: \`${failed.command}\` failed` +
                `${Number.isInteger(failed.exit) ? ` (exit ${failed.exit})` : ''}, then ` +
                `\`${outcome.command}\` succeeded. The two outcomes are ordered, not proven causal: ` +
                'an intervening edit or a flaky run explains the same pair.',
              { max: EVIDENCE_MAX }
            ),
            applicability: 'when about to run this command in this project',
            confidence,
            confidenceLabel: labelFor(confidence),
            scope: 'project',
            invalidators: ['the failing form later succeeds unchanged'],
            trigger: triggerFor(outcome.command),
            anchors: [projectRoot],
            derivedBy,
            sessionId,
            at: outcome.at || Date.now(),
          });

          // The error text, only when there is error text. Without it the claim
          // degrades to "`X` failed with:" and nothing after the colon, which
          // carries no information and still costs budget.
          const firstLine = failed.output.split('\n').find((line) => line.trim()) || '';
          if (firstLine.trim().length < 8) continue;
          add({
            type: 'failure',
            claim: redact(`\`${failed.command}\` failed with: ${firstLine.trim()}`, {
              max: CLAIM_MAX,
            }),
            evidence: redact(`captured output of the failing run:\n${failed.output}`, {
              max: EVIDENCE_MAX,
            }),
            applicability: 'when this command is about to be run in this project',
            confidence,
            confidenceLabel: labelFor(confidence),
            scope: 'project',
            invalidators: ['the same command later succeeds unchanged'],
            trigger: triggerFor(failed.command),
            anchors: [projectRoot],
            derivedBy,
            sessionId,
            at: failed.at || Date.now(),
          });
        }
      }
    }
  } catch {
    // One detector, never the session.
  }

  // ---- 3: user corrections ------------------------------------------------
  //
  // A `feedback` finding -- the one type whose source is a person saying the
  // agent was wrong. The MODEL-BASED extractor for this lives in `lessons.mjs`
  // and needs the credential this module exists to do without, so here the
  // signal is lexical: the opening words of the user's own turn.
  //
  // ORIGIN IS NOT PROMOTED. `writeHarvested` grants ORIGIN_HUMAN to a finding
  // carrying a verified verbatim quote, and the standing-rules layer selects on
  // that origin to inject a claim on EVERY turn. The quote here would be
  // verbatim -- it is copied out of the archive -- but whether the turn was a
  // correction at all is a guess, and a guess must not buy always-on injection.
  // So no `origin` and no `quote` field: this stays harvested provenance.
  try {
    if (projectRoot) {
      let turns = readArchive(dir, sessionId);
      // The archive is written by the Stop hook too, and the order of the two is
      // not this module's to assume, so fall back to the live transcript.
      if (!turns.length && transcriptPath) turns = readTurns(transcriptPath);

      for (const turn of turns) {
        if (!turn || turn.role !== 'user') continue;
        const text = String(turn.text || '').trim();
        // Long turns are new instructions with a complaint somewhere inside
        // them; truncating one into a claim would misquote the user.
        if (text.length < 12 || text.length > 300) continue;
        if (!CORRECTION_OPENER.test(text)) continue;
        add({
          type: 'feedback',
          claim: redact(text, { max: CLAIM_MAX }),
          evidence: redact(`the user opened a turn with a correction: "${text}"`, {
            max: EVIDENCE_MAX,
          }),
          applicability: 'when working in this project, before repeating what was corrected',
          confidence: CONFIDENCE.correction,
          confidenceLabel: labelFor(CONFIDENCE.correction),
          scope: 'project',
          invalidators: ['the user later asks for the corrected behaviour'],
          anchors: [projectRoot],
          derivedBy: 'correction',
          sessionId,
          at: Date.parse(turn.at || '') || Date.now(),
        });
      }
    }
  } catch {
    // One detector, never the session.
  }

  // ---- 4: re-read churn ---------------------------------------------------
  //
  // NOT A FINDING, AND THAT IS THE DECISION RATHER THAN AN OMISSION.
  //
  // Churn is a claim about OUR OWN reading behaviour: "this file was read three
  // times unchanged". Every finding type available is a claim about the work --
  // `map` describes how an area of the codebase is laid out, and is
  // content-dependent, so a churn claim filed as `map` would be checked for
  // staleness against contents it makes no claim about and flip stale on the
  // first edit to a file it never described. Worse, the anchors it would take
  // are by construction the HOTTEST files in the project, which are exactly the
  // files that already carry real findings, so a 0.4-confidence row saying
  // nothing actionable would sit in the injection budget beside them and render
  // on the same reads. Nothing a future agent could DO differently follows from
  // it: it does not say what the file contains, so it cannot substitute for
  // reading it.
  //
  // The signal is still worth having -- as the measurement it already is.
  // `rereadWaste` reports it on the balance sheet, `rereadsByAnchor` names the
  // offenders, and this returns those rows as OBSERVATIONS: computed, carried,
  // and deliberately not competing for context. Three detectors produce
  // findings; the fourth produces a number.
  try {
    for (const row of rereadsByAnchor(events).slice(0, 3)) {
      if (!row.anchor || row.wasteful < 2) continue;
      result.observations.push({
        kind: 'churn',
        anchor: row.anchor,
        repeats: row.repeats,
        wasteful: row.wasteful,
        tokens: row.tokens,
        confidence: CONFIDENCE.churn,
        derivedBy: 'churn',
        note: `re-read ${row.repeats} times, ${row.wasteful} of them unchanged`,
      });
    }
  } catch {
    // One detector, never the session.
  }

  return result;
}
