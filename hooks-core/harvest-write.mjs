/**
 * Writing harvested findings into the graph -- the missing half of P3.
 *
 * `harvest.mjs` builds a digest, calls a cheap model, and validates what comes
 * back. Nothing consumed it: the module was imported by no hook and no source
 * file, so the semantic layer never ran and the graph accumulated only its
 * structural skeleton. Measured on a real project after a full session of work:
 * 122 file nodes, 132 symbol nodes, 61 task nodes, and ZERO findings.
 *
 * This is deliberately NOT `curate.create()`. That function stamps
 * `origin: ORIGIN_HUMAN` and a `human-` key because it exists for a person
 * asserting something. Routing machine output through it would label a model's
 * guess as a human assertion, which is the exact confusion curate.mjs warns
 * about: "a hand-written assertion and a machine guess look identical three
 * months later, which quietly destroys the reader's ability to calibrate trust".
 *
 * The anchor discipline is copied from `create()` on purpose. A `derived_from`
 * edge pointing at an id nothing created yields a finding that LOOKS anchored to
 * `audit()` while `checkAnchor` can never run on it -- an un-invalidatable
 * claim. So each anchor is indexed first, and a finding whose anchors all fail
 * to resolve is refused rather than stored as permanently-current.
 */

import {
  putNodeWithEdges, load, nodeId, sharedDir, isSharedDir, putNode, putEdge,
  unrootedRoot, projectRootFor,
} from './wiki.mjs';
import { indexFile } from './staleness.mjs';
import { symbolKey } from './symbols.mjs';
import { canonicalPath } from './paths.mjs';
import { randomBytes } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { ORIGIN_HARVESTED, ORIGIN_AGENT, ORIGIN_HUMAN } from './curate.mjs';
import { readEvidence, evidenceTruncated } from './metrics.mjs';

/**
 * The types that may cross a project boundary.
 *
 * This is not a new taxonomy: it is the exact complement of the set staleness.mjs
 * already calls CONTENT_DEPENDENT. A `finding` or a `map` is a claim ABOUT the
 * anchor's contents, so it is only true where those contents are; carrying it to
 * another repository would assert something about files that repository does not
 * have. The rest -- what a command does, what failed, what was decided, what the
 * user asked for -- are claims about the WORK, and the work follows the person.
 *
 * Deriving one set from the other keeps them from drifting apart: if a type ever
 * becomes content-dependent, it stops being shareable in the same commit.
 */
export const SHAREABLE_TYPES = new Set(['command', 'failure', 'decision', 'feedback']);

/**
 * Synthetic study traffic must never become advice for an unrelated live repo.
 * Evaluation roots are intentionally realistic and may carry their own `.git`
 * marker, so repository discovery alone cannot distinguish them. Publication
 * remains useful inside the isolated study store; this guard protects only the
 * default machine-wide store when a harness was accidentally run without an
 * isolated TOKEN_OPTIMIZER_SHARED_DIR.
 */
export function isEphemeralProject(projectRoot) {
  const root = canonicalPath(projectRoot || '').toLowerCase();
  if (!root) return true;
  return (
    /\/appdata\/local\/temp\//.test(root) ||
    /(^|\/)tmp\//.test(root) ||
    /\/(artifacts|\.token-optimizer)\/(?:[^/]*\/)*(?:eval|scenario|study|fixture|debug)[^/]*\//.test(`${root}/`)
  );
}

export function quarantineSharedSource(projectRoot) {
  if (process.env.TOKEN_OPTIMIZER_ALLOW_EPHEMERAL_SHARED === '1') return false;
  if (!isEphemeralProject(projectRoot)) return false;
  // Isolated studies deliberately point the shared tier at scratch storage.
  // Their findings may cross their own fixture projects, but cannot escape into
  // the user's default machine-wide graph. Strict mode exists for a regression
  // probe that verifies the guard without writing to a real user directory.
  return (
    !process.env.TOKEN_OPTIMIZER_SHARED_DIR ||
    process.env.TOKEN_OPTIMIZER_STRICT_SHARED_PROVENANCE === '1'
  );
}

/** Claim text, normalised enough that the same lesson learned twice is one row. */
const claimFingerprint = (claim) =>
  String(claim || '').toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 300);

/**
 * Copies a portable lesson into the machine-wide graph.
 *
 * ANCHORED TO THE PROJECT IT CAME FROM, not to the file that happened to be open.
 * The source file's path means nothing in another checkout, and an unanchored
 * finding is refused everywhere else in this codebase for a good reason -- so the
 * shared copy is anchored to its origin project's root, which is a real path, is
 * never content-checked (these types are not content-dependent), and doubles as
 * the provenance the reader needs to judge whether the lesson transfers.
 *
 * Failures here are swallowed: this runs inside the harvest worker, and the
 * project-local write has already succeeded. A shared tier that cannot be written
 * must not cost the caller the lesson it just learned.
 */
function promoteToShared(finding, { projectRoot, sessionId, provenance, key }) {
  try {
    if (!SHAREABLE_TYPES.has(finding.type)) return false;
    const target = sharedDir();
    if (!projectRoot) return false;

    const root = canonicalPath(projectRoot);
    if (quarantineSharedSource(root)) return false;
    const rootId = nodeId('file', root);

    // Same claim, already carried up from anywhere: keep the first. Two repos
    // teaching the same lesson is evidence it generalises, not a reason to say
    // it twice on every command.
    const graph = load(target);
    const fp = claimFingerprint(finding.claim);
    for (const node of graph.nodes.values()) {
      if (node.kind !== 'finding' || node.retired) continue;
      if (claimFingerprint(node.claim) === fp) return false;
    }

    // The anchor node must exist before the edge points at it, or the shared
    // graph inherits exactly the orphan-finding problem the local one refuses.
    if (!graph.nodes.has(rootId)) putNode(target, { kind: 'file', key: root });

    return Boolean(
      putNodeWithEdges(
        target,
        {
          kind: 'finding',
          key: `shared-${key}`,
          claim: finding.claim,
          confidence: finding.confidence,
          confidenceLabel: finding.confidenceLabel,
          type: finding.type,
          trigger: typeof finding.trigger === 'string' && finding.trigger ? finding.trigger : undefined,
          applicability: finding.applicability,
          evidence: finding.evidence,
          invalidators: Array.isArray(finding.invalidators) ? finding.invalidators : [],
          scope: finding.scope || 'global',
          origin: provenance,
          quote: typeof finding.quote === 'string' && finding.quote.trim() ? finding.quote : undefined,
          // WHERE IT WAS LEARNED, carried so the reader can discount it. A lesson
          // from another repository is worth surfacing and is not automatically
          // true here; naming its origin is what lets that judgement be made.
          sourceProject: root,
          sessionId,
        },
        [{ edge: 'derived_from', to: rootId }]
      )
    );
  } catch {
    /* the local write already succeeded; the shared tier is best-effort */
    return false;
  }
}

/**
 * How many refusals retire a cross-project lesson.
 *
 * Two, not one. A single refusal can be the model being cautious about a claim
 * that is in fact fine here, and retiring on one would let a single hedge delete
 * knowledge. Two independent sessions declining the same lesson is a pattern
 * about the LESSON rather than about one moment.
 */
const REFUSALS_TO_RETIRE = 2;

/**
 * Language that marks a delivered lesson as declined for NOT TRANSFERRING.
 *
 * Deliberately narrow, and narrower than it first was. Bare uncertainty is not a
 * refusal: an answer that supplies a value and adds "verify the filename matches
 * before relying on it" has used the lesson and calibrated it, which is the
 * behaviour a cross-project fact should produce. Only an explicit non-transfer
 * assertion counts.
 */
const REFUSAL_LANGUAGE =
  /(does\s?n[o']?t transfer|doesn't apply here|would be fabrication|belongs to (that|another|a different) (repo|project)|scoped to a different project|carrying it over)/i;

/**
 * Which of the lessons delivered this turn were declined?
 *
 * THE SIGNAL WAS ALREADY THERE AND NOBODY READ IT. Measured on this machine, a
 * shared lesson carrying a build-error baseline was delivered into another
 * project and the model answered: "the 536 figure is HarmonicEngine's baseline
 * for a different build target, and it doesn't transfer." That is the graph being
 * told, in plain words, that a lesson is mis-scoped -- and nothing recorded it,
 * so the same lesson would be delivered again, and again, costing its tokens
 * every time to be refused every time.
 *
 * Matching is by claim rather than by key because the response quotes the claim,
 * not the id. A lesson is only counted when its own distinctive text appears near
 * the refusal, so one refusal in a long answer cannot condemn every lesson
 * delivered alongside it.
 */
export function detectRefusals(delivered, responseText) {
  const text = String(responseText || '');
  if (!text || !Array.isArray(delivered) || !delivered.length) return [];
  if (!REFUSAL_LANGUAGE.test(text)) return [];

  const refused = [];
  for (const lesson of delivered) {
    const claim = String(lesson.claim || '');
    if (!claim) continue;
    // A distinctive fragment of the claim: the longest word run is a poor test,
    // so the check is on the rarest token the claim contains.
    const tokens = (claim.match(/[A-Za-z0-9._/-]{6,}/g) || [])
      .map((t) => t.toLowerCase())
      .filter((t) => !/^(because|through|without|another|different|project)$/.test(t));
    if (!tokens.length) continue;
    const mentioned = tokens.some((t) => text.toLowerCase().includes(t));
    if (mentioned) refused.push(lesson.key);
  }
  return refused;
}

/**
 * Records that a cross-project lesson was declined, retiring it once the pattern
 * is established.
 *
 * A retired finding is excluded from every read path in this codebase, so this
 * stops the lesson costing tokens without destroying it -- the claim and its
 * refusal count stay in the log, which is what makes the decision auditable
 * later. Deleting would leave no trace of why a lesson vanished.
 */
export function recordRefusal(sharedDirPath, key) {
  try {
    const graph = load(sharedDirPath);
    const target = [...graph.nodes.values()].find(
      (n) => n.kind === 'finding' && n.key === key
    );
    if (!target) return null;

    const refusals = (Number(target.refusals) || 0) + 1;
    const retired = refusals >= REFUSALS_TO_RETIRE ? true : target.retired;

    putNode(sharedDirPath, {
      ...target,
      kind: 'finding',
      key: target.key,
      refusals,
      retired,
      retiredReason:
        retired && !target.retired
          ? `declined as non-transferable in ${refusals} sessions`
          : target.retiredReason,
    });
    return { key, refusals, retired: Boolean(retired) };
  } catch {
    return null;
  }
}

/**
 * Back-fills lessons that were learned BEFORE the shared tier existed.
 *
 * Promotion happens at harvest time, so every lesson already in a project graph
 * stays there forever without this -- and on the machine that motivated the
 * feature that was all of them: 35 live lessons, every one filed under the single
 * repository that happened to teach it.
 *
 * IDEMPOTENT, because a migration that cannot be re-run is a migration nobody
 * dares re-run. Promotion dedupes on the claim text, so a second pass over the
 * same graph adds nothing, and a graph that gained findings since the last pass
 * contributes only those.
 *
 * Returns what it did rather than printing, so the caller can report and the
 * tests can assert.
 */
export function promoteExisting(projectDir, projectRoot, { sessionId = 'migration' } = {}) {
  const result = { considered: 0, eligible: 0, promoted: 0, skipped: 0 };
  if (!projectDir || !projectRoot) return result;
  if (isSharedDir(projectDir)) return result;

  let graph;
  try {
    graph = load(projectDir);
  } catch {
    return result;
  }

  for (const node of graph.nodes.values()) {
    if (node.kind !== 'finding' || node.retired || !node.claim) continue;
    result.considered += 1;
    if (!SHAREABLE_TYPES.has(node.type)) continue;
    result.eligible += 1;

    // The stored node already carries everything promotion needs, so it is
    // handed over as-is rather than reconstructed -- a reconstruction would be a
    // second, divergent definition of what a promoted finding looks like.
    const ok = promoteToShared(node, {
      projectRoot,
      sessionId,
      provenance: node.origin,
      key: node.key,
    });
    if (ok) result.promoted += 1;
    else result.skipped += 1;
  }

  return result;
}

/**
 * Resolves an `path` or `path#symbol` anchor to an existing node id.
 * Returns null when the target cannot be created or found.
 */
/** True when a canonical path sits inside the canonical project root. */
function withinProject(path, projectRoot) {
  let candidate = canonicalPath(path);
  let root = canonicalPath(projectRoot);

  // Windows drive and UNC paths are case-insensitive even when a graph written
  // on Windows is inspected from another host. Preserve the stored spelling,
  // but compare the authorization boundary using Windows path semantics.
  if (/^(?:[A-Z]:|\/\/)/.test(root)) {
    candidate = candidate.toLowerCase();
    root = root.toLowerCase();
  }

  if (candidate === root) return true;
  // Compare with a trailing separator so /repo-secrets is not read as inside
  // /repo. Both sides are already canonical, so this is a plain prefix test.
  const prefix = root.endsWith("/") ? root : root + "/";
  return candidate.startsWith(prefix);
}

/**
 * True when a canonical path IS a filesystem root rather than a directory
 * inside one -- "/", a bare drive letter ("C:"), or a UNC share ("//host/share").
 *
 * canonicalPath() already reduces every spelling to one of these forms
 * (drive letters upper-cased, backslashes turned to slashes, MSYS paths
 * rewritten), so this is a plain string test, true on every host regardless
 * of which platform produced the path. Needed because withinProject() is a
 * prefix test: root itself is always its own prefix, so using a root as a
 * containment boundary accepts every absolute path under it, on any OS.
 */
const FS_ROOT = /^(\/|[A-Z]:|\/\/[^/]+\/[^/]+)$/;
export function isFilesystemRoot(canonical) {
  return !canonical || FS_ROOT.test(canonical);
}

/** Resolve symlinks and junctions before applying an authorization boundary. */
function physicalPath(path) {
  try {
    return canonicalPath(realpathSync.native(path));
  } catch {
    return null;
  }
}

function resolveAnchor(dir, anchor, projectRoot) {
  const [rawPath, symbol] = String(anchor).split('#');
  if (!rawPath) return null;

  const path = canonicalPath(rawPath);
  const target = symbol
    ? nodeId('symbol', symbolKey(path, symbol))
    : nodeId('file', path);

  // Some internal harvest paths write against nodes that structural capture
  // already indexed and do not carry a project root. Preserve that established
  // graph-only operation without restoring the old arbitrary read primitive:
  // no root means an existing node may be linked, but no filesystem access.
  if (!projectRoot) return load(dir).nodes.has(target) ? target : null;

  const selectedProject = canonicalPath(projectRoot);
  const unrootedProject = canonicalPath(unrootedRoot());
  const isUnrooted = selectedProject === unrootedProject;

  // wiki_write chooses its graph from the first anchor. Once that graph is the
  // machine-level unrooted bucket, a home-directory containment check alone
  // would also accept later anchors from unrelated repositories under home and
  // copy their snapshots into the wrong graph. Every anchor must independently
  // resolve to the same unrooted bucket before the broader home boundary applies.
  if (
    isUnrooted &&
    canonicalPath(projectRootFor(path, null)) !== unrootedProject
  ) {
    return null;
  }

  // ANCHORS STAY INSIDE THE PROJECT. indexFile READS the file and stores a
  // snapshot of it in the graph, so an anchor is a read primitive: without this,
  // a claim naming ../../.ssh/id_rsa or C:/Users/x/.aws/credentials would copy
  // that file into .token-optimizer and serve it back on the next touch. The
  // findings come from a model reading a transcript, so the paths are not
  // trusted input.
  //
  // The unrooted bucket is a storage location, not a project: nothing on disk
  // lives inside ~/.token-optimizer/unrooted, so using it as the containment
  // root refused every anchor with no VCS ancestor -- dotfiles and user-level
  // configs included. User home is the deliberate boundary for unrooted,
  // user-level files; physical-path resolution below prevents a link beneath
  // it from widening that boundary. EXCEPT when home itself resolves to a
  // filesystem root ("/", a bare
  // drive letter, root user, minimal containers, an unset HOME): a prefix
  // check against a root is true for every absolute path on that root, so
  // that would accept /etc/..., C:/Windows/..., or //share/... anchors that the
  // check exists to refuse.
  // Stay on the unrooted bucket in that case, which nothing resolves inside
  // -- fails closed instead of open.
  const home = homedir();
  const homeIsRoot = isFilesystemRoot(home && canonicalPath(home));
  const containmentRoot =
    isUnrooted && !homeIsRoot ? home : projectRoot;

  // `indexFile` follows filesystem links. A lexical path under home or a
  // project can therefore point at a file physically outside the boundary.
  // Resolve both sides before authorizing the read and fail closed when either
  // path does not exist or cannot be resolved.
  const physicalAnchor = physicalPath(path);
  const physicalRoot = physicalPath(containmentRoot);
  if (
    !physicalAnchor ||
    !physicalRoot ||
    !withinProject(physicalAnchor, physicalRoot)
  ) {
    return null;
  }

  // Indexing creates the file node and its symbols with hashes and spans, which
  // is what makes the claim checkable later.
  indexFile(dir, path);

  return load(dir).nodes.has(target) ? target : null;
}

/**
 * Which task actually produced this finding, when nothing said so directly.
 *
 * ROUND 2's version scanned the WHOLE graph for any task sharing any anchor,
 * broken by recency. An adversarial review constructed four cases where that
 * attributes a finding to the WRONG task:
 *
 *   1. STALE PRIOR SESSION -- a session that reasons from injected memory and
 *      writes a finding about `foo.ts` without touching it this session gets
 *      attributed to whatever task last touched `foo.ts`, possibly days old,
 *      possibly someone else's work.
 *   2. CONCURRENT SESSION -- two windows on one repository; the other
 *      session's task wins if its touch is a millisecond later.
 *   3. OVERLAP, NOT COVERAGE -- a finding anchored to [a, b]; a task that
 *      touched only `b` could still win over one that touched both.
 *   4. THE TIE-BREAK CONTRADICTED ITS OWN COMMENT -- `Number(edge.at) || 0`
 *      with strict `>` means the FIRST edge in log order wins on a tie,
 *      which is the OLDER task, not "more recently" as documented.
 *
 * THE FIX IS NARROWER THAN A BETTER RANKING: SCOPE, THEN REQUIRE COVERAGE.
 * A task only ever belongs to the session that created it -- `harvest()` and
 * `linkCoOccurrence()` (wiki.mjs, inject.mjs) both key a task node by
 * `sessionId`, always, so there is exactly ONE task node for "the current
 * session" and it is `nodeId('task', sessionId)`. Restricting to that ONE
 * node structurally eliminates cases 1 and 2 PROVIDED the identity itself is
 * trustworthy: an UNRELATED sessionId (typo'd, invented, or simply absent)
 * cannot resolve to someone else's task, because a different key is a
 * different node id, full stop, regardless of timing. That is NOT the same
 * guarantee as "no caller can get someone else's task" -- see the note on
 * `authoritativeSessionId` below for the residual this leaves when the
 * identity is real but comes from an untrusted caller.
 *
 * COVERAGE, NOT OVERLAP, fixes case 3: the session's task must have a
 * `derived_from` edge to EVERY one of this finding's anchors, not merely one.
 * A partial touch is not attribution.
 *
 * With the candidate set reduced to at most one node, there is nothing left
 * to break a tie between -- case 4's comparator is not "fixed", it is
 * deleted, because the scenario it was written for (two DIFFERENT tasks both
 * legitimately eligible) cannot occur under this scoping: two task nodes can
 * never share a key, and only the current session's key is ever considered.
 * An edge's `at` therefore plays NO role here: presence of a `derived_from`
 * edge from the session's task to an anchor is what "touched it" means, with
 * or without a timestamp on that edge -- there is no ranking left for a
 * missing timestamp to lose.
 *
 * NO IDENTITY MEANS NO CANDIDATE -- not "fall back to guessing". Absence is
 * the correct answer when the graph cannot support attribution.
 *
 * ROUND 4: THE IDENTITY ITSELF MUST BE AUTHORITATIVE, not merely present.
 * Scoping to `nodeId('task', sessionId)` only refuses an UNRELATED session;
 * it does nothing against a FOREIGN BUT REAL one. `wiki_write`'s `sessionId`
 * is a plain MCP tool argument the calling model supplies, unverified -- a
 * model that names some OTHER, prior session whose task genuinely covered
 * these anchors gets an `answers` edge to that stale task, because coverage
 * cannot tell "this session" from "a session that really did touch these
 * files, named by a string nothing cross-checked". Session id is not
 * evidence unless the CALLER'S OWN CHANNEL is trustworthy, which is true of
 * `plugin/hooks/harvest-worker.mjs` (Claude Code's own hook payload) and not
 * true of a tool-call argument. So this parameter is named for what it must
 * be, `authoritativeSessionId`, and every caller is a promise: pass this only
 * when you did not just read it out of untrusted input. `wiki_write` passes
 * NONE, which means its calls never traverse -- see `writeHarvested`'s own
 * comment at the call site for what that costs and why it is accepted rather
 * than worked around.
 *
 * COVERAGE IS CHECKED AGAINST RESOLVED ANCHORS, not the caller's original
 * list. `writeHarvested` already drops any anchor `resolveAnchor` could not
 * resolve before this function ever runs, so "every anchor" here means every
 * anchor that survived that filter -- self-consistent with the
 * `derived_from` edges the same resolved list produces, but worth stating:
 * an anchor that failed to resolve cannot raise or lower the bar for the
 * anchors that did.
 */
function taskForAnchors(graph, resolvedAnchorIds, authoritativeSessionId) {
  if (!authoritativeSessionId || !resolvedAnchorIds || !resolvedAnchorIds.length) return null;
  const taskTarget = nodeId('task', authoritativeSessionId);
  const task = graph.nodes.get(taskTarget);
  if (!task || task.kind !== 'task') return null;

  for (const anchor of resolvedAnchorIds) {
    const covered = graph.edges.some((edge) =>
      edge.edge === 'derived_from' && edge.from === taskTarget && edge.to === anchor
    );
    // ONE missing anchor refuses the whole attribution. A finding cited three
    // files; this session's task touched two of them -- that is evidence the
    // task did SOME related work, not evidence it produced THIS finding.
    if (!covered) return null;
  }
  return taskTarget;
}

/**
 * A file path the way `recordToolOutcome` (metrics.mjs) already truncates and
 * stores it on a FILE-surface `tool-outcome` event's `anchor` field, so a
 * derivation record can join against that log without a second, divergent
 * notion of "the same anchor".
 *
 * COMMAND-surface events are DECLARED OUT OF SCOPE, not silently missed:
 * `adapter.mjs` stores the COMMAND TEXT in `anchor` for those
 * (`String(command).slice(0, 120)`), so a build or test run can never share
 * an anchor string with a canonical file path -- there is no join key in
 * common, and inventing a command-to-file heuristic (which files did a given
 * `npm test` invocation cover?) is not something this record can answer
 * honestly. `operationsScope` on the returned record says so explicitly,
 * rather than letting an empty `operations` array look like "no build or
 * test ever ran" when the truth is "this join cannot see it".
 */
function anchorLabel(rawAnchor) {
  const path = String(rawAnchor).split('#')[0];
  return canonicalPath(path).slice(0, 120);
}

/** How many recorded operations a single finding's derivation may cite. */
const MAX_DERIVATION_OPERATIONS = 5;

/**
 * The checkable half of provenance: not just where a finding came from, but
 * whether that derivation still holds.
 *
 * Citation-style provenance (a session or task id) answers "where". It never
 * answers "does this still apply" -- that is what staleness already computes,
 * by comparing an anchor's STORED hash against disk. This record is what lets
 * that comparison be reconstructed for a specific claim rather than only for
 * the anchor in general: the hash each anchor carried at the moment this
 * finding was derived from it, plus what evidence exists that any work
 * actually happened against it. `derivationCheck` (staleness.mjs) is the
 * reader that actually performs that comparison at serve time.
 *
 * DELIBERATELY NOT DUPLICATING THE EDGES. `derived_from` already records
 * WHICH anchors this finding cites; restating that here would be a second,
 * driftable copy of the same fact. What is new here, and only here, is the
 * HASH each anchor carried at claim time -- edges carry no such thing.
 *
 * DELIBERATELY NOT A REPLAY LOG. Recording enough to mechanically re-run a
 * derivation is a separate subsystem with real storage cost. This stores only
 * what the evidence log already has: FILE-surface `tool-outcome` events
 * matching these anchors, each reduced to the fields that were actually
 * captured. An event that carries no exit code or output contributes none --
 * nothing here is invented to fill a shape the pipeline does not evidence
 * yet. If a future capture pass adds `exit`/`output` to those events, this
 * starts carrying them with no change to this function.
 *
 * INCOMPLETENESS IS MARKED, NOT IMPLIED. An empty `operations` array is
 * genuinely ambiguous on its own -- it is the same shape whether nothing
 * happened, or something happened but fell outside what this join can see.
 * `operationsComplete` distinguishes them: false when the evidence log itself
 * may have dropped older matches (`evidenceIncomplete`, from
 * `metrics.evidenceTruncated`) OR when more matches existed than the cap
 * kept. A reader can then tell "no operations happened" from "operations
 * existed but are not recorded here" instead of guessing.
 */
function derivationFor(graph, resolvedAnchors, evidence, evidenceIncomplete, anchorSpecs) {
  const anchorHashes = {};
  for (const id of resolvedAnchors) {
    const node = graph.nodes.get(id);
    if (node && typeof node.hash === 'string') anchorHashes[id] = node.hash;
  }

  const labels = new Set((anchorSpecs || []).map(anchorLabel));
  const matching = evidence.filter(
    (event) => event.kind === 'tool-outcome' && labels.has(event.anchor)
  );
  const operations = [...matching]
    .sort((a, b) => (Number(b.at) || 0) - (Number(a.at) || 0))
    .slice(0, MAX_DERIVATION_OPERATIONS)
    .map((event) => {
      const op = {};
      if (typeof event.toolName === 'string' && event.toolName)
        op.tool = event.toolName.slice(0, 60);
      if (typeof event.success === 'boolean') op.success = event.success;
      if (typeof event.at === 'number') op.at = event.at;
      // Forward-compatible, not fabricated: neither field exists on a
      // `tool-outcome` event in this pipeline today, so every operation
      // omits them until a capture pass actually evidences one.
      if (typeof event.exit === 'number') op.exit = event.exit;
      if (typeof event.output === 'string' && event.output)
        op.output = event.output.slice(0, 200);
      return op;
    });

  return {
    at: Date.now(),
    anchors: anchorHashes,
    operations,
    // FILE touches only -- see `anchorLabel`. Declared here, in the record
    // itself, not only in this function's comment, so a reader who never
    // opens this source file still learns builds and test runs are excluded.
    operationsScope: 'file',
    operationsComplete: !evidenceIncomplete && matching.length <= operations.length,
  };
}

/**
 * Writes validated findings, returning the keys actually stored.
 *
 * `findings` is the output of `harvest.validate()`, so type/claim/confidence
 * are already checked; what remains is anchor resolution, which needs the graph.
 */
export function writeHarvested(
  dir,
  findings,
  {
    sessionId = null,
    origin = ORIGIN_HARVESTED,
    projectRoot = null,
    taskId = null,
    // Distinct from `sessionId`, which is stored on every finding for
    // provenance/display regardless of trust. This one gates the `answers`
    // traversal fallback specifically, and every caller passing it is
    // asserting the identity came from a channel it does not control --
    // Claude Code's own hook payload, not a tool-call argument a model
    // typed. See `taskForAnchors`'s comment for the attack this closes.
    authoritativeSessionId = null,
  } = {}
) {
  if (!Array.isArray(findings) || !findings.length) return [];

  // The batch default. A caller asking for anything else -- notably
  // ORIGIN_HUMAN -- would be labelling machine output as a person's assertion,
  // which is the confusion the field exists to prevent.
  const batch = origin === ORIGIN_AGENT ? ORIGIN_AGENT : ORIGIN_HARVESTED;

  /**
   * ORIGIN_HUMAN IS EARNED PER FINDING, BY EVIDENCE.
   *
   * A batch-wide origin was the whole story here, and it silently discarded
   * the per-lesson provenance `validateLessons` had just computed: a
   * correction whose quote was verified word-for-word in the user's own turn
   * was stored as ORIGIN_HARVESTED like any model paraphrase. The standing-
   * rules layer selects on human origin, so it matched nothing this pipeline
   * wrote, and the verbatim check had no observable effect at all.
   *
   * The original rule still holds -- a caller cannot simply DECLARE machine
   * output human. It is the verified quote that promotes it, and the quote is
   * stored alongside so the claim carries its own evidence.
   */
  const provenanceFor = (finding) =>
    finding.origin === ORIGIN_HUMAN &&
    typeof finding.quote === 'string' &&
    finding.quote.trim()
      ? ORIGIN_HUMAN
      : batch;
  const prefixFor = (p) =>
    p === ORIGIN_AGENT ? 'agent' : p === ORIGIN_HUMAN ? 'human' : 'harvested';

  // Read once: every finding in this batch shares the same evidence log, and
  // it can hold thousands of lines, so re-reading it per finding would turn a
  // batch of N findings into N passes over the same bytes.
  const evidence = readEvidence(dir);
  // Cheap: one stat call, checked once per batch rather than once per
  // finding's derivation record.
  const evidenceIncomplete = evidenceTruncated(dir);

  const written = [];
  for (const finding of findings) {
    const resolved = [];
    for (const anchor of finding.anchors || []) {
      const target = resolveAnchor(dir, anchor, projectRoot);
      if (target && !resolved.includes(target)) resolved.push(target);
    }
    // A claim about files that do not exist cannot be verified against
    // anything, so it is dropped rather than kept as unfalsifiable.
    if (!resolved.length) continue;

    // Exact semantic duplicates collapse to the existing active record.  The
    // normalisation intentionally ignores punctuation/formatting noise but not
    // meaning-bearing words; near-duplicates that need judgement remain visible
    // to curation rather than being silently merged by a fuzzy heuristic.
    const fingerprint = claimFingerprint(finding.claim);
    const currentGraph = load(dir);
    const duplicate = [...currentGraph.nodes.values()].find((node) =>
      node.kind === 'finding'
      && !node.retired
      && node.type === finding.type
      && claimFingerprint(node.claim) === fingerprint
    );
    if (duplicate) {
      // Enrich, do not duplicate. A symbol extractor may learn how to resolve a
      // previously file-only anchor (or a later session may add another real
      // anchor) after the claim was first stored. Repeating the same semantic
      // conclusion should connect that existing node to the newly available
      // evidence, not create a second dashboard card with the same text.
      for (const target of resolved) {
        const alreadyLinked = currentGraph.edges.some((edge) =>
          edge.from === duplicate.id
          && edge.edge === 'derived_from'
          && edge.to === target
        );
        if (!alreadyLinked) putEdge(dir, duplicate.id, 'derived_from', target);
      }
      written.push(duplicate.key);
      continue;
    }

    // Date.now() plus an index is not unique across CONCURRENT detached
    // workers: two Stop hooks finishing in the same millisecond produce the
    // same key, and putNode keeps the last write for an id -- so one session's
    // finding silently replaces another's. A random suffix makes that
    // collision vanishingly unlikely while keeping the timestamp readable.
    const provenance = provenanceFor(finding);
    const key = `${prefixFor(provenance)}-${Date.now().toString(36)}-${written.length}-${randomBytes(4).toString("hex")}`;

    const edges = resolved.map((target) => ({ edge: 'derived_from', to: target }));
    // `answers` closes the loop back to the task that produced the finding, so
    // provenance can be traversed rather than inferred: "which session
    // established this, and from what". Declared in EDGE_KINDS and written by
    // nothing until now.
    //
    // An explicit `taskId` is authoritative when a caller supplies one --
    // it OVERRIDES traversal rather than merely seeding it, so a caller that
    // knows better is never second-guessed by inference. Absent one, the task
    // is DERIVED from the graph itself, but ONLY when `authoritativeSessionId`
    // is present: `taskForAnchors` scopes to that exact session's task and
    // requires it to have touched EVERY one of this finding's anchors, not
    // merely one -- see that function's own comment for why the identity
    // itself must be trustworthy, not merely present.
    //
    // THE CONSEQUENCE, STATED PLAINLY: `wiki_write` never supplies
    // `authoritativeSessionId` (its `sessionId` is a model-typed MCP
    // argument nothing cross-checks), so its calls never traverse and
    // `answers` never fires on that path. `plugin/hooks/harvest-worker.mjs`
    // does supply it (Claude Code's own hook payload), so `answers` fires
    // there -- opt-in gated. `answers` therefore does NOT fire on a default
    // install today. Recovering default liveness needs an authoritative
    // identity on a default-install path, which is what Plan 2's
    // `hooks-core/derive.mjs` (running in the Stop hook, where the session id
    // is real) is for -- not a weaker check here.
    //
    // Either way, held to the same discipline as the anchors above: a target
    // that does not resolve to an existing task node produces no edge rather
    // than a dangling one.
    const answersTarget = taskId
      ? nodeId('task', taskId)
      : taskForAnchors(currentGraph, resolved, authoritativeSessionId);
    if (answersTarget && currentGraph.nodes.has(answersTarget)) {
      edges.push({ edge: 'answers', to: answersTarget });
    }

    // ONE APPEND for the finding and every anchor it resolved. This runs in a
    // detached worker, so "the process survives to finish the loop" is not a
    // safe assumption: a node written without its edges is an active finding
    // anchored to nothing, which can never be invalidated and is therefore
    // served as current forever -- the precise record the anchor discipline
    // above exists to refuse.
    const id = putNodeWithEdges(
      dir,
      {
        kind: 'finding',
        key,
        claim: finding.claim,
        confidence: finding.confidence,
        confidenceLabel: finding.confidenceLabel,
        type: finding.type,
        // WHEN this finding is relevant, not just what it is about. Anchors
        // answer "which file", which is the wrong question for a claim about
        // running something: the agent that needs "use npm test, not npx jest"
        // is executing a command, not reading the file the claim is anchored
        // to. Optional, so nothing that omits it changes behaviour.
        trigger: typeof finding.trigger === 'string' && finding.trigger
          ? finding.trigger
          : undefined,
        applicability: typeof finding.applicability === 'string'
          ? finding.applicability
          : undefined,
        evidence: typeof finding.evidence === 'string'
          ? finding.evidence
          : undefined,
        invalidators: Array.isArray(finding.invalidators)
          ? finding.invalidators
          : [],
        scope: finding.scope || 'project',
        origin: provenance,
        // THE EVIDENCE TRAVELS WITH THE CLAIM. Without it a human-origin
        // finding asserts its own provenance and nothing can check it.
        quote: typeof finding.quote === 'string' && finding.quote.trim()
          ? finding.quote
          : undefined,
        sessionId,
        // THE CHECKABLE HALF OF PROVENANCE. Citation-style (this `sessionId`,
        // the `answers` edge above) says WHERE a claim came from; it never
        // says whether that derivation still applies. `derivationFor` reaches
        // through `wiki_query`'s `node`/`get`/`search` operations only (those
        // return a finding's stored fields wholesale) -- never through
        // `render()`/`renderSessionIndex()` in inject.mjs or `wiki_read`'s
        // `toFinding()` projection, neither of which reads this field, so it
        // is not part of the automatic per-touch injection `fit()` prices.
        derivation: derivationFor(currentGraph, resolved, evidence, evidenceIncomplete, finding.anchors || []),
      },
      edges
    );
    // A failed write returns null. Reporting the key anyway would tell the
    // caller a claim was stored that no later session can retrieve.
    if (id) written.push(key);

    // AFTER the project write, and never instead of it. The project graph is the
    // record of what happened here; the shared tier is a copy for the lessons
    // that are not about here. Skipped when the two are the same directory,
    // which is the suite's usual arrangement.
    if (
      id
      && !isSharedDir(dir)
      // Cross-project publication is explicit. `writeHarvested` stores an
      // omitted scope as project-local above, so treating `undefined` as global
      // here contradicted the stored record and promoted fixture/evaluation
      // seeds into real user sessions. This was observed live as "learned in
      // scenario" advice while working in AiDotNet.
      && (finding.scope === 'organization' || finding.scope === 'global')
    ) {
      promoteToShared(finding, { projectRoot, sessionId, provenance, key });
    }
  }

  return written;
}
