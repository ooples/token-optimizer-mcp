// GENERATED FILE -- do not edit.
// Source of truth: hooks-core/harvest-worker.mjs. Regenerate with `npm run sync:hooks`.
#!/usr/bin/env node
/**
 * The out-of-band half of the semantic harvest.
 *
 * Spawned detached by the Stop adapter so the session that did the work never
 * pays for the model call that summarises it. Everything here is best-effort:
 * a harvest that fails must be indistinguishable from a session with nothing
 * to learn, because the alternative -- a hook that can break a turn -- is worse
 * than no findings at all.
 *
 * The cost of the extraction is recorded either way. Without it the metrics
 * report a benefit with no matching expense, and `netTokens` would flatter the
 * feature by exactly the amount it spends.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  harvestEnabled,
  buildDigest,
  buildFullDelta,
  extract,
  validate,
  estimateTokens,
} from './harvest.mjs';
import { writeHarvested } from './harvest-write.mjs';
import { record } from './metrics.mjs';
import { wikiDir, projectRootFor, load } from './wiki.mjs';
import { readArchive } from './transcript.mjs';
import { buildFeedbackDigest, validateLessons, LESSON_PROMPT } from './lessons.mjs';
import { ORIGIN_HARVESTED } from './curate.mjs';
import { selectForConsolidation } from './consolidate.mjs';

/**
 * The token budget one session's harvest may add to the graph.
 *
 * #204 lists graph bloat as a named risk -- "the session-start index grows with
 * the graph; ranking and eviction are required, not optional" -- and until now
 * nothing bounded what a single harvest could store. 4,000 tokens is the
 * selector's own default and roughly twenty-five findings at the size the
 * extractor produces, which is far above any observed session's real yield; it
 * is a ceiling against a pathological extraction, not a routine constraint.
 */
const CONSOLIDATION_BUDGET = 4000;

/**
 * The files the digest says were touched.
 *
 * `buildDigest` emits them under a `## Files touched` heading and returns a
 * string, so this reads back the list it just wrote rather than walking the
 * transcript a second time. Returns null when the section is absent, which
 * `validate` treats as "no restriction" rather than "no files".
 */
function filesIn(digest) {
  const start = digest.indexOf('## Files touched');
  if (start === -1) return null;

  const rest = digest.slice(start + '## Files touched'.length);
  const end = rest.indexOf('\n##');
  const block = (end === -1 ? rest : rest.slice(0, end)).split('\n');

  const files = new Set();
  for (const line of block) {
    const value = line.trim();
    if (value) files.add(value);
  }
  return files.size ? files : null;
}

async function main() {
  const [transcript, sessionId, cwd] = process.argv.slice(2);
  if (!transcript || !existsSync(transcript) || !harvestEnabled()) return;

  // THE GRAPH AND THE CONTAINMENT BOUNDARY BOTH COME FROM THE REPOSITORY ROOT,
  // NOT THE SESSION'S CWD. `wikiDir` only joins the path it is handed, so a
  // session started in a subdirectory selected `<subdir>/.token-optimizer/wiki`
  // -- a second graph, invisible to every other hook, which all resolve the root
  // first. It also made the subdirectory the containment root for the write, so
  // a finding anchored anywhere else in the same repository was refused for
  // sitting "outside" the project.
  //
  // `__session__` is a synthetic leaf so the walk starts at `cwd` itself rather
  // than its parent; `projectRootFor` takes a FILE path. This is the same idiom
  // the adapter, the session-start hook and the Stop adapter already use.
  //
  // A cwd with no VCS ancestor resolves to the machine-level unrooted bucket,
  // which `resolveAnchor` expects and handles: it swaps in home as the
  // containment root for that case, so passing the resolved root here is what
  // lets unrooted anchors work at all.
  const sessionCwd = cwd || process.cwd();
  const projectRoot = projectRootFor(join(sessionCwd, '__session__'), sessionCwd);
  const dir = wikiDir(projectRoot);

  // Default sends a structured digest with no file contents. The full delta is
  // opt-in because the default has to be defensible without reading the docs.
  const full = process.env.TOKEN_OPTIMIZER_HARVEST_FULL === 'true';
  const digest = full ? buildFullDelta(transcript) : buildDigest(transcript);
  if (!digest) return;

  const raw = await extract(digest);

  // Anchors are held to the files this session actually touched, so a model
  // that invents a plausible path cannot anchor a finding to it. The digest
  // lists them under a heading it writes itself; the full delta is raw
  // transcript and carries no such list, so it gets no restriction.
  const validated = validate(raw, { knownFiles: full ? null : filesIn(digest) });

  // BUDGETED SELECTION, not everything the model extracted.
  //
  // `selectForConsolidation` exists for exactly this and had no caller
  // anywhere, so every harvested candidate was stored regardless of what it
  // cost to derive, how hard it is to reproduce, or whether the graph can ever
  // retrieve it -- which is the graph-bloat risk #204 lists as needing
  // "ranking and eviction ... not optional". It keeps failures and decisions on
  // a floor before ranking, encoding the design's judgement that dead ends are
  // the highest-value kind: they exist nowhere in the source tree, so nothing
  // else can ever recover them.
  //
  // The selection is RECORDED, not silent. A cap that drops work without
  // saying so reads as "there was nothing more to find", which is the same
  // dishonesty as a truncated report with no remainder line.
  const graph = load(dir);
  const selection = selectForConsolidation(graph, validated, { budget: CONSOLIDATION_BUDGET });
  const findings = selection.kept;
  if (selection.dropped > 0) {
    record(dir, {
      kind: 'harvest',
      action: 'consolidation',
      candidates: validated.length,
      kept: findings.length,
      dropped: selection.dropped,
      tokens: selection.tokens,
      budget: CONSOLIDATION_BUDGET,
    });
  }

  const written = writeHarvested(dir, findings, {
    sessionId: sessionId || null,
    projectRoot,
    // Task nodes are keyed by session id (structural capture creates one on
    // the first touched file, `harvest()` in lib/wiki.mjs) so this is the
    // shape `writeHarvested` needs to point the `answers` edge back at the
    // task this harvest belongs to. A session that never touched a file
    // through PreToolUse/PostToolUse has no such node yet; `writeHarvested`
    // resolves that case to no edge rather than a dangling one.
    taskId: sessionId || null,
    // AUTHORITATIVE, not just present: this `sessionId` came from Claude
    // Code's own Stop-hook payload (see stop-harvest.mjs), not a model-typed
    // tool argument, so it is safe to use for the traversal fallback if the
    // explicit `taskId` above does not resolve.
    authoritativeSessionId: sessionId || null,
  });

  record(dir, {
    kind: 'harvest',
    sessionId: sessionId || null,
    tokens: estimateTokens(digest),
    findings: written.length,
    at: Date.now(),
  });

  // THE FEEDBACK LOOP. A separate extraction with a separate prompt, because
  // the two are looking for different things: the harvest above wants what was
  // LEARNED about the code, this wants where the user said the agent was WRONG.
  // Asked for both at once a model returns a summary and the corrections get
  // lost in it -- and corrections are the only turns carrying information the
  // code itself could never supply.
  try {
    const turns = readArchive(dir, sessionId || 'unknown');
    const feedback = buildFeedbackDigest(turns);
    if (feedback) {
      const rawLessons = await extract(feedback, { prompt: LESSON_PROMPT });
      // The same restriction the finding path above applies, for the same reason: a model that
      // invents a plausible path must not be able to anchor a lesson to it. `turns` is the
      // archived transcript for this session, so its rendered digest is the honest file list.
      const { lessons } = validateLessons(rawLessons, turns, {
        knownFiles: filesIn(feedback),
      });

      // Anchors are optional on a lesson -- "always run npm test" is about no
      // file -- so each is anchored to the project root when it names nothing,
      // which keeps the store's rule that an unanchored finding is refused.
      //
      // The RESOLVED root, matching the containment root this write is checked
      // against. The session's cwd would be refused outright once that root is
      // the unrooted bucket, because `resolveAnchor` then narrows containment to
      // home and a VCS-less working directory need not sit under it.
      const anchored = lessons.map((l) => ({
        ...l,
        anchors: l.anchors.length ? l.anchors : [projectRoot],
      }));

      // The write itself is the durable record: writeHarvested anchors each
      // lesson into the graph, which is what lessons.mjs's real consumers
      // query. A metrics event of kind 'lessons' used to sit here as well,
      // but nothing ever read it -- not netTokens (only 'harvest' feeds
      // harvestTokens), not report()/buildReport() (no kind filter matches
      // 'lessons'), and no audit render exists to show it to a human. That is
      // the inverse of the `query` defect and the same shape as
      // `tokensFullFile` before it: a produced-and-never-consumed event,
      // which is a cost with no benefit. Deleted rather than wired, per the
      // reachability allowlist's own rule -- write it again the day
      // something needs to read it.
      writeHarvested(dir, anchored, {
        sessionId: sessionId || null,
        origin: ORIGIN_HARVESTED,
        projectRoot,
        taskId: sessionId || null,
        // Same hook-payload identity as above, same reason.
        authoritativeSessionId: sessionId || null,
      });
    }
  } catch {
    // A failed feedback pass must be indistinguishable from a session with
    // nothing to correct.
  }
}

main()
  .catch(() => {})
  .finally(() => {
    // NEVER process.exit() SYNCHRONOUSLY HERE.
    //
    // It crashed this worker on Windows every single time the feedback pass
    // ran -- libuv asserts `!(handle->flags & UV_HANDLE_CLOSING)` when the
    // process exits while the sockets from the model call are still closing,
    // giving exit code 0xC0000409. Reproduced 5 runs out of 5, and silently,
    // because this worker is spawned detached and nothing reads its status.
    // Deferring by one tick is NOT enough; the handles are still closing then.
    //
    // So the normal path just lets the loop drain, which it does promptly.
    //
    // THE RECORDED CODE IS PRESERVED, not overwritten with 0. Assigning 0
    // unconditionally would turn a harvest that had already recorded a failure
    // into one that reports success -- and this worker is detached, so that
    // status is the only signal a supervisor could ever act on.
    const code = process.exitCode ?? 0;
    process.exitCode = code;

    // The watchdog keeps the original guarantee: a detached worker must never
    // linger holding a keep-alive socket open. It is UNREF'D, so it cannot
    // itself keep the process alive -- it only fires if something else already
    // has, which is exactly the case worth killing.
    const watchdog = setTimeout(() => process.exit(code), 5000);
    watchdog.unref();
  });
