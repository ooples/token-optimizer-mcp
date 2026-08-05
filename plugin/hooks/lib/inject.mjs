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
import { findingsFor, putNode, putEdge, nodeId } from './wiki.mjs';
import { serve, diffLines } from './staleness.mjs';
import { inHoldout, record, indexBudget } from './metrics.mjs';
import { canonicalPath, resolvableCandidates } from './paths.mjs';
import { annotatedSkeleton } from './skeleton.mjs';
import { substitutionBudget } from './metrics.mjs';

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

function render(finding) {
  const head = `- [${finding.type || 'finding'}] ${finding.claim}`;
  if (!finding.stale) return head;
  // A stale finding NEVER renders without its evidence. Serving one bare would
  // be worse than having no graph at all.
  return `${head}\n  STALE (${finding.staleReason}). What changed:\n${finding.diff}`;
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
  { budget = touchBudget(), sessionId, alreadyInjected = new Set() } = {}
) {
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
  const served = serve(graph, candidates);
  const { kept, spent } = fit(served, budget);

  record(dir, {
    kind: 'inject',
    // The surface whose saving CAN be measured: reads of this anchor afterwards.
    surface: 'file',
    anchor: filePath,
    holdout,
    tokens: holdout ? 0 : spent,
    count: kept.length,
    stale: kept.some((f) => f.stale),
    sessionId,
  });

  // MARKED SEEN IN BOTH ARMS, for the same reason as the command path: a file
  // touched repeatedly -- the normal shape of working on it -- would otherwise
  // write a fresh holdout row every time while a treated file was suppressed
  // after its first delivery. The report counts rows, so the control arm would
  // grow faster purely from repetition.
  //
  // This is the identical defect that was fixed in `forCommand` and not here.
  for (const f of kept) alreadyInjected.add(f.key);

  if (holdout || !kept.length) return null;

  return `Known about ${filePath} (from previous sessions):\n${kept.map(render).join('\n')}`;
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
  { budget = touchBudget(), sessionId, alreadyInjected = new Set() } = {}
) {
  if (!command) return null;

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

  const served = serve(graph, considered);
  const { kept, spent } = fit(served, budget);
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
    trigger: 'command',
    // The surface the report needs to keep these OUT of the file-read balance:
    // a command has no anchor that read events can be joined to.
    surface: 'command',
    anchor: String(command).slice(0, 120),
    holdout,
    tokens: holdout ? 0 : spent,
    count: holdout ? 0 : kept.length,
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
 * The bounded SessionStart index: titles and ids only, never bodies.
 *
 * Its budget is EARNED from measured hit rate rather than fixed, so a mature
 * graph that demonstrably gets queried grows its allowance while a noisy one
 * shrinks toward the floor. See metrics.indexBudget.
 */
export function sessionIndex(dir, graph) {
  const budget = indexBudget(dir);
  // RETIRED findings must not appear. They are excluded from every other read
  // path, so listing them here would advertise claims a human has explicitly
  // withdrawn -- and the index is the first thing the model reads.
  const findings = [...graph.nodes.values()]
    .filter((n) => n.kind === 'finding' && !n.retired && typeof n.claim === 'string');
  if (!findings.length) return null;

  const now = Date.now();
  const ranked = findings.sort((a, b) =>
    ((b.confidence || 0.5) / (1 + (now - (b.at || now)) / 2.6e9)) -
    ((a.confidence || 0.5) / (1 + (now - (a.at || now)) / 2.6e9)));

  const lines = [];
  let spent = 0;
  for (const finding of ranked) {
    const line = `- ${finding.key}: ${finding.claim.slice(0, 90)}`;  // claim guaranteed above
    const cost = estimate(line);
    if (spent + cost > budget) break;
    lines.push(line);
    spent += cost;
  }
  if (!lines.length) return null;

  record(dir, { kind: 'index', count: lines.length, tokens: spent });

  return `# Project wiki (${findings.length} findings, ${lines.length} listed)

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
export function standingRules(dir, graph, { budget = standingBudget() } = {}) {
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
  const HEADING =
    '# Standing rules for this project' +
    '\n\nEstablished in previous sessions and expected to hold. ' +
    'These are not suggestions.\n\n';
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
export function substitutionFor(dir, graph, rawPath, source, { sessionId } = {}) {
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
