#!/usr/bin/env node
// GENERATED FILE -- do not edit. Regenerate with `npm run sync:hooks`.
// Client entry point: names the client and event; all policy lives in the
// shared core so no client can drift its own thresholds or guidance.
import { run } from './lib/adapter.mjs';

// Fail open: a defect in the optimizer must never cost the user a tool call.
run('opencode', 'pre-tool').catch(() => process.exit(0));
