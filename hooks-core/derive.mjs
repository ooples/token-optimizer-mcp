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
 * THREE SOURCES, NOT TWO. `tool-outcome` events, the transcript archive, and --
 * since the transition detectors were measured to have no input at all on the
 * primary client -- the raw transcript's FAILED tool results, which is the only
 * place a Claude Code failure is recorded (`failedResultsFromTranscript` in
 * transcript.mjs, and the note above `quotable` for what that measurement
 * actually yielded).
 *
 * PRECISION IS CAPPED, NOT CLAIMED. "Failed then succeeded" does not prove the
 * second command fixed the first -- an intervening edit, a dependency install or
 * a flaky test explains it just as well. So each detector carries a confidence
 * ceiling, the claim text says only what was OBSERVED, and the two shapes where
 * the observation supports no claim at all are refused rather than downgraded
 * (see `attemptKey` and the identical-text guard below).
 *
 * WHAT IS STORED IS BOUNDED. Candidates go through `selectForConsolidation`
 * before `writeHarvested`, so a long session cannot spend the whole retrieval
 * budget of every later session on one afternoon's exit codes. Nothing enters
 * the graph unbudgeted, and nothing enters it wearing a human origin.
 */

import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { readMetrics, rereadsByAnchor } from './metrics.mjs';
import {
  readArchive,
  readTurns,
  failedResultsFromTranscript,
} from './transcript.mjs';
import { redact } from './redact.mjs';
import { selectForConsolidation } from './consolidate.mjs';
import { writeHarvested } from './harvest-write.mjs';
import { load } from './wiki.mjs';
import { ORIGIN_HARVESTED } from './curate.mjs';
// Counting only -- see `searchGap` below. The SAME extractor the router advises
// from, so what this counts as a search and what the advisory treats as one
// cannot diverge.
import {
  commandSegments,
  identifiersIn,
  searchPatternFromCommand,
  symbolIndex,
} from './advise.mjs';

/**
 * Ceilings, ordered by how much the evidence actually supports.
 *
 * A command that succeeded where a DIFFERENT command failed is close to a direct
 * observation. A test or build going red-to-green is weaker, because the usual
 * cause is the code changing between the two runs rather than anything about the
 * command. A correction is a lexical guess about what a human meant. Churn
 * describes our own reading behaviour and says nothing about the code at all.
 */
export const CONFIDENCE = {
  command: 0.9,
  test: 0.85,
  // Below `command` because the inference is weaker: two commands sharing a
  // target is good evidence of one intent, but not the same evidence as the
  // identical invocation being retried. Labelled speculative, deliberately.
  retarget: 0.6,
  correction: 0.6,
  churn: 0.4,
};

/** Claim text cap. A finding is one sentence; a paragraph is evidence. */
const CLAIM_MAX = 300;
const EVIDENCE_MAX = 400;

/** Bounded so a pathological log cannot turn session end into real work. */
const MAX_CANDIDATES = 200;

/**
 * How close a fix must follow its failure to count as the same attempt.
 *
 * Detector 5 pairs across DIFFERENT programs, so it cannot lean on command
 * identity to know the two are related -- proximity is doing that work instead.
 * Ten minutes is long enough for a real correction, including reading an error
 * and looking something up, and short enough that two unrelated pieces of work
 * touching one file in an afternoon are not reported as one story.
 */
const RETARGET_WINDOW_MS = 10 * 60 * 1000;

/**
 * The anchor cap a command surface is stored under, restated here as a TEST.
 *
 * `recordToolOutcome` truncates `anchor` to 120 characters, so a command at or
 * over that length reached this module already cut -- and `quotable` below
 * refuses to build a claim out of the fragment.
 */
const COMMAND_ANCHOR_MAX = 120;

/**
 * Can this command text be QUOTED in a claim a reader could act on?
 *
 * THE SECOND REFUSAL OF ITS KIND, and it exists because measurement forced it.
 * Wiring the transcript reader gave the transition detectors their first real
 * input on this client and immediately produced four candidates at 0.9
 * confidence whose claim text read:
 *
 *   `cd /c/Users/.../token-optimizer-mcp\ncat >> docs/superpowers/plans/2026-` succeeded
 *   in this project where `cd /c/Users/.../token-optimizer-mcp\ncat > /tmp/probe3.mjs
 *   <<'EOF'\nimport { readdirSync, readFileSync, sta` failed
 *
 * -- two truncated fragments of throwaway shell scripts, grouped together only
 * because `attemptKey`'s three tokens were spent on `cd`, the absolute path, and
 * the verb. Then measured properly across three real transcripts: **0 of 83**
 * captured command failures are single-line and inside the cap. 65% of this
 * project's 2,178 successful command outcomes are not either. On this client a
 * "command" is usually a whole shell script, so the attempt identity the
 * transition detectors are built on does not fit most of the traffic.
 *
 * This is the same judgement as the identical-text guard below rather than a
 * confidence question: a claim whose subject is a truncated fragment of a
 * program is not a weaker claim, it is not a claim. A raised cap would not
 * rescue it -- quoting the whole 500-character heredoc is no more actionable.
 *
 * What survives is exactly what the detector was designed for: `npm test`,
 * `dotnet build X`, `deploy --retry` -- a repeatable command someone could run
 * again. This machine captured none failing, which is why the honest yield here
 * is zero and why that is reported rather than dressed up.
 *
 * Applied to BOTH sources. Where the evidence arrived from has no bearing on
 * whether the resulting sentence says anything, and a rule that let events
 * through would ship the junk on the ten clients that do report failures.
 */
const quotable = (command) => {
  const text = String(command || '');
  return (
    text.trim().length > 0 &&
    !/[\r\n]/.test(text) &&
    text.length < COMMAND_ANCHOR_MAX
  );
};

/**
 * Tokens that separate one command from the next rather than naming one.
 *
 * MEASURED, LIKE EVERY OTHER REFUSAL HERE. `attemptKey` spends up to three
 * non-flag tokens on identity, and the habit on this machine is
 * `cd <absolute path> && <the real command>` -- which spends all three on `cd`,
 * the path and `&&`, so the real command never enters the key. This project's
 * own evidence: the single key `cd c:/users/.../token-optimizer-mcp &&` covers
 * **539 distinct command lines**. One quotable failure in that group would pair
 * with an arbitrary unrelated success and claim "`cd repo && grep -n ...`
 * succeeded where `cd repo && git merge ...` failed", which is false about both.
 *
 * A KEY THAT REACHED A SEPARATOR NEVER REACHED A COMMAND, so there is no attempt
 * to compare and nothing to claim -- the same judgement as the identical-text
 * guard rather than a lower ceiling. Narrow on purpose: `2>&1` and `/F` are not
 * separators and do not trip this, so `cat commitlint.config.mjs 2>&1` and
 * `taskkill /F /PID 1 2>&1` keep their identity. Of the 8 quotable failures
 * found across 163 transcripts on this machine it refuses 2 and keeps 6.
 *
 * `commandBody` below now skips a leading `cd <path> &&`, so those two are
 * recovered and this guard is left holding only the keys that reached a
 * separator which is NOT a directory change -- `git fetch && <anything>`, a
 * pipeline, a `;`-joined pair. Those still name no single attempt.
 */
const COMMAND_SEPARATORS = new Set(['&&', '||', ';', '|', '&']);

/**
 * Did `attemptKey` actually capture a command, or only how one was chained?
 *
 * Read off the SAME key `attemptKey` produces, so the two cannot drift apart --
 * which now means AFTER `commandBody` has removed any leading `cd`, so this no
 * longer fires on the directory-change case it was written for.
 * One check per pair is enough: both halves share the key by construction.
 */
/**
 * THE WHOLE BODY, NOT THE FIRST THREE TOKENS.
 *
 * This used to read the separator set off `attemptKey`, which keeps only the
 * first three non-flag tokens -- so it caught a separator only when one landed
 * early by luck of position. Verified against the real functions:
 *
 *   git fetch && npx jest tests/foo   key `git fetch &&`        -> rejected
 *   npx jest tests/foo && node x.mjs  key `npx jest tests/foo`  -> ACCEPTED
 *   grep -rn foo src | head -20       key `grep foo src`        -> ACCEPTED
 *
 * The last two are exactly the claims this guard exists to stop: the key names
 * `npx`, so a pair would blame `npx` for a failure `node` may have caused.
 * Every existing test placed the separator in the first three tokens, so none
 * of them could see it.
 *
 * `commandSegments` is reused rather than a fresh scan because it is already
 * the quote-aware one: splitting the raw string would cut through `grep -E
 * "foo|bar"` and reject an ordinary alternation as a pipeline.
 *
 * A LEADING `cd <path> &&` is still accepted, because `commandBody` strips it
 * before this sees it -- that case is one command spelled two ways.
 *
 * A TRAILING SEPARATOR LEAVES NOTHING TO COUNT, which is the hole in reading
 * the segment count alone. `commandSegments` pushes only non-empty token
 * lists, so `npx jest tests/foo &&` is ONE segment, and `attemptKey` -- the
 * first three non-flag tokens -- never sees the `&&` either. The command is
 * still half of something, and `cmd &` on its own is a background job whose
 * exit code belongs to the shell rather than to the program named. Appending a
 * sentinel token makes the missing segment materialise, which reuses the one
 * scanner that already understands quotes instead of adding a second,
 * differently-wrong one: `grep -E "foo|bar" src/x.mjs` stays a single segment
 * with the sentinel attached, exactly as it does without it.
 */
// Not a plausible argument to anything, so it can only ever be the token this
// function appended.
const SEGMENT_SENTINEL = '__token_optimizer_segment_probe__';

const hasAttemptIdentity = (command) => {
  const body = commandBody(command);
  if (!body.trim()) return false;
  if (commandSegments(`${body} ${SEGMENT_SENTINEL}`).length > 1) return false;
  return attemptKey(command)
    .split(' ')
    .filter(Boolean)
    .every((token) => !COMMAND_SEPARATORS.has(token));
};

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
 * A leading directory change, stripped before the key is built.
 *
 * THE MEASURED CASE, AND ONLY THE MEASURED CASE. `attemptKey` spends up to
 * three non-flag tokens on identity and the habit on this machine is
 * `cd <absolute path> && <the real command>`, which spends all three on `cd`,
 * the path and the separator. This repository's own corpus: 1,400 of 2,243
 * command outcomes open with a `cd`, and the single key
 * `cd c:/users/.../token-optimizer-mcp &&` covered 547 distinct command lines.
 * A `cd` says WHERE a command ran; it says nothing about WHAT ran, so it cannot
 * be part of the identity of an attempt.
 *
 * THE SEPARATOR SET IS THE ONE THAT WAS OBSERVED: `&&` (1,147), a newline (204)
 * and `;` (38) after a leading `cd`. All three mean "then run this". `||` is
 * DELIBERATELY EXCLUDED even though it costs one line to add: `cd x || echo
 * failed` puts an error branch after the separator, not the next step, so
 * stripping there would key the attempt on a failure handler. It occurred zero
 * times.
 *
 * AND NOTHING WIDER, each refusal for a reason from the same corpus:
 *
 *   Environment assignments (`FOO=bar cmd`) DO carry information about what
 *   ran. The one true instance here is
 *   `TOKEN_OPTIMIZER_HOLDOUT=1 node ... jest.js ...`, and the holdout arm is a
 *   genuinely different attempt from the same command without it. The other 20
 *   are shell variable assignments joined by `;` -- statements, not prefixes --
 *   whose value is usually a 120-character path that would be stripped down to
 *   nothing useful.
 *
 *   `time`, `env`, `nice`, `sudo`, `bash -c`, `pushd`, `Set-Location`: ZERO
 *   occurrences in 2,243 commands. Code for an unmeasured prefix is a way to
 *   over-strip that no evidence asked for, and over-stripping merges commands
 *   that genuinely differ -- the same bug in the other direction. `bash -c` is
 *   worse than unmeasured: the command sits inside a quoted string, so stripping
 *   the wrapper leaves a key beginning with a quote character.
 *
 *   `cd /d C:\path &&` and `cd "C:/a b" &&` need no extra rule -- the match runs
 *   to the separator rather than counting tokens, so flags and quoted paths
 *   containing spaces are consumed for free. Neither appears here, so neither is
 *   claimed as tested behaviour beyond its unit test.
 *
 * A `cd` with NO separator is left alone: `cd <path>` on its own ran no command,
 * and its key is as meaningless afterwards as before -- there is nothing to
 * recover. Stripping is repeated up to `MAX_DIR_PREFIXES` times so
 * `cd a && cd b && cmd` reaches `cmd`; the bound exists only so a pathological
 * line cannot loop, since each pass must consume a whole `cd ... <sep>`.
 *
 * APPLIED IDENTICALLY TO BOTH SOURCES because it is applied INSIDE `attemptKey`,
 * which is the single function both the event path and the transcript reader's
 * output pass through. The 120-character anchor cap that makes the two agree on
 * 266 of 266 keys is untouched and still applied on both sides before this runs.
 */
const DIR_PREFIX = /^\s*cd\s[^\r\n;&|]*?(?:&&|;|\r?\n)\s*/i;
const MAX_DIR_PREFIXES = 4;

/**
 * The command text with any leading directory change removed.
 *
 * Used for the key AND for the identical-text refusal, which is the half that
 * keeps this from becoming a licence to pair more loosely: without it,
 * `cd repo && npm test` failing and `npm test` succeeding would emit
 * "`npm test` succeeded where `cd repo && npm test` failed" at 0.90 -- two
 * spellings of one attempt, dressed up as a difference that mattered. The
 * claim itself still quotes the RAW command, because that is what ran.
 */
export function commandBody(command) {
  let text = String(command || '');
  for (let i = 0; i < MAX_DIR_PREFIXES; i++) {
    const stripped = text.replace(DIR_PREFIX, '');
    if (stripped === text) break;
    text = stripped;
  }
  return text;
}

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
  return commandBody(command)
    .trim()
    .split(/\s+/)
    .filter((token) => token && !token.startsWith('-'))
    .slice(0, 3)
    .join(' ')
    .toLowerCase();
}
/**
 * The thing a command ACTS ON -- a path, a test file, a target.
 *
 * WHY `attemptKey` IS NOT ENOUGH, measured rather than supposed. That key is
 * program-plus-operands, so the single most valuable lesson a session can teach
 * cannot pair by construction:
 *
 *   npx jest tests/foo      -> key "npx jest tests/foo"
 *   npm test -- tests/foo   -> key "npm test tests/foo"
 *
 * Different keys, no pair, no finding -- yet that is exactly the correction
 * worth recording, because the fix was to run a DIFFERENT program against the
 * same target. The existing detector can only catch the same command re-run and
 * succeeding, which its own guard then discards as incoherent.
 *
 * The measured cost of that: across 937 real derive runs on this machine, 8
 * candidates were produced and ZERO were stored.
 *
 * So this returns the shared operand -- `tests/foo` above -- which is what the
 * two attempts genuinely have in common. Only operands that NAME something are
 * admitted: a path separator or a file extension. A bare word like `build` is
 * refused, because `npm run build` and `make build` sharing the token `build`
 * is a coincidence of vocabulary, not evidence of one intent.
 */
export function commandOperand(command) {
  const tokens = commandBody(command)
    .trim()
    .split(/\s+/)
    .filter((token) => token && !token.startsWith('-'));
  // Skipping the first token: the PROGRAM is what differs between the two
  // attempts, so including it would reproduce attemptKey's blind spot.
  for (const token of tokens.slice(1)) {
    const named = /[/\\]/.test(token) || /\.[A-Za-z0-9]{1,5}$/.test(token);
    // AS WRITTEN, not folded. This value is the grouping key AND the text of
    // the stored claim, and folding it made the claim name a path that does
    // not exist on a case-sensitive filesystem: `src/Foo.test.mjs` was
    // recorded, and served to a later session, as `src/foo.test.mjs`. The
    // caller folds a copy for the key instead, so matching stays
    // case-insensitive without the claim paying for it.
    if (named && token.length >= 4) return token;
  }
  return null;
}

/**
 * A leading `VAR=value` prefix, which a shell applies to the environment of
 * the command that follows rather than running as the command itself.
 */
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * The program a command invokes, for deciding whether two attempts differ.
 *
 * ENVIRONMENT PREFIXES ARE NOT THE PROGRAM. Taking the first token verbatim
 * reported `SP=/tmp/x` as the program for `SP=/tmp/x node run.mjs`, and that
 * is not a cosmetic slip: measured over this machine's real history, 816 of
 * 7,165 recorded command outcomes -- 11.4% -- named an assignment.
 *
 * IT FAILS IN THE DANGEROUS DIRECTION. This function exists to decide that two
 * attempts used DIFFERENT programs, so two runs of the same tool under
 * different variables --
 *
 *   SP=/a node run.mjs    (failed)
 *   SPW=/b node run.mjs   (succeeded)
 *
 * -- compared as `sp=/a` against `spw=/b`, differed, and were eligible to
 * pair. The claim that pairing produces is `node run.mjs` succeeded where
 * `node run.mjs` failed: exactly the incoherent statement detector 1's own
 * guard exists to refuse, arriving through the door detector 5 opened.
 *
 * Skipping the prefixes is what a shell does, and it cannot invent a pair --
 * two commands that were already the same program now compare equal, which
 * only ever removes a candidate.
 *
 * NO MEASURED CHANGE TODAY, stated plainly: replaying both versions over the
 * same real history gives an identical pairing outcome (20 pairs considered,
 * 0 firing), because every affected command is also chained and rejected
 * earlier. This is a correctness fix against a latent false claim, not a
 * recall improvement, and it is not offered as one.
 */
export function commandProgram(command) {
  const tokens = commandBody(command).trim().split(/\s+/).filter(Boolean);
  const first = tokens.find((token) => !ENV_ASSIGNMENT.test(token)) || '';
  return first.split(/[/\\]/).pop().toLowerCase();
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
 * Literal root-level files that define how a project is BUILT, RUN and TESTED,
 * best first. A `command` claim is a claim about this project's commands, and
 * this is the file those commands are declared in.
 */
const PROJECT_MARKERS = [
  'package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod', 'pom.xml',
  'build.gradle.kts', 'build.gradle', 'build.sbt', 'mix.exs', 'composer.json',
  'Gemfile', 'Package.swift', 'CMakeLists.txt', 'Makefile', 'Taskfile.yml',
  'requirements.txt', 'setup.py', 'deno.json', 'bun.lockb',
];

/** .NET has no single literal marker; the solution or project file is one. */
const DOTNET_MARKER = /\.(sln|slnx|csproj|fsproj|vbproj)$/i;

/**
 * A REAL FILE to anchor a derived claim to, inside the project root.
 *
 * WHY NOT THE PROJECT ROOT ITSELF, which is what the extraction step reaches
 * for and what `promoteToShared` uses in the shared tier. Because
 * `writeHarvested` resolves every anchor through `indexFile`, `indexFile` reads
 * the path, and reading a DIRECTORY returns null -- so a candidate anchored to
 * `projectRoot` resolves to nothing, is refused as unanchorable, and the whole
 * pipeline stores zero findings while reporting a healthy candidate count.
 * Verified directly: `indexFile(dir, dir)` returns null. That refusal is
 * correct and must not be weakened -- an anchor that cannot be indexed is an
 * anchor that can never be invalidated -- so the anchor has to be a file.
 *
 * STALENESS DOES NOT MISFIRE ON THIS. `command`, `failure` and `feedback` are
 * all outside `CONTENT_DEPENDENT` (staleness.mjs), so the anchor is a RETRIEVAL
 * AND EXISTENCE hook rather than a contents claim: editing the manifest does
 * not mark these findings stale. staleness.mjs names this exact case in its own
 * comment -- "a claim about `npm test` anchored to package.json" -- and calls
 * missing that invalidation the better error.
 *
 * A project with no recognisable marker gets the root back, which will not
 * resolve, so its candidates are derived and then refused rather than stored
 * against a fabricated anchor. That is the fail-open direction: no finding
 * beats a finding anchored to something that is not what the claim is about.
 */

/**
 * The project a session actually worked in, read off what it touched.
 *
 * WHY THE SESSION'S CWD IS THE WRONG ANSWER. `adapter.mjs` resolves the root
 * with `projectRootFor(join(cwd, '__session__'), cwd)`, and when Claude Code is
 * launched from a directory with no VCS marker -- a home directory, which is how
 * this machine runs it -- that returns the synthetic fallback
 * `~/.token-optimizer/unrooted`. It is NOT null, so every `if (projectRoot)`
 * gate passes, and then `projectAnchor` hands back the directory itself because
 * the fallback contains no project marker. `writeHarvested` resolves anchors
 * through `indexFile`, `indexFile` on a directory returns null, and the finding
 * is refused as unanchorable.
 *
 * That is the whole reason this machine's graph holds 2,965 symbols and ONE
 * finding: 937 derive runs produced candidates and stored none of them, while
 * every layer reported success.
 *
 * The router already solved this for capture -- "THE GRAPH IS PER PROJECT, so it
 * is keyed on where the FILE lives, not on where the client happens to be
 * running" -- and derivation simply never adopted it. This applies the same
 * rule at Stop time: take the file anchors the session recorded, resolve each to
 * its own project, and pick the one that holds the most of them.
 *
 * Returns null when nothing resolves, which leaves the caller's original root
 * untouched -- a wrong project is worse than the status quo.
 */
export function projectRootFromActivity(events, { resolve, cwd, sessionId = null } = {}) {
  if (typeof resolve !== 'function' || !Array.isArray(events)) return null;
  const counts = new Map();
  for (const event of events) {
    // SCOPED TO THIS SESSION when the caller knows its id. A graph outlives the
    // session that wrote it, and the caller concatenates several graphs, so
    // counting every event ever recorded lets a busy session from last week
    // outvote the one now ending -- and the question being asked is "where did
    // THIS session work", not "where is this graph busiest". Callers that pass
    // no id keep the whole-graph count.
    //
    // AN EVENT THAT CANNOT NAME ITS SESSION IS EXCLUDED, not exempted. Exempting
    // it was a deliberate concession to older records, and measurement says the
    // concession buys nothing: across the three live stores on this machine, 2
    // of 22,321 file/read events lack the field -- 0.01%. Set against that, an
    // unstamped event sitting in ANOTHER project's graph would vote for that
    // project on the strength of no evidence at all, which is precisely the
    // failure this filter exists to prevent.
    if (sessionId && event?.sessionId !== sessionId) continue;
    const anchor = event?.anchor;
    // File surfaces only. A command anchor is the command text, and resolving
    // `npm test -- x` as a path would invent a project out of a sentence.
    if (!anchor || typeof anchor !== 'string') continue;
    if (event.kind !== 'read' && !(event.kind === 'tool-outcome' && event.surface === 'file')) {
      continue;
    }
    let root;
    try {
      root = resolve(anchor, cwd);
    } catch {
      continue;
    }
    // The fallback resolves to a path inside the optimizer's own store, which is
    // never a project someone is working in.
    if (!root || String(root).includes('.token-optimizer')) continue;
    counts.set(root, (counts.get(root) || 0) + 1);
  }
  let best = null;
  let most = 0;
  let tied = false;
  for (const [root, n] of counts) {
    if (n > most) {
      most = n;
      best = root;
      tied = false;
    } else if (n === most) {
      // A Map iterates in insertion order, so a tie would otherwise be broken by
      // whichever file the session happened to touch first -- deterministic, but
      // arbitrary, and wrong half the time. Findings would then be stored against
      // a project the evidence does not single out. Decline instead; the caller
      // keeps cwdRoot, which is at least a root the user chose.
      tied = true;
    }
  }
  return tied ? null : best;
}

export function projectAnchor(projectRoot) {
  if (!projectRoot) return null;
  let entries;
  try {
    entries = readdirSync(projectRoot);
  } catch {
    return projectRoot;
  }
  const present = new Set(entries);
  for (const marker of PROJECT_MARKERS) {
    if (!present.has(marker)) continue;
    const path = join(projectRoot, marker);
    try {
      if (statSync(path).isFile()) return path;
    } catch {
      // A marker that cannot be stat'ed is not a marker.
    }
  }
  // Sorted so two sessions in the same repository pick the SAME solution file:
  // readdir order is not guaranteed stable across hosts, and an anchor that
  // varies by host splits one finding into two nodes.
  for (const entry of [...entries].sort()) {
    if (!DOTNET_MARKER.test(entry)) continue;
    const path = join(projectRoot, entry);
    try {
      if (statSync(path).isFile()) return path;
    } catch {
      // Same.
    }
  }
  return projectRoot;
}

/**
 * Tokens of claim text one session may add to the graph.
 *
 * SCALED TO THE RETRIEVAL BUDGET IT COMPETES FOR, not picked round. A single
 * command's injection budget is 500 tokens (`TOKEN_OPTIMIZER_TOUCH_BUDGET`),
 * and everything stored here is competing for that budget on every later
 * command, forever. Two touch-budgets per session is the bound: enough for a
 * few dozen real claims, and short of one session's exit codes crowding out
 * every finding a human or a model ever wrote.
 */
const storageBudget = () =>
  Number(process.env.TOKEN_OPTIMIZER_DERIVE_BUDGET) || 1000;

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
 *   PAYLOAD reported it, never a value a model typed. Passed straight to
 *   `writeHarvested`, which needs it to resolve the `answers` edge --
 *   `taskForAnchors` returns null without one, so an unverified string would
 *   silently produce no edge. Threaded rather than defaulted from `sessionId`:
 *   defaulting would promote any caller's string to trusted. Also returned, so a
 *   caller can see what it handed over.
 * @returns {object} `{ candidates, observations, written, selected, dropped,
 *   selectedTokens, searchGap, sessionId, authoritativeSessionId }`.
 *   `candidates` is everything derived; `written` is the subset of keys the
 *   graph actually holds, which is smaller for three independent reasons -- the
 *   budget, the anchor discipline, and the duplicate collapse that returns an
 *   EXISTING key when a later session derives the same claim again.
 */

/**
 * How many searches this session ran that the symbol index could NOT answer.
 *
 * MEASUREMENT, NOT A FEATURE. A detector that turns these into findings is
 * written and deliberately unmerged, because on the only workload we have
 * measured it produces nothing: replayed against a real warm rep, all seven
 * searches were for symbols the index already resolves --
 * `compute_settlement_fee` three times, `def parse_line` once, and three terms
 * with no identifier-shaped word at all. The search advisory answers every one
 * of those directly, so storing them again would spend the retrieval budget
 * restating a cheaper mechanism.
 *
 * The case that would justify the detector is a search for something the indexer
 * never extracts -- a config key, an error string, a literal, a symbol in a file
 * type it cannot parse. Eleven synthetic Python tasks cannot show whether that
 * happens in real work. This counts it instead of guessing: `gap` is the number
 * of searches carrying an identifier the index has no entry for, `named` the
 * number carrying one at all. A `gap` that stays near zero says the detector
 * should stay unmerged.
 *
 * Counting only. Nothing is stored, nothing is claimed, and it runs at session
 * end where the cost is already paid.
 */
export function searchGap(dir, events) {
  const out = { named: 0, gap: 0 };
  try {
    const index = symbolIndex(load(dir));
    for (const event of events) {
      if (!event || event.kind !== 'tool-outcome') continue;
      if (event.success === false || event.surface !== 'command') continue;
      const pattern = searchPatternFromCommand(event.anchor);
      if (!pattern) continue;
      const names = identifiersIn(pattern);
      if (!names.length) continue;
      out.named += 1;
      if (!names.some((name) => index.has(name))) out.gap += 1;
    }
  } catch {
    // A count is never worth failing a session for.
  }
  return out;
}

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

  // Measured, not stored. See `searchGap`: this decides whether the locate
  // detector is worth merging, and nothing here acts on it.
  result.searchGap = searchGap(dir, events);

  // ONE anchor for the whole run, so every candidate from this session points at
  // the same node and the duplicate collapse in `writeHarvested` can recognise
  // the same lesson across sessions.
  const anchorPath = projectAnchor(projectRoot);

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
  //
  // TWO SOURCES OF FAILURE, ONE PAIRING LOOP. Claude Code never fires
  // PostToolUse for a failed tool call -- 2,238 of 2,238 live `tool-outcome`
  // events on the measuring machine carry `success: true`, and a deliberately
  // failing command produced no event at all -- so on the primary client these
  // two detectors had NO INPUT WHATSOEVER while working normally on the ten
  // adapter clients. `failedResultsFromTranscript` supplies the missing half
  // from the only place it exists. The successes still come from events only:
  // a transcript failure that pairs with nothing stays unclaimed, which is also
  // what keeps a failure from ANOTHER project's directory out of this project's
  // graph -- a candidate cannot be emitted without a success recorded HERE.
  // HOISTED so detector 5 can pair over the SAME merged list -- events plus the
  // transcript failures folded in below. Rebuilding it there would duplicate the
  // de-duplication logic and let the two detectors drift; leaving it block-scoped
  // gave detector 5 a ReferenceError that its own try/catch swallowed, which is
  // silent nothing rather than a visible failure.
  let outcomes = [];
  try {
    if (projectRoot) {
      // SCOPED TO THE SESSION THE CLAIM WILL NAME.
      //
      // Every claim these detectors build opens `observed in one session:`,
      // and the store holds every session's outcomes -- so nothing but the
      // ten-minute window stopped a failure from one session pairing with a
      // success from another and asserting a provenance that never happened.
      //
      // NEVER OBSERVED, SAID PLAINLY. Across both live stores on this machine
      // -- 7,173 command outcomes over 3 sessions here, 543 over 9 sessions in
      // the unrooted one -- 5,155 and 298 adjacent in-window pairs respectively
      // and ZERO of them crossed a session. Sessions are long and rarely
      // interleave inside ten minutes. This is a correctness fix against a
      // false claim, not a fix for observed damage, and it is not offered as
      // one. Concurrent sessions do occur -- one was recorded on this machine
      // while this was being written -- and they share the unrooted store.
      //
      // The merged transcript failures below are deliberately NOT filtered:
      // `failedResultsFromTranscript` carries no sessionId, and the transcript
      // it read is this session's, so they are already scoped by construction.
      // Filtering them here would drop the only source of command failures
      // that exists -- Claude Code never fires PostToolUse on a non-zero exit.
      outcomes = events
        .filter(
          (e) =>
            e &&
            e.kind === 'tool-outcome' &&
            e.surface === 'command' &&
            typeof e.anchor === 'string' &&
            e.anchor.trim() &&
            // An event predating the field still counts; a DIFFERENT session
            // never does.
            (!sessionId || !e.sessionId || e.sessionId === sessionId)
        )
        .map((e) => ({
          command: e.anchor.trim(),
          output: typeof e.output === 'string' ? e.output : '',
          exit: Number.isInteger(e.exit) ? e.exit : null,
          at: e.at ?? 0,
          // Carried purely so the transcript merge below can recognise the same
          // tool call arriving from the other source.
          toolCallId: e.toolCallId ? String(e.toolCallId) : null,
          // `success` FIRST, `exit` only as a refinement. MCP tools report no
          // numeric code at all, so a classifier keyed on `exit !== 0` would be
          // inert for most clients -- and `exit` is null rather than 0 precisely
          // so that absence is not read as a clean exit.
          failed: e.success === false || (Number.isInteger(e.exit) && e.exit !== 0),
        }))
        .sort((a, b) => a.at - b.at);

      // DEDUPLICATED ON `toolCallId`, which is the SAME STRING in both sources:
      // `episodeMeta` reads `raw.tool_use_id` into `toolCallId`, and that is the
      // transcript's `tool_use_id` verbatim -- verified against live evidence
      // (`toolu_01L4Nwr...` in metrics.jsonl, the same ids in the transcript).
      // So on the ten clients that DO report failures, the event copy wins and
      // the transcript copy is dropped before grouping. Without this the two
      // copies of one failure would sit in the same run and the second of them
      // would be paired against the first as a failed-then-succeeded story about
      // itself.
      //
      // The fallback covers a client that reports a failure with no call id:
      // identical command text within two seconds is one failure recorded twice,
      // not two failures, because nothing re-runs a command that fast.
      const eventIds = new Set(
        outcomes.map((o) => o.toolCallId).filter(Boolean)
      );
      const eventFailures = outcomes.filter((o) => o.failed);
      const alreadyRecorded = (failure) => {
        if (failure.toolCallId && eventIds.has(failure.toolCallId)) return true;
        return eventFailures.some(
          (o) =>
            o.command === failure.command &&
            Math.abs((o.at || 0) - (failure.at || 0)) <= 2000
        );
      };

      let transcriptFailures = [];
      try {
        transcriptFailures = failedResultsFromTranscript(transcriptPath).filter(
          (failure) => failure.command.trim() && !alreadyRecorded(failure)
        );
      } catch {
        // The reader is an extra source, never a reason the detector stops.
      }
      for (const failure of transcriptFailures) {
        outcomes.push({
          command: failure.command.trim(),
          output: failure.output,
          exit: failure.exit,
          at: failure.at,
          toolCallId: failure.toolCallId,
          // Read from `Exit code N`, which is the only shape the reader admits.
          failed: true,
        });
      }
      if (transcriptFailures.length) outcomes.sort((a, b) => a.at - b.at);

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
          // COMPARED WITH THE DIRECTORY CHANGE REMOVED, for the same reason
          // the key is. `cd repo && npm test` and `npm test` are one attempt
          // spelled two ways; before `commandBody` they landed in different
          // groups and never met, and letting them meet without widening this
          // guard would emit "`npm test` succeeded where `cd repo && npm test`
          // failed" at 0.90 -- a difference in the claim that is not a
          // difference in what ran. Same for two `cd`s to different paths.
          if (commandBody(failed.command) === commandBody(outcome.command)) continue;

          // NOTHING QUOTABLE, NOTHING CLAIMED. See `quotable` above: on this
          // client both sides of almost every pair are truncated multi-line
          // shell scripts, and a claim quoting a fragment of one is noise
          // spending the retrieval budget of every later session.
          if (!quotable(failed.command) || !quotable(outcome.command)) continue;

          // AND THE KEY HAS TO NAME A COMMAND. See `hasAttemptIdentity`. The
          // `cd <path> &&` case that grouped 547 unrelated command lines in this
          // repository is now handled earlier by `commandBody`; what is left
          // here is every OTHER separator -- `git fetch && <anything>`, a
          // pipeline, a `;`-joined pair -- where the key still names no single
          // attempt and any pair drawn from it is false about both halves.
          if (!hasAttemptIdentity(outcome.command)) continue;

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
                'an intervening edit or an unrelated environment change explains the same pair.',
              { max: EVIDENCE_MAX }
            ),
            applicability: 'when about to run this command in this project',
            confidence,
            confidenceLabel: labelFor(confidence),
            scope: 'project',
            invalidators: ['the failing form later succeeds unchanged'],
            trigger: triggerFor(outcome.command),
            anchors: [anchorPath],
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
            anchors: [anchorPath],
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
          anchors: [anchorPath],
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
  // ---- 5: a DIFFERENT command against the same target succeeded -----------
  //
  // THE LESSON DETECTOR 1 CANNOT REACH. Its `attemptKey` is program-plus-
  // operands, so the correction worth recording -- reaching for a different
  // tool against the same target -- lands in two groups that never meet:
  //
  //   npx jest tests/foo.test.mjs     key "npx jest tests/foo.test.mjs"
  //   npm test -- tests/foo.test.mjs  key "npm test tests/foo.test.mjs"
  //
  // What detector 1 CAN pair is the identical command re-run, and its own guard
  // then correctly discards that as incoherent -- "`npm run build` works where
  // `npm run build` failed" claims nothing. So between the key and the guard,
  // the command family had almost no reachable evidence: measured across 937
  // real derive runs on this machine, 8 candidates and ZERO stored findings.
  //
  // This pairs on the shared OPERAND instead, and only when the PROGRAM differs
  // -- same-program pairs are detector 1's business and are left to it. The
  // conservatism the original key was protecting is kept in three other places:
  // the operand must NAME something (a path or an extension, never a bare word
  // like `build`), the two attempts must be close in time, and the ceiling is
  // 0.6 rather than 0.9 because sharing a target is weaker evidence than
  // repeating an invocation.
  try {
    if (projectRoot && outcomes?.length) {
      // KEYED FOLDED, DISPLAYED AS WRITTEN. Two invocations naming the same
      // file with different capitalisation are the same target on Windows and
      // macOS, so the key folds; the text stored in the finding must not,
      // because a claim naming `src/foo.test.mjs` for a file called
      // `src/Foo.test.mjs` is a path that does not resolve on Linux -- and
      // that text is what a later session reads. The first spelling seen wins,
      // which is the one the failing attempt actually used.
      const byTarget = new Map();
      for (const outcome of outcomes) {
        const operand = commandOperand(outcome.command);
        if (!operand) continue;
        const key = operand.toLowerCase();
        if (!byTarget.has(key)) byTarget.set(key, { target: operand, run: [] });
        byTarget.get(key).run.push(outcome);
      }

      for (const { target, run } of byTarget.values()) {
        let lastFailure = null;
        for (const outcome of run) {
          if (outcome.failed) {
            lastFailure = outcome;
            continue;
          }
          if (!lastFailure) continue;
          const failed = lastFailure;
          lastFailure = null;

          // BOTH SIDES MUST NAME A SINGLE COMMAND, the same rule detector 1
          // applies. `commandBody` strips only a LEADING directory change, and
          // `commandProgram` reads the first token, so a chained command
          // attributes the failure to the wrong program entirely:
          //
          //   git fetch && npx jest tests/foo.test.mjs   -> program "git"
          //   cat x | npx jest tests/foo.test.mjs        -> program "cat"
          //
          // Paired against `npm test -- tests/foo.test.mjs` those would ship
          // "npm test succeeded where git fetch failed" and tell a later session
          // to avoid `git`. Checked per side rather than once, because unlike
          // detector 1 these two do NOT share a key by construction.
          if (!hasAttemptIdentity(failed.command)) continue;
          if (!hasAttemptIdentity(outcome.command)) continue;
          // Same program is detector 1's case, whether it pairs there or not.
          if (commandProgram(failed.command) === commandProgram(outcome.command)) continue;
          // A fix follows its failure closely. Hours apart is two unrelated
          // pieces of work that happened to touch one file.
          const apart = Math.abs((outcome.at || 0) - (failed.at || 0));
          if (!apart || apart > RETARGET_WINDOW_MS) continue;
          // Same rule as detector 1: nothing quotable, nothing claimed.
          if (!quotable(failed.command) || !quotable(outcome.command)) continue;

          const confidence = CONFIDENCE.retarget;
          add({
            type: 'command',
            claim: redact(
              `In this project \`${commandBody(outcome.command)}\` succeeded on ${target} where ` +
                `\`${commandBody(failed.command)}\` had failed`,
              { max: CLAIM_MAX }
            ),
            evidence: redact(
              `observed in one session: \`${failed.command}\` failed` +
                `${Number.isInteger(failed.exit) ? ` (exit ${failed.exit})` : ''}, then ` +
                `\`${outcome.command}\` succeeded against the same target \`${target}\` ` +
                `${Math.round(apart / 1000)}s later. Different programs, one target: ordered ` +
                'and close, but not proven causal -- an intervening edit explains the same pair.',
              { max: EVIDENCE_MAX }
            ),
            applicability: `when about to run \`${commandProgram(failed.command)}\` against ${target} in this project`,
            confidence,
            confidenceLabel: labelFor(confidence),
            scope: 'project',
            invalidators: [`\`${commandBody(failed.command)}\` later succeeds unchanged`],
            trigger: triggerFor(failed.command),
            anchors: [anchorPath],
            derivedBy: 'retarget',
            sessionId,
            at: outcome.at || Date.now(),
          });
        }
      }
    }
  } catch {
    // One detector, never the session.
  }


  // ---- storage, under a budget -------------------------------------------
  //
  // NOTHING ENTERS THE GRAPH UNBUDGETED. `selectForConsolidation` existed for
  // exactly this and had no caller, which meant that until now nothing bounded
  // what a session could add. It admits `failure` and `decision` on a FLOOR
  // before ranking -- a dead end exists nowhere else and is small, and cheap to
  // find is not cheap to find again -- then fills the remainder by
  // cost x irrecoverability x reuse-probability.
  //
  // ORIGIN_HARVESTED, EXPLICITLY, never ORIGIN_HUMAN. These are machine
  // derivations; `curate.mjs` states the reason in its own header -- "a
  // hand-written assertion and a machine guess look identical three months
  // later, which quietly destroys the reader's ability to calibrate trust".
  // `writeHarvested` would refuse a batch-wide human origin anyway, and a
  // candidate here carries neither `origin` nor `quote`, so it cannot earn one
  // per finding either. That is deliberate: whether a turn was a correction at
  // all is a lexical guess, and the standing-rules layer selects on human
  // origin to inject on EVERY turn.
  try {
    if (result.candidates.length) {
      const selected = selectForConsolidation(load(dir), result.candidates, {
        budget: storageBudget(),
      });
      result.selected = selected.kept.length;
      result.dropped = selected.dropped;
      result.selectedTokens = selected.tokens;
      result.written = writeHarvested(dir, selected.kept, {
        sessionId,
        origin: ORIGIN_HARVESTED,
        projectRoot,
        // The hook payload's own identity, passed through untouched. Without it
        // `taskForAnchors` returns null and the `answers` edge never fires --
        // which is the state a default install has been in, because its only
        // other producer is credential-gated.
        authoritativeSessionId,
      });
    }
  } catch {
    // Storage is the last step and the session is already over. A graph write
    // that fails must not turn a completed session into a hook error.
  }

  return result;
}
