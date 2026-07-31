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

import { readPayload, loadState, saveState, alreadyDenied, allow, enforce, mode, MODE_OFF, fileSize }
  from './lib/policy.mjs';
import { decide, remember, normalizePayload, readCostBytes, touchedPaths, isContentDump } from './lib/decide.mjs';
import { recordRead } from './lib/metrics.mjs';
import { wikiDir, load, harvest, projectRootFor, contentHash } from './lib/wiki.mjs';
import { refusalPayload, substitutionFor } from './lib/inject.mjs';
import { indexFile } from './lib/staleness.mjs';
import { readFileSync } from 'node:fs';

/**
 * Largest file the hook will read to index. Above this the touch is still
 * observed, but nothing is hashed or snapshotted -- a build log must never
 * become hook latency the user waits on.
 */
const HARVEST_MAX_BYTES = Number(process.env.TOKEN_OPTIMIZER_HARVEST_MAX_BYTES) || 4_000_000;

// Wrapped whole. Any defect in this hook must cost the user nothing: an
// exception here allows the call exactly as if the plugin were not installed.
try {
  if (mode() === MODE_OFF) allow();

  const raw = await readPayload();
  if (!raw) allow();

  // Normalized here rather than in the engine so this adapter behaves
  // identically to every other client's adapter on the same underlying call.
  const payload = normalizePayload(raw);
  if (!payload.tool_name) allow();

  const state = loadState(payload.session_id);
  const verdict = decide(payload, state);

  if (!verdict) {
    // Allowed calls are what BUILD the re-read index -- this is the only place
    // a first read gets recorded, so the second one can be recognised.
    remember(payload, state);
    saveState(payload.session_id, state);

    // And what the read COST, which is the signal the holdout comparison
    // consumes. Without a producer here the measurement subtracts two zeroes.
    //
    // TOUCHED FILES ARE NOT ONLY `Read` FILES. A session spent in the shell --
    // `cat`, `grep -r`, a build log -- was previously invisible: no cost
    // recorded, no node in the graph, so a shell-heavy session measured as
    // though nothing happened. `touchedPaths` covers every tool that names a
    // file, including Bash operands.
    const touched = touchedPaths(payload);

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
      });
    } else if (isContentDump(payload.tool_input.command)) {
      // ONLY commands that actually print the file pay for its bytes. `Write`,
      // `Edit` and a bare `wc -l` name a file without reading it into context,
      // so charging them a full-file read inflated the very cost the holdout
      // comparison is built on -- and an overstated saving is the one number
      // this project must never produce.
      for (const path of touched) {
        const size = fileSize(path);
        if (size > 0) recordRead(dirFor(path), { anchor: path, sessionId: payload.session_id, bytes: size });
      }
    }

    // THE MEMORY HALF. `harvest` records that this file was touched, at this
    // content hash, by this task -- and nothing had been calling it, anywhere.
    // The graph therefore accumulated no nodes and no task edges from ordinary
    // work, which left every downstream feature (injection, the zero-turn
    // refusal, consolidation, re-derivation detection) fed by a producer that
    // never ran. Structural only: it records what demonstrably happened and
    // makes no claims.
    for (const path of touched) {
      try {
        // CAPPED BEFORE THE READ. indexFile bounds the stored SNAPSHOT, not the
        // read that produces it, so a single huge operand -- a multi-hundred-
        // megabyte build log is the ordinary case -- would be slurped
        // synchronously on the hook path with the user waiting. A file we
        // cannot afford to hash is simply not indexed; the touch is still
        // observed above.
        if (fileSize(path) > HARVEST_MAX_BYTES) continue;

        const dir = dirFor(path);
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
      } catch { /* never let bookkeeping break an allowed call */ }
    }

    allow();
  }

  const repeat = alreadyDenied(state, verdict.key);
  remember(payload, state);
  saveState(payload.session_id, state);

  // CARRY THE ANSWER IN THE REFUSAL where we can. A refusal that only redirects
  // costs the model a whole turn to get what we already have; one that carries
  // the diff or the annotated skeleton costs nothing and is often more useful
  // than the file would have been.
  let reason = verdict.reason;
  if (!repeat && payload.tool_name === 'Read' && payload.tool_input.file_path) {
    try {
      // Same per-project rule as the allowed path: a refusal must consult the
      // graph belonging to the FILE, or it answers from the wrong project.
      const dir = wikiDir(projectRootFor(payload.tool_input.file_path, payload.cwd));
      const graph = load(dir);
      const carried = refusalPayload(graph, payload.tool_input.file_path);
      if (carried) {
        reason = carried;
      } else {
        const source = readFileSync(payload.tool_input.file_path, 'utf8');
        // Index on this read, so the NEXT touch of the file is annotated even if
        // no semantic harvest has run against it yet.
        indexFile(dir, payload.tool_input.file_path, source);
        const substitution = substitutionFor(dir, load(dir), payload.tool_input.raw_file_path
          ?? payload.tool_input.file_path, source);
        if (substitution) reason = substitution;
      }
    } catch {
      // Any failure here falls back to the plain redirect, which always works.
    }
  }

  // On a repeat this degrades to a note and lets the call through, which is
  // what bounds the blast radius when the MCP server is unavailable.
  enforce(reason, repeat);
} catch {
  allow();
}
