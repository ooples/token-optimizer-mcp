// GENERATED FILE -- do not edit.
// Source of truth: hooks-core/inject.mjs. Regenerate with `npm run sync:hooks`.
/**
 * P4: getting knowledge to the model for less than it saves.
 *
 * Two layers, per the design: a bounded SessionStart index so the model knows
 * what the graph holds, and just-in-time injection when it reaches for a file.
 * The second is where the win lands, because it requires no query -- the model
 * receives what it would have spent 20k tokens deriving without ever needing to
 * know to ask.
 *
 * THE ZERO-TURN REFUSAL. A plain deny-and-redirect costs a full turn: the model
 * calls Read, is refused, re-plans, calls smart_read. But at refusal time this
 * process already holds the file on disk AND the snapshot the graph stored, so
 * it can compute the diff itself and put it INSIDE the refusal. The model asked
 * a question and the refusal contains the answer, so there is nothing to
 * re-plan and no second call. Turn cost drops from one to zero, and the token
 * cost drops from a whole file to a diff.
 *
 * That is the difference between a tool that nags and a tool that helps.
 */

import { readFileSync } from 'node:fs';
import {
  findingsFor, putNode, putEdge, nodeId, load, sharedDir, isSharedDir,
} from './wiki.mjs';
import { basename } from 'node:path';
import { serve, diffLines } from './staleness.mjs';
import { drainInvalidations } from './pending.mjs';
import { inHoldout, record, indexBudget } from './metrics.mjs';
import { canonicalPath, resolvableCandidates } from './paths.mjs';
import { annotatedSkeleton } from './skeleton.mjs';
import { substitutionBudget } from './metrics.mjs';
import { assessFindings } from './utility.mjs';
import { quarantineSharedSource } from './harvest-write.mjs';
import { cacheOrdered } from './cache.mjs';
import { withheldFor, exploreOrder, servingPolicyVersion, LOO_ENABLED } from './loo.mjs';

// Read per call for the same reason as the holdout fraction in metrics.mjs.
const touchBudget = () => Number(process.env.TOKEN_OPTIMIZER_TOUCH_BUDGET) || 500;

/**
 * Tokens allowed for the always-on standing rules.
 *
 * FIXED AND SMALL, unlike the session index whose budget is earned from measured
 * hit rate. An earned budget is right for a catalogue that grows with the graph;
 * it is wrong here, because this text is paid for on EVERY session whether or
 * not it is relevant, and a set that grows with the project is exactly how an
 * always-on block becomes wallpaper. 400 tokens is roughly a dozen rules -- if a
 * project needs more standing rules than that, the honest answer is that some of
 * them are situational and belong behind a trigger.
 */
const standingBudget = () =>
  Number(process.env.TOKEN_OPTIMIZER_STANDING_BUDGET) || 400;

/**
 * The stratification key for a command.
 *
 * Normalised so that the same intent lands in the same arm: trailing
 * whitespace and a differing set of paths should not flip a command between
 * treated and withheld, because that is what makes the two arms comparable.
 */
function commandKey(command) {
  return String(command || '')
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, 120)
    .toLowerCase();
}

/** Most findings considered for one command before the budget decides. */
const MAX_COMMAND_CANDIDATES = 20;

/**
 * Compiles a finding's trigger, or returns null if it is not safe to run.
 *
 * TRIGGERS ARE MODEL-SUPPLIED. The harvest writes them, and a model asked for a
 * regex can produce `(a+)+b` as readily as `\bnpx\b` -- a pattern whose
 * backtracking is exponential in the input length. That would execute on the
 * PreToolUse path against a command the user is waiting on, so a single bad
 * trigger would hang every subsequent tool call in the session. Neither a
 * try/catch nor a timeout helps: catastrophic backtracking does not throw, it
 * simply does not return.
 *
 * So the pattern is rejected before it is ever run. The test is deliberately
 * conservative -- nested quantifiers are the shape that causes this, and no
 * legitimate trigger for a command needs one.
 */
export function safeTrigger(source) {
  const raw = String(source || '');
  if (!raw || raw.length > 200) return null;

  // A quantifier applied to a group that itself contains a quantifier: (a+)+,
  // (a*)*, (\d+)*, (?:ab+)+ and so on. This is the classic ReDoS shape.
  if (/\([^)]*[+*}][^)]*\)\s*[+*{]/.test(raw)) return null;

  // Stacked quantifiers outside a group, e.g. `a+*` or `.*+`.
  if (/[+*}]\s*[+*]/.test(raw)) return null;

  try {
    return new RegExp(raw, 'i');
  } catch {
    return null;
  }
}
const estimate = (text) => Math.ceil(String(text || '').length / 4);

/**
 * Fits findings into a token budget, best first.
 *
 * The bound is load-bearing rather than tidy: without it the most heavily
 * worked files accumulate the most findings and become the most expensive to
 * touch, and the optimizer becomes its own token problem.
 */
function fit(findings, budget) {
  const kept = [];
  let spent = 0;
  for (const finding of findings) {
    const cost = estimate(render(finding));
    if (spent + cost > budget) continue;
    kept.push(finding);
    spent += cost;
  }
  return { kept, spent };
}

/**
 * Discloses an open disagreement, on the same line as the claim it is about.
 *
 * BOTH HALVES, like the stale renderer below: the strong form names the other
 * finding so the reader can fetch it, and the form without a key says only what
 * is actually known. `serve` is what establishes the dispute; this only phrases
 * it, and it phrases it in one short line because `fit` prices `render` against
 * the injection budget -- a disagreement is worth a pointer, not both claims in
 * full.
 *
 * NO DISMISSAL VOCABULARY, for the reason measured on the stale wording: an
 * instruction to discount suppressed findings that were correct. This states
 * that another claim exists and where to find it, and lets the reader decide.
 */
function disputeNote(finding) {
  if (!finding.contradicted) return '';
  const head = finding.contradictedBy
    ? `\n  DISPUTED by ${finding.contradictedBy} -- wiki_query that key for the other claim`
    : '\n  DISPUTED by another finding in this graph';
  // THE REASON A PERSON TYPED, rendered here because this is the fullest of the
  // three dispute surfaces and the only one with room for a sentence. `contradict`
  // has always stored up to 400 characters of human explanation and, until this
  // line, nothing read it: the pointer told a reader where to look and withheld
  // the one thing that would tell them whether looking was worth a tool call.
  //
  // TRUNCATED AT 140, because `fit` prices this string against the injection
  // budget and a 400-character paragraph beside a one-line claim inverts the
  // proportions. The compressed surfaces -- the session index and restore.mjs's
  // "Likely next" list -- deliberately keep marker-and-key only; they are one
  // line per finding by design, and `wiki_query` returns the reason in full.
  if (typeof finding.contradictionReason !== 'string' || !finding.contradictionReason.trim()) {
    return head;
  }
  const reason = finding.contradictionReason.trim();
  const shown = reason.length > 140 ? `${reason.slice(0, 140)}...` : reason;
  return `${head}\n  Reason given: ${shown}`;
}

/**
 * Discloses `derivationCheck`'s verdict (staleness.mjs) -- distinct from
 * `disputeNote` (another finding disagrees) and from the STALE block below
 * (the anchor NODE's current hash does not match disk). This is about
 * whether the bytes THIS claim was actually derived from are still the bytes
 * an anchor holds; see `derivationCheck`'s comment for the case that catches
 * that the other two can miss. Silent when it holds -- the common case pays
 * nothing -- and silent when it was never checked at all (an older finding
 * with no `derivation` record).
 */
function derivationNote(finding) {
  if (finding.derivationHolds !== false) return '';
  const changed = Array.isArray(finding.derivationChanged) ? finding.derivationChanged : [];
  if (!changed.length) return '\n  DERIVATION CHANGED since this claim was recorded';
  const verb = changed.length === 1 ? 'no longer matches' : 'no longer match';
  return `\n  DERIVATION CHANGED -- ${changed.join(', ')} ${verb} what this claim was derived from`;
}

function render(finding) {
  const head = `- [${finding.type || 'finding'}] ${finding.claim}${disputeNote(finding)}${derivationNote(finding)}`;
  if (!finding.stale) return head;

  // A stale finding NEVER renders as though it were current. But the strength
  // of the framing follows the strength of the evidence, because the framing
  // was measured: in an A/B on a fresh subagent, identical findings scored 1/3
  // dead-ends avoided when rendered with the discount wording and 2/3 when
  // rendered clean. The claims being discounted were correct every time.
  //
  // With a diff, the reader can judge for themselves and the strong form is
  // earned. Without one -- 78% of stale findings on real graphs -- announcing
  // STALE and promising `What changed:` in front of nothing spends the
  // strongest signal available on the weakest evidence available.
  if (!finding.staleEvidence || !finding.diff) {
    return `${head}\n  (recorded earlier; ${finding.staleReason}, and no diff could be rebuilt)`;
  }
  return `${head}\n  STALE (${finding.staleReason}). What changed:\n${finding.diff}`;
}

/**
 * Graph directories where a drain has already marked something in THIS process.
 *
 * THE SECOND CALLER IS WHY THIS EXISTS. SessionStart calls `standingRules` and
 * then `sessionIndex` with the SAME graph object it loaded once. Without this,
 * the first call drains, marks, and re-reads privately -- and the second call
 * finds an empty queue, marks nothing, and therefore serves from the caller's
 * pre-drain copy, advertising as current the very finding the first call had
 * just marked. Draining is idempotent; its EFFECT on a caller's parsed graph is
 * not, so what is remembered here is "a re-read is owed", nothing else.
 *
 * ONLY THE POSITIVE CASE IS REMEMBERED, and that is a correctness decision
 * rather than a tuning one. Remembering "nothing was queued" would mean a queue
 * arriving LATER in the same process is silently skipped and deferred to some
 * future session. That cannot happen today, because `queueInvalidation` runs in
 * the post-tool branch before any injection -- but that is an unguarded
 * ordering dependency, and it stops being true the moment someone adds a call
 * site. A repeated empty drain costs one `existsSync` on a file that is not
 * there, which is a price worth paying to not have an invariant that depends on
 * nobody reordering anything.
 *
 * KEYED CANONICALLY. Two spellings of one directory -- a trailing separator, a
 * `..` segment, a lower-cased drive letter -- would otherwise be two entries,
 * which reintroduces exactly the pre-drain-copy bug above. This is the same
 * defect shape Task 2 on this branch shipped for real, where a tool resolved its
 * graph from a raw cwd while the hooks resolved theirs through `projectRootFor`
 * and the two halves of a metric landed in different directories. Path identity
 * is why `canonicalKey` lives inside `nodeId` rather than at its call sites.
 *
 * A hook process handles one lifecycle event, so this set holds one or two
 * entries and dies with the process.
 */
const drainedDirs = new Set();

/**
 * Applies anything the post-tool hook queued, BEFORE anything is served.
 *
 * THIS IS WHERE EAGER STALENESS LANDS. `invalidateOnWrite` needs a graph, and
 * loading one on the return path of every write is what pending.mjs exists to
 * avoid -- so the hook queues and the next graph read applies. These two
 * functions are that read: they already hold a freshly loaded graph, and they
 * are the last thing to run before a finding reaches a model.
 *
 * RE-READ ONLY WHEN SOMETHING WAS ACTUALLY MARKED. The drain writes the stale
 * flag to disk; it cannot mutate the caller's already-parsed graph, so serving
 * from that copy would deliver the very "stale finding as fresh" this exists to
 * prevent. A second load costs a parse, and it is paid once per observed write
 * rather than once per tool call -- when nothing is queued this is one stat.
 */
function withPendingApplied(dir, graph) {
  try {
    const key = canonicalPath(dir);
    // The drain runs EVERY time. It is one stat when there is nothing to do,
    // and running it unconditionally is what keeps the memo from encoding an
    // assumption about which hook branch ran first.
    if (drainInvalidations(dir, graph) > 0) drainedDirs.add(key);
    return drainedDirs.has(key) ? load(dir) : graph;
  } catch {
    // The lazy path still covers everything this would have caught early, and
    // a hook must never fail because bookkeeping did.
    return graph;
  }
}

/**
 * What the model sees when it touches a file.
 *
 * Returns null when there is nothing to say, or when this touch fell into the
 * measurement holdout -- in which case the caller must behave exactly as if the
 * graph were empty, or the experiment measures nothing.
 */
export function forTouch(
  dir,
  graph,
  rawPath,
  { budget = touchBudget(), sessionId, alreadyInjected = new Set(), episode = {} } = {}
) {
  graph = withPendingApplied(dir, graph);
  // Canonical, so a touch finds findings anchored under any other spelling.
  const filePath = canonicalPath(rawPath);
  const anchorId = nodeId('file', filePath);
  // The same once-per-session gate the command path uses. A file touched
  // repeatedly -- which is the normal shape of working on it -- would otherwise
  // re-serve the same findings on every single touch, which is both a token
  // cost per call and the fastest way to train a model to skim past them.
  const candidates = findingsFor(graph, anchorId, { limit: 30 })
    .filter((f) => !alreadyInjected.has(f.key));
  if (!candidates.length) return null;

  // STRATIFIED BY FILE AND EPOCH, which is the documented design here: the
  // same file lands in the holdout during some epochs and the treated arm in
  // others, so the comparison becomes within-file and the dominant source of
  // variance drops out. A session-pinned arm would destroy that.
  const holdout = inHoldout(filePath);
  // `dir` so an eager flag whose evidence is gone is cleared here rather than
  // waiting for somebody to open the dashboard. Same evidence test as the manual
  // path -- see `serve`.
  const served = serve(graph, candidates, { dir });
  const assessed = assessFindings(dir, served, {
    episodeId: episode.episodeId || sessionId,
    relevanceFor: () => 1,
    costFor: (finding) => estimate(render(finding)),
  });
  if (assessed.rejected.length) {
    record(dir, {
      kind: 'retrieval-decision', ...episode, sessionId,
      surface: 'file', anchor: filePath,
      rejected: assessed.rejected.map(({ key, reason }) => ({ key, reason })),
    });
    for (const rejected of assessed.rejected) alreadyInjected.add(rejected.key);
  }
  // LAYER 2 EXPLORATION, BEFORE the budget decides.
  //
  // `assessed.eligible` arrives in net-utility order and `fit` keeps that order
  // until the budget runs out -- so the ranking decides which findings are ever
  // served, which decides which ever accumulate observations, which decides
  // their utility. A tenth of touches therefore promote the least-served
  // candidate first. This is the only place it can go: after `fit` the choice
  // has already been made.
  const ordered = exploreOrder(assessed.eligible, dir, { sessionId, anchor: filePath });
  const { kept, spent } = fit(ordered.map((item) => item.finding), budget);
  if (!kept.length) return null;

  // LAYER 2 WITHHOLDING, AFTER the budget decides, which is the only ordering
  // that produces a leave-one-out rather than a substitution: withholding first
  // would let the next-ranked finding take the freed tokens, so the withheld
  // arm would differ from the served arm by two findings instead of one and the
  // effect would belong to neither.
  //
  // `holdout` is passed so the two experiments cannot compose into "withhold
  // everything and call it a leave-one-out": that arm already serves nothing.
  const withheld = withheldFor(kept.map((finding) => finding.key), sessionId, graph, dir, {
    surface: 'file',
    anchor: filePath,
    holdout,
  });
  const delivered = withheld ? kept.filter((finding) => finding.key !== withheld) : kept;
  // RE-PRICED, because `fit` priced what it KEPT and this delivers less. Using
  // `spent` would bill the injection-cost side of the balance sheet for text
  // the model never received.
  const deliveredSpent = withheld
    ? delivered.reduce((sum, finding) => sum + estimate(render(finding)), 0)
    : spent;

  record(dir, {
    kind: 'inject',
    ...episode,
    // The surface whose saving CAN be measured: reads of this anchor afterwards.
    surface: 'file',
    anchor: filePath,
    holdout,
    tokens: holdout ? 0 : deliveredSpent,
    deliveredTokens: holdout ? 0 : deliveredSpent,
    shadowTokens: spent,
    count: holdout ? 0 : delivered.length,
    candidateCount: kept.length,
    findingIds: holdout ? [] : delivered.map((finding) => finding.key),
    shadowFindingIds: kept.map((finding) => finding.key),
    stale: delivered.some((f) => f.stale),
    sessionId,
    // ON EVERY RECORD, not only the withheld ones. A served observation needs
    // the policy version as much as a withheld one does, or `effects` cannot
    // keep the two arms of one comparison inside one policy.
    ...(LOO_ENABLED() ? { looPolicy: servingPolicyVersion() } : {}),
    ...(withheld ? { loo: withheld } : {}),
  });

  // MARKED SEEN IN BOTH ARMS, for the same reason as the command path: a file
  // touched repeatedly -- the normal shape of working on it -- would otherwise
  // write a fresh holdout row every time while a treated file was suppressed
  // after its first delivery. The report counts rows, so the control arm would
  // grow faster purely from repetition.
  //
  // This is the identical defect that was fixed in `forCommand` and not here.
  //
  // THE WITHHELD KEY IS MARKED TOO, and that is load-bearing rather than tidy:
  // an unmarked one would be a candidate again on the next touch of this file,
  // where the one-per-touch tiebreak could serve it -- flipping its arm inside
  // the very session the arm hash exists to pin it for.
  for (const f of kept) alreadyInjected.add(f.key);

  if (holdout || !delivered.length) return null;

  return `Known about ${filePath} (from previous sessions):\n${delivered.map(render).join('\n')}`;
}

/**
 * Does this finding apply to the command about to run?
 *
 * A finding carries an optional `trigger`: a string or regex source matched
 * against the command text. Explicit beats inferred -- the alternative was
 * scraping command-looking tokens out of the claim, which both misses (a claim
 * that describes the command in prose) and misfires (a claim that merely
 * mentions a command it is not about).
 *
 * With no trigger, a `command` or `failure` finding still qualifies on a weaker
 * test: the command mentions a distinctive token from the claim. That keeps the
 * findings already in existing graphs useful without a migration, while new
 * ones can be precise.
 */
function appliesToCommand(finding, command) {
  const text = String(command || '');
  if (!text) return false;

  if (finding.trigger) {
    const pattern = safeTrigger(finding.trigger);
    if (pattern) {
      try {
        return pattern.test(text);
      } catch {
        return false;
      }
    }
    // Rejected as unsafe or malformed: fall back to a literal search, which
    // cannot backtrack. A bad trigger degrades to a substring match rather
    // than taking the hook down or hanging it.
    return text.toLowerCase().includes(String(finding.trigger).toLowerCase());
  }

  // Untriggered findings only qualify if they are about doing something.
  if (finding.type !== 'command' && finding.type !== 'failure') return false;

  // Distinctive tokens, matched as WHOLE WORDS.
  //
  // The floor is three characters because the tokens that carry the meaning are
  // short: jest, npm, git, ssh, tsc. A five-character floor -- the first
  // attempt -- excluded "jest" from the very finding this feature exists to
  // deliver, which the tests caught. Whole-word matching is what makes the low
  // floor safe: without it "npm" would fire on any path containing "npm", and
  // every claim mentioning a common word would match every command.
  const claim = String(finding.claim || '');
  const tokens = [
    ...new Set(
      (claim.match(/[a-z][a-z0-9._-]{2,}/gi) || [])
        .map((t) => t.toLowerCase().replace(/[._-]+$/, ''))
        .filter((t) => t.length >= 3 && !STOPWORDS.has(t))
    ),
  ];

  return tokens.some((t) => {
    const escaped = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    try {
      return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'i').test(text);
    } catch {
      return false;
    }
  });
}

/**
 * Words common enough that matching on them would fire on every command.
 * Deliberately small: this is a noise floor, not a language model.
 */
const STOPWORDS = new Set([
  // Long enough to pass the length floor, common enough to match anything.
  'about', 'after', 'again', 'against', 'because', 'before', 'being', 'between',
  'could', 'every', 'first', 'instead', 'other', 'rather', 'should', 'since',
  'their', 'there', 'these', 'thing', 'those', 'through', 'where', 'which',
  'while', 'would', 'without', 'project', 'always', 'never',
  // Short words that only became candidates once the floor dropped to three,
  // which it had to so that the tool names that matter -- jest, npm, git, ssh
  // -- are matchable at all.
  'and', 'are', 'but', 'for', 'from', 'has', 'have', 'into', 'its', 'not',
  'one', 'only', 'our', 'out', 'same', 'some', 'such', 'than', 'that', 'the',
  'them', 'then', 'they', 'this', 'too', 'use', 'used', 'very', 'was', 'were',
  'what', 'when', 'will', 'with', 'you', 'your', 'run', 'runs', 'way', 'why',
]);

/**
 * What the model sees when it is about to RUN something.
 *
 * The gap this closes: injection was keyed entirely on touching a FILE, but the
 * findings worth the most are about ACTIONS. The case that proved it -- a
 * finding of type `command`, "run the suite with npm test, not npx jest",
 * anchored to a source file. An agent about to run `npx jest` is not touching
 * that file, so the finding could not fire at the only moment it mattered, and
 * the agent made exactly the mistake the graph had already recorded.
 *
 * `alreadyInjected` is the once-per-session gate. Repeating the same advice on
 * every command is how a real signal becomes wallpaper, and an ignored
 * injection still costs its tokens on every call.
 */
export function forCommand(
  dir,
  graph,
  command,
  { budget = touchBudget(), sessionId, alreadyInjected = new Set(), episode = {} } = {}
) {
  if (!command) return null;
  graph = withPendingApplied(dir, graph);

  const candidates = [];
  for (const node of graph.nodes.values()) {
    if (node.kind !== 'finding' || node.retired) continue;
    if (alreadyInjected.has(node.key)) continue;
    if (!appliesToCommand(node, command)) continue;
    candidates.push(node);
  }
  if (!candidates.length) return null;

  // Highest confidence first, so a tight budget keeps the most trustworthy.
  // AN EXPLICIT TRIGGER BEATS AN INCIDENTAL WORD, before confidence is even
  // consulted. A finding whose author wrote a pattern that matched this command
  // is about this command; one that matched because its prose happened to
  // contain "build" is not, however confident it was about something else.
  //
  // Observed live: `dotnet build App.csproj | tail -20` surfaced a finding about
  // stale MCP server processes instead of the one about pipes hiding exit
  // codes, and `gh run list` surfaced a git-refspec finding instead of the one
  // about mergeStateStatus. Both had the same confidence as the right answer,
  // so confidence alone could not separate them -- and a tight budget then kept
  // the wrong one.
  const explicit = (n) => (n.trigger && safeTrigger(n.trigger)?.test(command) ? 1 : 0);
  candidates.sort(
    (a, b) => explicit(b) - explicit(a) || (b.confidence ?? 0.5) - (a.confidence ?? 0.5)
  );

  // CAPPED BEFORE serve(). serve() re-reads and diffs the anchor of every
  // finding it is handed, so an unbounded candidate list turns one command into
  // one file read per matching finding -- on the hook path, with the user
  // waiting. The budget would discard the surplus a moment later anyway, so the
  // only thing an uncapped list buys is the I/O.
  const considered = candidates.slice(0, MAX_COMMAND_CANDIDATES);

  const served = serve(graph, considered, { dir });
  const assessed = assessFindings(dir, served, {
    episodeId: episode.episodeId || sessionId,
    relevanceFor: (finding) => explicit(finding) ? 1 : 0.6,
    costFor: (finding) => estimate(render(finding)),
  });
  if (assessed.rejected.length) {
    record(dir, {
      kind: 'retrieval-decision', ...episode, sessionId,
      surface: 'command', anchor: String(command).slice(0, 120),
      rejected: assessed.rejected.map(({ key: findingKey, reason }) => ({ key: findingKey, reason })),
    });
    for (const rejected of assessed.rejected) alreadyInjected.add(rejected.key);
  }
  const { kept, spent } = fit(assessed.eligible.map((item) => item.finding), budget);
  if (!kept.length) return null;

  // THE COMMAND PATH TAKES PART IN THE HOLDOUT TOO.
  //
  // `holdout: false` was hardcoded here, so 95 of 136 injections measured on a
  // real machine were structurally excluded from the only mechanism that can
  // establish causation. Seventy per cent of what the feature does could never
  // be shown to help or hurt.
  //
  // Stratified on the COMMAND rather than a file, by the same (key, epoch)
  // hash: the same command lands in the same arm all session, so a command run
  // repeatedly cannot straddle both arms and contaminate each.
  const key = commandKey(command);
  const holdout = inHoldout(key);

  record(dir, {
    kind: 'inject',
    ...episode,
    trigger: 'command',
    // The surface the report needs to keep these OUT of the file-read balance:
    // a command has no anchor that read events can be joined to.
    surface: 'command',
    anchor: String(command).slice(0, 120),
    holdout,
    tokens: holdout ? 0 : spent,
    deliveredTokens: holdout ? 0 : spent,
    shadowTokens: spent,
    count: holdout ? 0 : kept.length,
    candidateCount: kept.length,
    findingIds: holdout ? [] : kept.map((finding) => finding.key),
    shadowFindingIds: kept.map((finding) => finding.key),
    stale: kept.some((f) => f.stale),
    sessionId,
  });

  // MARKED SEEN IN BOTH ARMS.
  //
  // The held branch used to return before updating the gate, so a command run
  // repeatedly wrote a fresh holdout row every time while a treated command was
  // filtered after its first delivery. The report counts rows, so the holdout
  // arm was systematically overweighted -- a bias in the very comparison this
  // exists to make.
  for (const f of kept) alreadyInjected.add(f.key);

  // Withheld means withheld. Returning the text anyway would record an arm the
  // subject never actually experienced.
  if (holdout) return null;

  return `Before running this — known from previous sessions:\n${kept
    .map(render)
    .join('\n')}`;
}
/**
 * Tokens allowed for lessons carried in from OTHER projects.
 *
 * Deliberately a fraction of the command budget rather than its equal. A lesson
 * from elsewhere is a weaker signal than one learned here -- it was true of a
 * different codebase -- so it may add to the answer and must never crowd out this
 * project's own findings, which are selected first and keep the full budget.
 */
const sharedBudget = () =>
  Number(process.env.TOKEN_OPTIMIZER_SHARED_BUDGET) || 160;

/** At most this many cross-project lessons per command, whatever the budget. */
const MAX_SHARED = 2;

/**
 * ACTION CLASSES: what a command is DOING, rather than what it says.
 *
 * Two measured problems, one cause. First, `appliesToCommand` refuses any
 * untriggered finding that is not `command` or `failure`, so every `feedback` and
 * `decision` lesson is unreachable on the command path -- measured on the real
 * store, 10 of 19 shared lessons could never fire, and all five `feedback` ones
 * were among them. Those are the most behaviour-shaping lessons there are:
 * "report the number you measured, not the one you expected", "a green unit suite
 * does not mean the feature is reachable".
 *
 * Second, a literal trigger only fires on the string its author happened to
 * write. The lesson "confirm the sabotage applied before trusting a canary" was
 * in this store all session while I broke that exact rule six times, because the
 * commands I ran said `node probe.mjs` and `dotnet csc.dll`, not "canary".
 *
 * So a finding also matches when its claim and the command are about the same
 * KIND of act. The classes are deliberately few and behavioural -- each one names
 * a way work actually goes wrong, not a topic.
 */
const ACTION_CLASSES = {
  // Running something whose output is trusted as proof.
  verify: {
    command: /\b(test|jest|pytest|check|--check|lint|verify|assert|canary|probe|csc|tsc|typecheck)\b/i,
    claim: /\b(verif|assert|canary|sabotage|prove|trust(ed|ing)?|silently|reports? (pass|green|success)|actually (ran|applied|chang))/i,
  },
  // Reading a result through a pipe or a filter, where status can be lost.
  pipe: {
    command: /\|\s*(tail|head|grep|sort|wc|jq)\b|>\s*\S+\.(log|txt)\b/i,
    claim: /\b(pipe|PIPESTATUS|exit code|\$\?|stderr|redirect)\b/i,
  },
  // Changing files by machine rather than by hand.
  edit: {
    command: /\b(sed|smart_edit|prettier|format|codemod|rename)\b/i,
    claim: /\b(edit|editsApplied|rewrite|generated cop|overwrit|line ending|CRLF)\b/i,
  },
  // Producing artefacts from source, where the artefact may not match the source.
  build: {
    command: /\b(build|compile|tsc|dotnet build|make|pack|sync:hooks|generate)\b/i,
    claim: /\b(build|compile|generated|regenerat|artefact|artifact|dist\/|stale)\b/i,
  },
  // Putting software somewhere it will be executed from.
  install: {
    command: /\b(npm (install|ci|i)\b|npx|pip install|dotnet restore|clone)\b/i,
    claim: /\b(install|npx|cache|node_modules|global|published|running (process|server|build))\b/i,
  },
};

/** Which classes a piece of text belongs to, on the given side. */
const classesOf = (text, side) => {
  const out = new Set();
  for (const [name, spec] of Object.entries(ACTION_CLASSES)) {
    if (spec[side].test(String(text || ''))) out.add(name);
  }
  return out;
};

/**
 * How many times a session must repeat an act class before a lesson it has
 * already been given is allowed to speak again.
 *
 * ONCE PER SESSION IS RIGHT UNTIL IT IS NOT. Repeating advice on every call is
 * how a real signal becomes wallpaper, which is why the gate exists. But the gate
 * is also why a lesson can be delivered at 10:00 and be irrelevant by 14:00: in
 * one session on this machine the lesson "confirm the sabotage applied before
 * trusting a canary" was served once and then suppressed, and the same class of
 * mistake was made SIX more times that day -- a prompt mangled by shell quoting
 * that scored a fabricated result, a compiler path with a trailing character so
 * no compiler ran and every file reported clean, two heredocs that silently
 * matched nothing, an edit that clobbered the wrong line, a scorer that counted a
 * refusal as a success.
 *
 * Three is chosen to be quiet: the first two repetitions say nothing, because
 * doing something twice is ordinary work. The third says the session has a
 * pattern, which is exactly when a reminder stops being wallpaper and starts
 * being information.
 */
const REPEAT_THRESHOLD = 3;

/**
 * Records that this session performed an act of a given class, and reports which
 * classes have now crossed the threshold.
 *
 * The counter lives in session state, so it is per session by construction and
 * disappears when the session does -- a pattern within one working day is the
 * claim, not a pattern across months.
 */
export function noteActClasses(state, command) {
  const classes = classesOf(command, 'command');
  if (!classes.size) return new Set();

  state.actCounts = state.actCounts && typeof state.actCounts === 'object' ? state.actCounts : {};
  const crossed = new Set();
  for (const c of classes) {
    state.actCounts[c] = (state.actCounts[c] || 0) + 1;
    if (state.actCounts[c] === REPEAT_THRESHOLD) crossed.add(c);
  }
  return crossed;
}

/**
 * A lesson already given this session, re-surfaced because the session keeps
 * doing the thing it is about.
 *
 * EXACTLY ONCE PER CLASS, at the moment the threshold is crossed -- `===` not
 * `>=` in the counter above. A reminder that returns on every subsequent call is
 * the wallpaper the once-per-session gate was built to prevent, and re-creating
 * it here under a different name would be worse than not reminding at all.
 */
export function forRepeatedAct(
  projectDir,
  command,
  crossedClasses,
  { sessionId = null, projectRoot = null, episode = {} } = {}
) {
  if (!crossedClasses || !crossedClasses.size) return null;

  try {
    const dir = sharedDir();
    if (!dir || isSharedDir(projectDir)) return null;
    const graph = load(dir);
    if (!graph.nodes.size) return null;

    const home = projectRoot ? canonicalPath(projectRoot) : null;
    for (const node of graph.nodes.values()) {
      if (node.kind !== 'finding' || node.retired || !node.claim) continue;
      if (quarantineSharedSource(node.sourceProject)) continue;
      if (home && node.sourceProject && canonicalPath(node.sourceProject) === home) continue;
      const claimClasses = classesOf(node.claim, 'claim');
      if (![...crossedClasses].some((c) => claimClasses.has(c))) continue;

      const cls = [...crossedClasses].find((c) => claimClasses.has(c));
      const assessed = assessFindings(projectDir, [node], {
        episodeId: episode.episodeId || sessionId,
        relevanceFor: () => 1,
        costFor: (finding) => estimate(render(finding)),
        // This surface exists specifically to re-surface a lesson once the
        // session crosses the repeat threshold. Ordinary retrieval remains
        // cooldown-protected; harm quarantine and utility gating still apply.
        bypassCooldown: true,
      });
      if (!assessed.eligible.length) {
        record(projectDir, {
          kind: 'retrieval-decision', ...episode, sessionId,
          surface: 'shared', anchor: String(command).slice(0, 120),
          rejected: assessed.rejected.map(({ key, reason }) => ({ key, reason })),
        });
        continue;
      }
      record(projectDir, {
        kind: 'inject',
        ...episode,
        trigger: 'repeat',
        surface: 'shared',
        anchor: String(command).slice(0, 120),
        holdout: false,
        tokens: estimate(node.claim),
        deliveredTokens: estimate(node.claim),
        shadowTokens: estimate(node.claim),
        count: 1,
        candidateCount: 1,
        findingIds: [node.key],
        shadowFindingIds: [node.key],
        stale: false,
        sessionId,
      });

      // The count is the whole message. "You have done this three times" is a
      // fact about this session that the model cannot see for itself, and it is
      // what makes a repeated claim land differently from the first delivery.
      return `You have run ${REPEAT_THRESHOLD} ${cls} steps this session. Worth re-reading:\n- [${node.type || 'finding'}] ${node.claim}`;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Does this lesson apply to this command, for the CROSS-PROJECT path?
 *
 * Strictly wider than `appliesToCommand`, and only here: the local path keeps its
 * stricter rule because a project's own graph is dense and a loose match there
 * costs tokens on every call. The shared tier is small, capped at two lessons and
 * budgeted separately, so reachability matters more than selectivity.
 */
function appliesCrossProject(finding, command) {
  if (appliesToCommand(finding, command)) return true;

  // A shared lesson with no usable trigger still has a claim, and a claim about
  // the same kind of act as the command is the signal a literal string misses.
  const shared = [...classesOf(finding.claim, 'claim')].filter((c) =>
    classesOf(command, 'command').has(c)
  );
  return shared.length > 0;
}

/**
 * What OTHER projects on this machine learned that applies to this command.
 *
 * The project graph answers "what do we know about this repo". This answers the
 * question that had no owner -- "have I already learned this somewhere else?" --
 * which is where the same mistake was repeated per checkout, because every lesson
 * was filed under the repository that happened to teach it.
 *
 * TRIGGER-MATCHED, NOT ANCHOR-MATCHED. A shared lesson has no meaningful anchor in
 * this project by construction, so the retrieval hook is the command text, using
 * the same appliesToCommand test the local path uses. Anything that cannot say
 * when it applies is not carried across.
 */
export function forSharedCommand(
  projectDir,
  command,
  {
    budget = sharedBudget(), sessionId = null, alreadyInjected = new Set(),
    projectRoot = null, episode = {},
  } = {}
) {
  if (!command) return null;

  try {
    const dir = sharedDir();
    // Nothing to carry when the shared store IS this project's store.
    if (!dir || isSharedDir(projectDir)) return null;

    const graph = load(dir);
    if (!graph.nodes.size) return null;

    const home = projectRoot ? canonicalPath(projectRoot) : null;
    const candidates = [];
    for (const node of graph.nodes.values()) {
      if (node.kind !== 'finding' || node.retired) continue;
      if (quarantineSharedSource(node.sourceProject)) continue;
      if (alreadyInjected.has(node.key)) continue;
      // ITS OWN LESSON IS NOT NEWS. A finding this project contributed is already
      // served by the local path; repeating it under a "from elsewhere" label
      // would both double the tokens and misstate where it came from.
      if (home && node.sourceProject && canonicalPath(node.sourceProject) === home) continue;
      if (!appliesCrossProject(node, command)) continue;
      candidates.push(node);
    }
    if (!candidates.length) return null;

    // Explicit trigger first, then confidence -- the same ordering the local
    // command path uses, for the same reason: a finding whose author wrote a
    // pattern that matches this command is about this command.
    const explicit = (n) => (n.trigger && safeTrigger(n.trigger)?.test(command) ? 1 : 0);
    candidates.sort(
      (a, b) => explicit(b) - explicit(a) || (b.confidence ?? 0.5) - (a.confidence ?? 0.5)
    );

    // No serve() here: these types are not content-dependent, so there is no
    // anchor to re-read and nothing to diff. serve() would spend a file read per
    // finding to answer a question that does not apply to them.
    const considered = candidates.slice(0, MAX_SHARED);
    const assessed = assessFindings(projectDir, considered, {
      episodeId: episode.episodeId || sessionId,
      relevanceFor: (finding) => explicit(finding) ? 0.8 : 0.5,
      costFor: (finding) => estimate(render(finding)),
    });
    if (assessed.rejected.length) {
      record(projectDir, {
        kind: 'retrieval-decision', ...episode, sessionId,
        surface: 'shared', anchor: String(command).slice(0, 120),
        rejected: assessed.rejected.map(({ key, reason }) => ({ key, reason })),
      });
      for (const rejected of assessed.rejected) alreadyInjected.add(rejected.key);
    }
    const { kept, spent } = fit(assessed.eligible.map((item) => item.finding), budget);
    if (!kept.length) return null;

    // THE SAME ARM AS THE LOCAL PATH, KEYED THE SAME WAY.
    //
    // Two defects were being introduced here at once, and both attacked the
    // measurement rather than the feature. Delivering shared lessons to a command
    // that forCommand had assigned to the HOLDOUT arm means the control arm is
    // not a control: it received knowledge, just from a different tier, so any
    // difference between the arms understates what injection does. And spending
    // tokens that no `inject` event describes makes the balance sheet report a
    // cost lower than the one actually paid -- an overstated saving, which is the
    // one number this project must never produce.
    //
    // One key, not two. The arm is a property of the COMMAND; letting the tiers
    // draw separately would put a command in local-treated and shared-holdout at
    // once and contaminate both readings.
    const arm = commandKey(command);
    const holdout = inHoldout(arm);

    record(projectDir, {
      kind: 'inject',
      ...episode,
      trigger: 'command',
      // ITS OWN SURFACE. The balance sheet joins `file` injections to later read
      // events; a shared lesson has no anchor in this project to join to, and
      // folding it into `command` would hide how much of the spend is
      // cross-project when that is exactly what needs weighing.
      surface: 'shared',
      anchor: String(command).slice(0, 120),
      holdout,
      tokens: holdout ? 0 : spent,
      deliveredTokens: holdout ? 0 : spent,
      shadowTokens: spent,
      count: holdout ? 0 : kept.length,
      candidateCount: kept.length,
      findingIds: holdout ? [] : kept.map((finding) => finding.key),
      shadowFindingIds: kept.map((finding) => finding.key),
      stale: false,
      sessionId,
    });

    // MARKED SEEN IN BOTH ARMS, for the reason the local paths document: a
    // command run repeatedly would otherwise write a fresh holdout row every time
    // while a treated command was suppressed after its first delivery, and the
    // report counts rows.
    for (const f of kept) alreadyInjected.add(f.key);

    // Withheld means withheld. Returning the text anyway would record an arm the
    // subject never actually experienced.
    if (holdout) return null;

    // NAMED, NOT HEDGED. Measured on this project: wording that tells a model to
    // discount a claim suppresses correct claims -- findings rendered with "treat
    // this as unverified" scored 1/3 against 2/3 for the identical findings
    // rendered clean. So the origin project is stated as a fact and the reader is
    // left to judge transfer, rather than told in advance to doubt it.
    return `From other projects on this machine:\n${kept
      .map((f) => {
        const from = f.sourceProject ? basename(f.sourceProject) : 'another project';
        return `- [${f.type || 'finding'}] ${f.claim} (learned in ${from})`;
      })
      .join('\n')}`;
  } catch {
    // A cross-project extra must never cost the caller their tool call.
    return null;
  }
}


const RELEVANCE_STOP_WORDS = new Set([
  'about', 'after', 'again', 'before', 'could', 'from', 'have', 'into',
  'just', 'need', 'that', 'their', 'there', 'these', 'this', 'those',
  'using', 'want', 'when', 'where', 'which', 'with', 'would', 'your',
]);

function relevanceTerms(value) {
  return [...new Set(String(value || '').toLowerCase()
    .split(/[^a-z0-9_.:/-]+/)
    .map((term) => term.replace(/^[_.:/-]+|[_.:/-]+$/g, ''))
    .filter((term) => term.length >= 3 && !RELEVANCE_STOP_WORDS.has(term)))];
}

/**
 * Selects finding keys only when a lifecycle payload contains actual task text.
 * Session-start envelopes that carry only cwd/session metadata deliberately
 * return no ids; their first file/command event uses the contextual injectors.
 */
export function relevantFindingIdsForContext(graph, context, { limit = 8 } = {}) {
  const query = String(context || '').trim();
  const queryTerms = relevanceTerms(query);
  if (queryTerms.length < 2) return [];

  return [...graph.nodes.values()]
    .filter((finding) =>
      finding.kind === 'finding'
      && finding.retired !== true
      && typeof finding.key === 'string'
      && typeof finding.claim === 'string')
    .map((finding) => {
      const content = [
        finding.key,
        finding.claim,
        finding.trigger,
        ...(finding.anchors || []),
      ].filter(Boolean).join(' ');
      const terms = new Set(relevanceTerms(content));
      const matches = queryTerms.filter((term) => terms.has(term)).length;
      return { finding, matches };
    })
    // Two independent terms keeps a generic word such as "test" or "file"
    // from turning the bounded index into an unrelated project-wide dump.
    .filter(({ matches }) => matches >= 2)
    .sort((a, b) =>
      b.matches - a.matches
      || (b.finding.confidence || 0.5) - (a.finding.confidence || 0.5)
      || a.finding.key.localeCompare(b.finding.key))
    .slice(0, Math.max(0, limit))
    .map(({ finding }) => finding.key);
}

/**
 * The bounded SessionStart index: titles and ids only, never bodies.
 *
 * Its budget is EARNED from measured hit rate rather than fixed, so a mature
 * graph that demonstrably gets queried grows its allowance while a noisy one
 * shrinks toward the floor. See metrics.indexBudget.
 */
export function sessionIndex(dir, graph, { episode = {}, relevantFindingIds = [] } = {}) {
  // DRAINED HERE TOO, and this is the worst place to be wrong. The session index
  // is the FIRST thing a session sees and it arrives with no other context to
  // correct it, so advertising a finding the graph already knows is stale is a
  // false claim made at maximum leverage. The graph is loaded either way, so the
  // only cost is the stat that finds no queue.
  graph = withPendingApplied(dir, graph);
  const budget = indexBudget(dir);
  const relevant = new Set(relevantFindingIds);
  // Some SessionStart payloads have no task signal. Fail closed for situational
  // findings until the adapter supplies ids selected from actual task text.
  // Universal human/pinned rules are delivered separately by `standingRules`.
  if (!relevant.size) return null;
  // RETIRED findings must not appear. They are excluded from every other read
  // path, so listing them here would advertise claims a human has explicitly
  // withdrawn -- and the index is the first thing the model reads.
  const allFindings = [...graph.nodes.values()]
    .filter((n) => n.kind === 'finding');
  const findings = allFindings
    .filter((n) =>
      !n.retired
      && typeof n.claim === 'string'
      && typeof n.key === 'string'
      && relevant.has(n.key)
      // These are already rendered in full by `standingRules`; listing them a
      // second time spends tokens without adding information.
      && n.pinned !== true
      && !(n.type === 'feedback' && n.origin === 'human')
    );
  if (!findings.length) return null;

  const now = Date.now();
  const ranked = findings.sort((a, b) =>
    ((b.confidence || 0.5) / (1 + (now - (b.at || now)) / 2.6e9)) -
    ((a.confidence || 0.5) / (1 + (now - (a.at || now)) / 2.6e9)));

  const selected = [];
  for (const finding of ranked) {
    // Staleness checks can touch disk, so bound the candidates BEFORE serving
    // them rather than checking an arbitrarily large graph on SessionStart.
    const candidate = [...selected, finding];
    const preview = renderSessionIndex(allFindings.length, candidate);
    if (estimate(preview) > budget) break;
    selected.push(finding);
  }
  if (!selected.length) return null;

  // `serve` is the only path allowed to hand a finding to a model. In
  // particular, activating this previously-unwired index must not create a new
  // path that labels an invalidated content claim as current.
  const served = serve(graph, selected, { dir });
  if (!served.length) return null;
  // A stale marker is longer than the fresh preview used for candidate
  // selection. Trim from the lowest-ranked end until the ACTUAL message fits.
  while (served.length && estimate(renderSessionIndex(allFindings.length, served)) > budget) {
    served.pop();
  }
  if (!served.length) return null;
  const text = renderSessionIndex(allFindings.length, served);
  const spent = estimate(text);
  const findingIds = served.map((finding) => finding.key);

  record(dir, {
    ...episode,
    kind: 'index',
    surface: 'session-start',
    count: served.length,
    tokens: spent,
    findingIds,
    staleCount: served.filter((finding) => finding.stale).length,
  });
  record(dir, {
    ...episode,
    kind: 'inject',
    surface: 'session-start',
    anchor: 'session-index',
    holdout: false,
    tokens: spent,
    deliveredTokens: spent,
    shadowTokens: spent,
    count: served.length,
    candidateCount: selected.length,
    findingIds,
    shadowFindingIds: findingIds,
    stale: served.some((finding) => finding.stale),
  });

  return text;
}

function renderSessionIndex(total, findings) {
  const lines = findings.map((finding) => {
    const freshness = finding.stale && finding.staleEvidence
      ? ` [STALE: ${finding.staleReason || 'anchor evidence changed'}]`
      : finding.stale
        ? ' [possibly stale; verify before use]'
        : '';
    // The session index is the first thing a session reads, so a disputed
    // finding must not be listed there as settled either. Compressed to a
    // marker and a key, matching the freshness markers beside it.
    const dispute = finding.contradicted
      ? finding.contradictedBy
        ? ` [DISPUTED by ${finding.contradictedBy}]`
        : ' [DISPUTED]'
      : '';
    return `- ${finding.key}${freshness}${dispute}: ${finding.claim.slice(0, 90)}`;
  });
  return `# Project wiki (${total} findings, ${findings.length} listed)

Established in previous sessions. Call wiki_query with a key for detail, or just
work -- findings anchored to a file are surfaced automatically when you touch it.

${lines.join('\n')}`;
}

/**
 * The always-on set: rules that must hold before the first tool call.
 *
 * WHY THESE CANNOT BE TRIGGER-FIRED. A trigger answers "this situation is
 * happening now". Some rules are not about a situation -- "report the number you
 * measured, not the one you expected" governs how every turn is conducted, and
 * by the time any command matched a trigger the turn would already be going
 * wrong. Those have to be present before anything happens or they are useless.
 *
 * WHY THIS IS NOT THE SESSION INDEX. `sessionIndex` lists keys and truncated
 * titles and tells the model to call wiki_query for detail; that is right for a
 * catalogue of things it MIGHT want. A standing rule that needs a lookup before
 * it can be obeyed is not a standing rule -- so these are rendered in full, and
 * are budgeted separately and much more tightly because of it.
 *
 * WHAT QUALIFIES, deliberately narrow:
 *   - anything a human PINNED, which curate.mjs already defines as a fact that
 *     stays true and should not decay, or
 *   - a `feedback` lesson whose quote was verified against the transcript, so a
 *     person demonstrably said it.
 *
 * Everything else waits for its trigger. The failure mode this guards against
 * is the one that already happened here: an always-on block that grows until it
 * is wallpaper, and the model stops reading the thing it always sees.
 */
export function standingRules(dir, graph, { budget = standingBudget(), episode = {} } = {}) {
  // Same reason as sessionIndex: always-on text, delivered before the first
  // tool call, with nothing following it that could qualify what it said.
  graph = withPendingApplied(dir, graph);
  const rules = [...graph.nodes.values()].filter(
    (n) =>
      n.kind === 'finding' &&
      !n.retired &&
      typeof n.claim === 'string' &&
      (n.pinned === true || (n.type === 'feedback' && n.origin === 'human'))
  );
  if (!rules.length) return null;

  // A person's own correction outranks anything inferred, then confidence.
  rules.sort((a, b) => {
    const weight = (n) => (n.origin === 'human' ? 2 : n.pinned ? 1.5 : 1);
    return weight(b) * (b.confidence ?? 0.5) - weight(a) * (a.confidence ?? 0.5);
  });

  // THE BUDGET COVERS THE WHOLE MESSAGE, not just the claim lines.
  //
  // `spent` used to count selected claims only, while the returned text also
  // carries a heading, two lines of fixed instruction and an optional
  // truncation notice. A selection that exactly filled the budget therefore
  // injected more than the budget allowed and recorded fewer tokens than it
  // spent -- in a block whose entire justification is that it is tightly
  // bounded and measured against the control arm.
  // THE LAST LINE IS HOW THE NEXT RULE GETS HERE, and it is one line because
  // this block is charged on every session forever. A rule reaches this list
  // only by being pinned or by being a person's verified correction, and both
  // start as a `wiki_write` -- so a model reading a set of standing rules with
  // no idea how they were produced has no way to add to it. Stated at the point
  // of the evidence rather than as a separate always-on block: the reader is
  // already looking at the output of the mechanism being described.
  //
  // THE COLD GRAPH IS COVERED ELSEWHERE, deliberately. Nothing here renders
  // until at least one rule qualifies, which is the property the always-on
  // budget depends on, so this line cannot be the first-session nudge --
  // `policyText`'s "Record what you work out" section is, and it is emitted at
  // SessionStart whether or not the graph holds anything.
  const HEADING =
    '# Standing rules for this project' +
    '\n\nEstablished in previous sessions and expected to hold. ' +
    'These are not suggestions.\n\n' +
    'Record what you work out with wiki_write and a real file anchor; ' +
    'that is how a rule reaches this list.\n\n';
  const noticeFor = (n) =>
    n
      ? `\n(${n} further standing rule${n === 1 ? '' : 's'} did not fit this budget; ` +
        'raise TOKEN_OPTIMIZER_STANDING_BUDGET or retire some.)'
      : '';

  // The wrapper is charged up front, and the worst-case notice is reserved, so
  // admitting the last line can never push the total over by adding one.
  const overhead = estimate(HEADING) + estimate(noticeFor(rules.length));

  const lines = [];
  let spent = overhead;
  let dropped = 0;
  for (const rule of rules) {
    const line = `- ${rule.claim}`;
    const cost = estimate(line);
    if (spent + cost > budget) {
      dropped += 1;
      continue;
    }
    lines.push(line);
    spent += cost;
  }

  // RECORDED EVEN WHEN NOTHING FITS. Returning early without a metric hid the
  // one case most worth knowing about: rules exist and every one is too large
  // for the budget, so the block silently does nothing all session and the
  // measurement shows no sign of it.
  const truncated = noticeFor(dropped);
  record(dir, {
    ...episode,
    kind: 'standing',
    count: lines.length,
    dropped,
    tokens: lines.length ? spent : 0,
  });
  if (!lines.length) return null;

  // SAY WHAT WAS DROPPED. A silent cap reads as "these are all the rules",
  // which is worse than saying there are more: a model that knows the list is
  // truncated can ask, one that does not will assume it is complete.
  return `${HEADING}${lines.join('\n')}${truncated}`;
}

/**
 * SessionStart context, assembled in cache order: stable first, volatile last.
 *
 * WHY THE ORDER IS A CORRECTNESS PROPERTY AND NOT A STYLE CHOICE. Everything
 * here lands near the FRONT of the prompt prefix, and a prefix cache is
 * invalidated from the first differing byte onward. A block whose text changes
 * between sessions therefore prices everything positioned after it: put the
 * freshest block first and the whole remainder of the prefix is re-written
 * every session; put it last and the invalidation is confined to its own tail.
 * cache.mjs measures exactly this cost in the user's files -- this is the same
 * discipline applied to our own output, which is the half nobody else has to
 * think about because nobody else writes into the prefix.
 *
 * `cacheOrdered` existed for precisely this and had no caller, so the order was
 * whatever order the call sites happened to push in. It was accidentally right;
 * it is now enforced, which is the difference that matters the next time a
 * block is added.
 *
 * VOLATILITY IS ASSIGNED FROM HOW OFTEN THE TEXT ACTUALLY DIFFERS BETWEEN
 * SESSIONS, not from how important the block is:
 *
 *   0  policy -- the optimization notice and project briefing. Deliberately
 *      cache-safe by construction: the routing facts are number-free and the
 *      briefing passes through `stableText`, which DROPS any line that would
 *      vary. It changes when the tool inventory or configuration changes.
 *   1  standing -- pinned facts and human-verified corrections, rendered in
 *      full. Changes only when a person pins, retires or corrects something.
 *   2  index -- the bounded wiki index, selected per session from the task
 *      text, and carrying [STALE]/[DISPUTED] markers that flip as the code
 *      moves. Different on most sessions.
 *   3  restoration -- present only when resuming from a compaction, and derived
 *      from the anchors of the session that was just discarded. Never twice the
 *      same.
 *
 * A block with no text is dropped rather than joined, so an absent block cannot
 * open the assembly with a blank line.
 */
export function sessionContext(blocks) {
  return cacheOrdered(
    (Array.isArray(blocks) ? blocks : []).filter(
      (block) => block && typeof block.text === 'string' && block.text.trim()
    )
  )
    .map((block) => block.text)
    .join('\n\n');
}

/**
 * The zero-turn refusal payload.
 *
 * When the model re-reads a file the graph has a snapshot of, the refusal can
 * carry the diff instead of merely pointing at smart_read. The model gets the
 * answer inside the refusal, so no second call is needed at all.
 *
 * Returns null when no snapshot exists, in which case the caller falls back to
 * the ordinary redirect -- this is an optimization on top of a working path,
 * never a replacement for it.
 */
/**
 * What a refusal returns INSTEAD of the file.
 *
 * Ordered by how much better than the file each option is:
 *
 *   1. UNCHANGED since the last read -- say so; there is nothing to send.
 *   2. CHANGED and we hold a snapshot -- send the diff.
 *   3. Otherwise -- send the annotated skeleton: structure plus every finding
 *      anchored to it, plus git history when nothing has been learned yet.
 *
 * Only (3) is new, and it is the one that inverts the interaction. A refusal
 * stops being a tax the model pays to get the real answer and becomes the most
 * informative response available -- more useful than the file, not a lossier
 * version of it.
 */
export function substitutionFor(
  dir,
  graph,
  rawPath,
  source,
  { sessionId, client = null, clientVersion = null, model = null, modelVersion = null } = {}
) {
  const filePath = canonicalPath(rawPath);
  const budget = substitutionBudget(dir, filePath);
  const built = annotatedSkeleton(graph, rawPath, source, { budget });

  // A skeleton that is not meaningfully cheaper than the file saves nothing and
  // costs the model a round trip; send it back to the ordinary redirect.
  if (built.tokens * 4 > source.length * 0.5) return null;

  // THE HOLDOUT BELONGS ON THIS PATH, not only on findings injection.
  //
  // Substitution is the lever that actually moves tokens -- it replaces a whole
  // file with a skeleton -- and it had no control arm at all, while the 10%
  // holdout sat on findings injection, which is two orders of magnitude
  // smaller. Withholding here serves the file the model asked for and records
  // what that cost, which is the only way the saving stops being an assumption.
  // PINNED FOR THE SESSION, with a fixed epoch.
  //
  // Unlike the file-touch arm above, this one must not rotate: a session
  // running across midnight would substitute for a file in one half and serve
  // the whole file in the other, so `measuredCounterfactual` would mix treated
  // and control observations for the same file.
  //
  // Keying on the session alone was not enough -- with the epoch still in play
  // the arm flipped 104 times in 400 simulated midnight crossings. The session
  // id already provides the rotation the epoch was there for.
  const holdout = inHoldout(`${sessionId || ''}|${filePath}`, 0);

  record(dir, {
    kind: 'substitute',
    anchor: filePath,
    // Recorded so provenance is checkable. Without it, 366 of 370 substitutions
    // on this machine turned out to be the enforcement suite's own fixture and
    // nothing distinguished them from real work.
    sessionId,
    client,
    clientVersion,
    model,
    modelVersion,
    holdout,
    tokens: holdout ? 0 : built.tokens,
    findings: built.findings,
    symbols: built.symbols,
    // GROSS, kept for continuity with existing records.
    bytesAvoided: holdout ? 0 : source.length,
    // NET, which is the honest figure: the skeleton was still sent. Reporting
    // the whole file as avoided while spending `tokens` on a replacement
    // overstates the saving by exactly the size of the replacement.
    tokensNetAvoided: holdout ? 0 : Math.max(0, Math.ceil(source.length / 4) - built.tokens),
    // What the control arm actually paid, so the two arms are comparable.
    tokensFullFile: Math.ceil(source.length / 4),
  });

  // Withheld means the model gets what it asked for: the whole file. That is
  // the control arm, and it must really be paid or the comparison is fiction.
  if (holdout) return null;

  return built.text;
}

/**
 * `seenThisSession` is not optional bookkeeping -- it is what makes both
 * branches below TRUE statements.
 *
 * The graph is durable and per project; a snapshot in it may have been captured
 * days ago by a different session. "Unchanged since you last read it" and "here
 * is the diff" are both claims about what the READER already holds, and a
 * session that never read the file holds nothing. Observed live: a brand-new
 * session's FIRST EVER read of a file was refused with "use what you already
 * have", which withheld content the model had never seen. Defaulting to false
 * means a caller that cannot answer the question falls back to the annotated
 * skeleton, which is true regardless of history.
 */
export function refusalPayload(graph, rawPath, { maxDiffLines = 60, seenThisSession = false } = {}) {
  if (!seenThisSession) return null;

  const filePath = canonicalPath(rawPath);
  const anchor = graph.nodes.get(nodeId('file', filePath));
  if (!anchor || !anchor.snapshot) return null;

  let current = null;
  for (const candidate of resolvableCandidates(rawPath)) {
    try {
      current = readFileSync(candidate, 'utf8');
      break;
    } catch { /* try the next spelling */ }
  }
  if (current === null) return null;

  if (current === anchor.snapshot) {
    return `${filePath} is UNCHANGED since you last read it this session. ` +
      `Nothing to re-read -- use what you already have.`;
  }

  const diff = diffLines(anchor.snapshot, current, { maxLines: maxDiffLines });
  // A diff approaching the size of the file saves nothing; fall back.
  if (estimate(diff) > estimate(current) * 0.6) return null;

  return `${filePath} changed since you read it. Here is the diff, so you do not ` +
    `need to re-read it:\n\n${diff}`;
}

/**
 * Co-occurrence: files worked on together become weakly related.
 *
 * This closes the one real gap in traversal-only retrieval -- a finding that is
 * relevant but structurally unconnected -- WITHOUT an embedding model. It is
 * collaborative filtering over the agent's own attention: whatever gets opened
 * together is related, learned from behaviour rather than from vector geometry,
 * and it costs one edge write.
 *
 * Edges are capped per task so a session that touches 200 files does not write
 * 20,000 edges.
 */
export function linkCoOccurrence(dir, sessionId, paths, { maxLinks = 40 } = {}) {
  const unique = [...new Set(paths.map((p) => canonicalPath(p)))].slice(0, 12);
  let written = 0;

  for (let i = 0; i < unique.length && written < maxLinks; i++) {
    for (let j = i + 1; j < unique.length && written < maxLinks; j++) {
      putEdge(dir, nodeId('file', unique[i]), 'related', nodeId('file', unique[j]));
      written++;
    }
  }
  if (sessionId && unique.length) {
    putNode(dir, { kind: 'task', key: sessionId, files: unique.length });
  }
  return written;
}
