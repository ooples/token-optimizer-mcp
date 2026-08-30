#!/usr/bin/env node
/**
 * Claude Code PreToolUse adapter.
 *
 * Thin by design: it moves the payload into the shared decision engine and
 * turns the verdict into Claude Code's hook protocol. All judgement about what
 * is wasteful lives in lib/decide.mjs, shared with every other CLI client.
 *
 * Replaces the previous large-read-advisor.mjs, which covered only `Read`,
 * only above a size threshold, and only ever emitted a tip that models were
 * free to -- and routinely did -- ignore.
 */

import {
  readPayloadResult,
  loadState,
  saveState,
  alreadyDenied,
  allow,
  allowWithContext,
  allowWithRewrite,
  enforce,
  refusalsEnabled,
  mode,
  MODE_OFF,
} from './lib/policy.mjs';
import {
  decide,
  remember,
  normalizePayload,
  readCostBytes,
  touchedFiles,
  isContentDump,
  commandProjectRoot,
} from './lib/decide.mjs';
import { recordRead, fingerprint } from './lib/metrics.mjs';
import { maybeSurface } from './lib/surface.mjs';
import { recordingNudge, isSubstantive } from './lib/recording.mjs';
import {
  wikiDir,
  load,
  harvest,
  projectRootFor,
  contentHash,
} from './lib/wiki.mjs';
import {
  refusalPayload,
  substitutionFor,
  forTouch,
  forCommand,
  forSharedCommand,
  noteActClasses,
  forRepeatedAct,
} from './lib/inject.mjs';
import { indexFile } from './lib/staleness.mjs';
import { isArchived } from './lib/transcript.mjs';
import {
  boundedRewrite,
  boundNotice,
  isOutputHeavy,
} from './lib/rewrite.mjs';
import { isFsSafePath } from './lib/paths.mjs';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { episodeMeta, featuresForArm } from './lib/experiment.mjs';
import {
  HOOK_MCP_TOOLS,
  optimizerToolsForHook,
  rememberOptimizerTools,
} from './lib/capabilities.mjs';
import { evaluateUcrGuards } from './lib/ucr-guard.mjs';
import { beginHookInvocation } from './lib/observability.mjs';

// The Claude plugin bundles this hook and the MCP declaration as one install.
// Claude does not include its MCP tool inventory in hook payloads, so assert the
// bundled contract unless the host/user explicitly supplied an inventory (an
// empty value deliberately keeps the fail-open path available).
process.env.TOKEN_OPTIMIZER_MCP_CAPABILITIES ??= HOOK_MCP_TOOLS.join(',');

/**
 * Largest file the hook will read to index. Above this the touch is still
 * observed, but nothing is hashed or snapshotted -- a build log must never
 * become hook latency the user waits on.
 */
const HARVEST_MAX_BYTES =
  Number(process.env.TOKEN_OPTIMIZER_HARVEST_MAX_BYTES) || 4_000_000;
const invocation = beginHookInvocation('claude-code', 'pre-tool');

// Wrapped whole. Any defect in this hook must cost the user nothing: an
// exception here allows the call exactly as if the plugin were not installed.
try {
  if (mode() === MODE_OFF) allow();

  const input = await readPayloadResult();
  const raw = input.payload;
  if (!raw) {
    invocation.noteInput(input.status, input.bytes);
    allow();
  }

  // Normalized here rather than in the engine so this adapter behaves
  // identically to every other client's adapter on the same underlying call.
  const payload = normalizePayload(raw);
  invocation.bind(raw, payload, input.bytes);
  if (!payload.tool_name) allow();
  const features = featuresForArm();
  const episode = episodeMeta({ client: 'claude-code', raw });

  // The AGENT, not just the session. Subagents inherit the parent's session id,
  // so keying state on the session alone made one agent's reads silence another's
  // -- observed: an agent refused a file it had never opened because a sibling had
  // read it. `transcript_path` is per agent; absent, this falls back to session
  // scope, which is right for the main session's own calls.
  const agentScope = payload.transcript_path || null;
  const state = loadState(payload.session_id, agentScope);
  const toolEvidence = optimizerToolsForHook(raw, state);
  rememberOptimizerTools(state, toolEvidence);
  const ucrGuardVerdict = evaluateUcrGuards(
    payload,
    touchedFiles(payload).map((item) => item.path)
  );
  const verdict =
    ucrGuardVerdict ||
    (features.routing ? decide(payload, state, toolEvidence.names) : null);

  if (!verdict) {
    // Allowed calls are what BUILD the re-read index -- this is the only place
    // a first read gets recorded, so the second one can be recognised.
    remember(payload, state);
    saveState(payload.session_id, state, agentScope);

    // And what the read COST, which is the signal the holdout comparison
    // consumes. Without a producer here the measurement subtracts two zeroes.
    //
    // TOUCHED FILES ARE NOT ONLY `Read` FILES. A session spent in the shell --
    // `cat`, `grep -r`, a build log -- was previously invisible: no cost
    // recorded, no node in the graph, so a shell-heavy session measured as
    // though nothing happened. `touchedFiles` covers every tool that names a
    // file, including Bash operands.
    // Each entry carries the size measured while resolving it, so neither
    // loop below has to stat the same file again.
    const touched = touchedFiles(payload);

    // THE GRAPH IS PER PROJECT, so it is keyed on where the FILE lives, not on
    // where the client happens to be running. Keying it on the session's cwd
    // put findings about another repository into this one's graph -- or, when
    // the relative path did not resolve here, into no graph at all. A session
    // that touches two checkouts now writes to two graphs, correctly.
    const dirFor = (path) => wikiDir(projectRootFor(path, payload.cwd));

    const bytes = readCostBytes(payload);
    if (bytes) {
      recordRead(dirFor(payload.tool_input.file_path), {
        anchor: payload.tool_input.file_path,
        sessionId: payload.session_id,
        bytes,
        // So a later re-read of the same file can be told from a re-read of a
        // file that CHANGED in between. Re-reading what you just edited is
        // correct behaviour, not waste, and without this the two are
        // indistinguishable.
        fp: fingerprint(payload.tool_input.file_path),
      });
    } else if (isContentDump(payload.tool_input.command)) {
      // ONLY commands that actually print the file pay for its bytes. `Write`,
      // `Edit` and a bare `wc -l` name a file without reading it into context,
      // so charging them a full-file read inflated the very cost the holdout
      // comparison is built on -- and an overstated saving is the one number
      // this project must never produce.
      for (const { path, size } of touched) {
        if (size > 0) {
          recordRead(dirFor(path), {
            anchor: path,
            sessionId: payload.session_id,
            bytes: size,
            fp: fingerprint(path),
          });
        }
      }
    }

    // DELIVER WHAT THE GRAPH ALREADY KNOWS -- BEFORE ANYTHING BELOW OVERWRITES
    // IT. Nothing read from the graph on an allowed call at all once, so
    // `forTouch` -- the injection the design calls "where the win lands" -- was
    // imported by nothing but its own test. Measured over a full session on
    // three real projects: 4,053 captures, 2,063 reads, findings served twice.
    //
    // READ BEFORE WRITE, and the order is load-bearing rather than tidy. The
    // harvest loop below calls `indexFile`, which re-points every anchor at the
    // bytes now on disk. Running it first destroyed the only evidence staleness
    // has to work from: `forTouch` asked "did this file change since the claim
    // was recorded?" against a snapshot `indexFile` had already refreshed, so
    // the answer was always no and findings derived from the OLD content were
    // served as current.
    //
    // The files that reach this path are exactly the ones where that matters. A
    // write the hook observes is invalidated eagerly by `invalidateOnWrite`, so
    // what is left is the file changed where the session could not see it -- a
    // checkout, a rebase, a second agent, an editor outside the tool loop --
    // which is where a stale claim is both most likely and least likely to be
    // noticed. Serving it clean spends tokens to assert something false with
    // the graph's authority behind it, which is worse than serving nothing.
    //
    // Nothing is lost by the swap: `indexFile` exists so the NEXT touch can be
    // answered with structure, and the next touch still gets it.
    //
    // Both triggers fire here because findings answer two different questions.
    // An anchor says which FILE a claim is about; a trigger says WHEN it is
    // relevant. A claim about running something ("use npm test, not npx jest")
    // is anchored to a file nobody opens at the moment they run the command,
    // so file-touch injection alone could never deliver it -- and did not.
    let context = null;
    if (features.retrieval)
      try {
        // Once per session, per finding. Repeating advice on every call is how a
        // real signal becomes wallpaper, and an ignored injection still costs its
        // tokens every time.
        state.injected = state.injected || [];
        const alreadyInjected = new Set(state.injected);
        const before = alreadyInjected.size;
        const parts = [];
        let actsChanged = false;

        for (const { path } of touched) {
          const dir = dirFor(path);
          const note = forTouch(dir, load(dir), path, {
            sessionId: payload.session_id,
            alreadyInjected,
            episode,
          });
          if (note) parts.push(note);
        }

        const command = payload.tool_input?.command;
        if (command) {
          // The project the COMMAND runs in, not the one the session sits in. A
          // command that cds into a worktree or a second repository must consult
          // that project's graph; keying on payload.cwd meant findings recorded
          // there never fired -- no injection, no metrics row, no error.
          const root = commandProjectRoot(payload, payload.cwd);
          const dir = wikiDir(root);
          const note = forCommand(dir, load(dir), command, {
            sessionId: payload.session_id,
            alreadyInjected,
            episode,
          });
          if (note) parts.push(note);

          // AND WHAT OTHER PROJECTS ON THIS MACHINE ALREADY LEARNED.
          //
          // Every graph above is per project, which is right for a claim about a
          // file here and wrong for a claim about the tools. Measured across five
          // repositories in one session: structural capture worked in all of them,
          // and all 35 live lessons sat in ONE project's graph -- so "run npm test,
          // not npx jest" was available to be re-learned from scratch in every
          // other checkout.
          //
          // SECOND, always. The local findings are selected first and keep the full
          // budget; this adds at most two lessons within a smaller one, because a
          // lesson from another codebase is a weaker signal than one from this one
          // and must never crowd it out.
          const shared = forSharedCommand(dir, command, {
            sessionId: payload.session_id,
            alreadyInjected,
            projectRoot: root,
            episode,
          });
          if (shared) parts.push(shared);

          // AND WHETHER THIS SESSION KEEPS DOING THE SAME KIND OF THING.
          //
          // The once-per-session gate is what makes a delivered lesson go quiet
          // after its first appearance, and that is usually right. It is wrong when
          // the session develops a pattern: a lesson served at the start of a long
          // session was suppressed while the same class of mistake was made six more
          // times. Fires exactly once, when the third act of a class occurs.
          const crossed = noteActClasses(state, command);
          if (crossed !== null) actsChanged = true;
          const repeat = forRepeatedAct(dir, command, crossed, {
            sessionId: payload.session_id,
            projectRoot: root,
            episode,
          });
          if (repeat) parts.push(repeat);
        }

        // PERSIST WHEN THE TALLY MOVED TOO, not only when a finding was served.
        // Every tool call is its own process, so a counter that is incremented and
        // not written back is a counter that never passes one -- the reminder was
        // unreachable for exactly that reason.
        if (alreadyInjected.size !== before || actsChanged) {
          state.injected = [...alreadyInjected];
          saveState(payload.session_id, state, agentScope);
        }
        if (parts.length) context = parts.join('\n\n');
      } catch {
        // Delivery is an optimization. A defect here must never cost the user
        // their tool call, so a failure falls through to a plain allow.
      }

    // PRESSURE TO RECORD, once, after real work, on a project that has learned nothing.
    //
    // The read side of this product is enforced by REFUSAL -- this same hook denies Read, Grep and
    // Edit and names the tool to use instead. The write side had only a line of SessionStart prose,
    // and measured across a long working session on this repository it was followed zero times.
    // Advisory text loses to whatever the model is already doing.
    //
    // A refusal is the wrong instrument: wiki_write substitutes for no other tool, so there is
    // nothing to deny, and holding an edit hostage to bookkeeping would be worse than the problem.
    // Timing and specificity are what is available -- fired after the work exists, naming the
    // files, exactly once.
    try {
      if (
        features.harvest &&
        toolEvidence.names.has('wiki_write') &&
        isSubstantive(payload.tool_name)
      ) {
        state.edits = (state.edits || 0) + 1;
        const edited = payload.tool_input?.file_path;
        if (edited)
          state.editedFiles = [edited, ...(state.editedFiles || [])].slice(
            0,
            20
          );

        const nudge = recordingNudge(
          dirFor(edited || payload.cwd || process.cwd()),
          {
            state,
            edits: state.edits,
            files: state.editedFiles,
          }
        );
        if (nudge) {
          state.recordingNudged = true;
          context = context
            ? `${context}

${nudge}`
            : nudge;
        }
        saveState(payload.session_id, state, agentScope);
      }
    } catch {
      // Bookkeeping must never cost a tool call.
    }

    // THE FORECAST, AND THE ONLY PLACE IT CAN REACH A USER.
    //
    // This is the mid-session hook -- SessionStart is too early for a runway to mean anything and
    // PreCompact is too late to act on one -- so it is where a deadline can still change what
    // somebody does next. Everything about the cost is bounded inside maybeSurface: the throttle
    // is checked from persisted state BEFORE any file is opened, and worthSurfacing withholds the
    // panel unless the runway is actionable and has moved since the last one shown.
    try {
      const surfaced = maybeSurface(dirFor(payload.cwd || process.cwd()), {
        transcriptPath: payload.transcript_path,
        sessionId: payload.session_id,
        state,
      });
      if (surfaced.state !== state.forecast) {
        state.forecast = surfaced.state;
        saveState(payload.session_id, state, agentScope);
      }
      if (surfaced.text)
        context = context ? `${context}\n\n${surfaced.text}` : surfaced.text;
    } catch {
      // Same rule as above: a forecast is a courtesy and must never cost a tool call.
    }

    // THE MEMORY HALF. `harvest` records that this file was touched, at this
    // content hash, by this task -- and nothing had been calling it, anywhere.
    // The graph therefore accumulated no nodes and no task edges from ordinary
    // work, which left every downstream feature (injection, the zero-turn
    // refusal, consolidation, re-derivation detection) fed by a producer that
    // never ran. Structural only: it records what demonstrably happened and
    // makes no claims.
    if (features.capture)
      for (const { path, size } of touched) {
        try {
          // NEVER THE TRANSCRIPT ARCHIVE.
          //
          // Archived transcripts hold the user's own words verbatim. They are
          // stored locally, gitignored, and deliberately never harvested -- but
          // they are ordinary files on disk, so an agent that greps or opens one
          // would land here and have it hashed, snapshotted and indexed into the
          // graph, from which injection would later serve it back into context.
          //
          // `isArchived` is the test for exactly this, and it was enforcing
          // nothing: written, tested, and called from nowhere. A privacy
          // guarantee that no code path consults is not a guarantee.
          if (isArchived(path)) continue;

          // CAPPED BEFORE THE READ. indexFile bounds the stored SNAPSHOT, not the
          // read that produces it, so a single huge operand -- a multi-hundred-
          // megabyte build log is the ordinary case -- would be slurped
          // synchronously on the hook path with the user waiting. A file we
          // cannot afford to hash is simply not indexed; the touch is still
          // observed above.
          if (size > HARVEST_MAX_BYTES) continue;

          const dir = dirFor(path);
          // THE GUARD MUST BE HERE, not only in the helpers this read feeds.
          //
          // A path holding U+10FFFF ABORTS the process inside libuv rather than
          // throwing, so the surrounding try/catch -- and the whole-hook catch
          // that promises "a defect here costs the user nothing" -- does not hold
          // for it. `touchedFiles` filters such paths at intake, but this line is
          // a bare `readFileSync` and the two consumers below cannot cover it:
          // `contentHash(path, source)` skips its own check precisely because the
          // source was supplied, and `indexFile` checks only after this read has
          // already happened. Defence at the call site, since this is where the
          // syscall is.
          if (!isFsSafePath(path)) continue;

          // ONE read, not two. harvest() hashed the file and indexFile() then
          // read it again, so every allowed call paid double the I/O on the
          // hook's critical path. Reading once here and handing the text to both
          // keeps the graph identical and halves the cost.
          const source = readFileSync(path, 'utf8');
          harvest(dir, {
            filePath: path,
            sessionId: payload.session_id,
            action: payload.tool_name,
            hash: contentHash(path, source),
          });
          // Index on the way past, so the NEXT touch can be answered with
          // structure instead of the file. Bounded by the snapshot limit.
          indexFile(dir, path, source);
        } catch {
          /* never let bookkeeping break an allowed call */
        }
      }

    // BOUND AN OUTPUT-HEAVY COMMAND EVEN THOUGH NOTHING WAS GOING TO REFUSE IT.
    //
    // This is the debug-loop path, and until now it was unreachable: the bound
    // only ran where a refusal would otherwise have happened, and a test run is
    // never refused. `npm test`, `npx jest`, `pytest`, `cargo test` and
    // `npm run build` all reach here with no verdict, and all of them used to be
    // allowed unbounded.
    //
    // Measured on a real three-iteration loop against `jest tests/hooks`: the
    // client's own 30,000-character middle truncation delivers 20,852 tokens,
    // and an 8 KB head-and-tail bound delivers 3,697 -- 0.177 of it. Debug loops
    // are the family we measure worst on (1.248 against the leader's 0.611).
    //
    // NOT GATED ON REFUSALS, unlike the bound applied to a would-be refusal. A
    // bound is not a refusal: it costs no turn, changes no decision, and is
    // announced. Gating it on enforcement would mean the posture we intend to
    // ship -- assist, which keeps the graph and drops the refusals -- got none of
    // this, which is the opposite of the intent. Only `off`, the kill switch,
    // skips it, and that is handled far above.
    if (payload.tool_name === 'Bash' && isOutputHeavy(payload.tool_input?.command)) {
      const bounded = boundedRewrite(payload.tool_input.command, {
        compactor: compactorFor(payload.session_id, payload.tool_input.command),
      });
      if (bounded) {
        allowWithRewrite(
          { ...payload.tool_input, command: bounded.command },
          // The graph's own context still rides along; a bound must not cost a
          // finding that was about to be delivered.
          [context, boundNotice(bounded.maxBytes)].filter(Boolean).join('\n\n')
        );
      }
    }

    allowWithContext(context);
  }

  const repeat = verdict.persistent
    ? false
    : alreadyDenied(state, verdict.key);
  // BEFORE `remember`, which is about to mark this very call as seen. What
  // licenses a diff or an "unchanged" claim is what the session held on the way
  // IN, not what this call adds.
  const seenThisSession = Boolean(state.seen?.[payload.tool_input?.file_path]);
  remember(payload, state);
  saveState(payload.session_id, state, agentScope);

  // CARRY THE ANSWER IN THE REFUSAL where we can. A refusal that only redirects
  // costs the model a whole turn to get what we already have; one that carries
  // the diff or the annotated skeleton costs nothing and is often more useful
  // than the file would have been.
  let reason = verdict.reason;
  if (!repeat && payload.tool_name === 'Read' && payload.tool_input.file_path) {
    try {
      // Same per-project rule as the allowed path: a refusal must consult the
      // graph belonging to the FILE, or it answers from the wrong project.
      const dir = wikiDir(
        projectRootFor(payload.tool_input.file_path, payload.cwd)
      );
      // SNAPSHOTS ONLY HERE. This is the refusal path -- a re-read of a file
      // large enough to be denied -- and it is the one place the stored
      // contents actually pay, by answering with a diff instead of the file.
      // The injection path above deliberately loads without them: it runs
      // before EVERY tool call and was paying 232 ms to parse bytes it does
      // not read.
      const graph = load(dir, { snapshots: true });
      // Only THIS session's own read history can license "unchanged since you
      // read it" or a diff -- the graph is durable and per project, so its
      // snapshot may predate this session entirely.
      const carried = refusalPayload(graph, payload.tool_input.file_path, {
        seenThisSession,
      });
      if (carried) {
        reason = carried;
      } else {
        const source = readFileSync(payload.tool_input.file_path, 'utf8');
        // Index on this read, so the NEXT touch of the file is annotated even if
        // no semantic harvest has run against it yet.
        indexFile(dir, payload.tool_input.file_path, source);
        const substitution = substitutionFor(
          dir,
          load(dir),
          payload.tool_input.raw_file_path ?? payload.tool_input.file_path,
          source,
          // Carried through so a substitution can be told apart from a test
          // fixture later. Without it the balance sheet counted the suite's own
          // 366 fixture writes as product value.
          {
            sessionId: payload.session_id,
            client: episode.client,
            clientVersion: episode.clientVersion,
            model: episode.model,
            modelVersion: episode.modelVersion,
          }
        );
        if (substitution) reason = substitution;
      }
    } catch {
      // Any failure here falls back to the plain redirect, which always works.
    }
  }

/**
 * Where this command's previous output is kept, so the next run can be compacted
 * against it.
 *
 * Keyed by SESSION AND COMMAND. Two different commands must not be compared to
 * each other -- the lines they share would be elided from both for no reason --
 * and a new session starts clean, because the model in it has not been shown
 * anything yet.
 *
 * Under the OS temp directory, since this is a cache whose loss costs one
 * comparison and nothing else.
 */
function compactorFor(sessionId, command) {
  // OFF BY DEFAULT, ON THE EVIDENCE. On the representative debug loop -- four
  // iterations of a real failing suite -- compaction measured 0.216 of raw
  // against the plain bound's 0.214, which is to say it saved nothing and cost
  // the notice. The reason is visible in the capture: the runs differ in every
  // failure block, because jest prints a code frame of the line that changed,
  // so after eliding repeats there is still more fresh text than the head budget
  // holds. Compaction then changes WHICH content fills the budget, not how much.
  //
  // Where it does pay is a large stable preamble with a small delta: 8,000 bytes
  // -> 4,080, with the summary and the new failure both intact. That shape is
  // common in build and lint output and rare in this suite.
  //
  // So the code ships, tested, and the switch stays off: a node process in the
  // pipeline is a real cost and a new failure surface on a wrapper that has
  // already produced nine silent-meaning-change defects, and it is not worth
  // paying by default for a saving that could not be measured.
  if (!/^(1|true|on|yes)$/i.test(process.env.TOKEN_OPTIMIZER_COMPACT || '')) {
    return null;
  }

  try {
    const key = createHash('sha256')
      .update(`${sessionId}\u0000${command}`)
      .digest('hex')
      .slice(0, 32);

    return {
      node: process.execPath,
      helper: fileURLToPath(new URL('./lib/compact-stage.mjs', import.meta.url)),
      previous: join(tmpdir(), 'token-optimizer-compact', key),
    };
  } catch {
    // Any failure here simply means no compaction: `boundedRewrite` falls back
    // to the shell's own head and tail.
    return null;
  }
}

  // BOUND IT INSTEAD OF REFUSING IT.
  //
  // Reaching here means a verdict exists -- the no-verdict path allowed and
  // returned long ago -- so this is a call we were about to refuse. For Bash we
  // do not have to. A PreToolUse hook can rewrite the command through
  // `updatedInput` and the rewritten command runs, so the same limit can be
  // applied for ZERO extra turns instead of one.
  //
  // That distinction is the entire measured deficit: enforcement took turns
  // from 12.6 to 20.9 -- about one per refusal -- for a task-mean 1.633x
  // vanilla Claude Code, while the same build without refusals measured 0.928.
  // A refusal "saves" fewer tokens than the round trip it spends.
  //
  // Only where a refusal would actually have happened. In assist and off the
  // call was already going through untouched, and silently bounding output
  // there would be a new behaviour rather than a cheaper spelling of an
  // existing one.
  if (payload.tool_name === 'Bash' && refusalsEnabled()) {
    const bounded = boundedRewrite(payload.tool_input?.command, {
      compactor: compactorFor(payload.session_id, payload.tool_input?.command),
    });
    if (bounded) {
      allowWithRewrite(
        { ...payload.tool_input, command: bounded.command },
        // THE VERDICT'S OWN REASON RIDES ALONG. Bounding instead of refusing
        // must not cost the guidance the refusal would have carried -- the
        // reason names the optimizer tool that makes the NEXT call cheaper,
        // and dropping it leaves only a byte notice that teaches nothing.
        [reason, boundNotice(bounded.maxBytes)].filter(Boolean).join('\n\n')
      );
    }
  }

  // On a repeat this degrades to a note and lets the call through, which is
  // what bounds the blast radius when the MCP server is unavailable.
  enforce(reason, repeat);
} catch (error) {
  invocation.fail(error);
  allow();
}
