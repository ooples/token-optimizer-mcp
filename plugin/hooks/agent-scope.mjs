#!/usr/bin/env node
/**
 * PreToolUse for the optimizer's cached file tools: record which agent made the
 * call, so the server can scope its read cache to that agent (#488). See
 * lib/agent-scope.mjs.
 *
 * DELIBERATELY TINY. It runs before every smart_read, smart_config_read,
 * smart_write and smart_edit, so it imports one small module, never blocks the
 * call, and prints nothing: an empty reply lets the call through unchanged.
 */
import { readFileSync } from 'node:fs';
import { recordAgentForCall } from './lib/agent-scope.mjs';

try {
  const payload = JSON.parse(readFileSync(0, 'utf8') || '{}');
  recordAgentForCall(
    payload.tool_use_id ?? payload.toolUseId,
    payload.transcript_path ?? payload.transcriptPath
  );
} catch {
  // A malformed payload only means this call keeps the session scope.
}
