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

import { readPayload, loadState, saveState, alreadyDenied, allow, enforce, mode, MODE_OFF }
  from './lib/policy.mjs';
import { decide, remember, normalizePayload, readCostBytes } from './lib/decide.mjs';
import { recordRead } from './lib/metrics.mjs';
import { wikiDir, load } from './lib/wiki.mjs';
import { refusalPayload, substitutionFor } from './lib/inject.mjs';
import { indexFile } from './lib/staleness.mjs';
import { readFileSync } from 'node:fs';

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
    const bytes = readCostBytes(payload);
    if (bytes) {
      recordRead(wikiDir(payload.cwd), {
        anchor: payload.tool_input.file_path,
        sessionId: payload.session_id,
        bytes,
      });
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
      const dir = wikiDir(payload.cwd);
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
