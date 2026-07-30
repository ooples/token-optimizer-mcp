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
import { decide, remember, normalizePayload } from './lib/decide.mjs';

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
    allow();
  }

  const repeat = alreadyDenied(state, verdict.key);
  remember(payload, state);
  saveState(payload.session_id, state);

  // On a repeat this degrades to a note and lets the call through, which is
  // what bounds the blast radius when the MCP server is unavailable.
  enforce(verdict.reason, repeat);
} catch {
  allow();
}
