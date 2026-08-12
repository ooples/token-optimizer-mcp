#!/usr/bin/env node
/** Export privacy-safe cross-client lifecycle diagnostics as one JSON report. */

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  hookHealthSummary,
  readHookEvents,
} from '../hooks-core/observability.mjs';

function valueAfter(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : null;
}

const hours = Math.min(24 * 30, Math.max(1, Number(valueAfter('--hours')) || 24));
const includeEvents = process.argv.includes('--include-events');
const limit = Math.min(1_000, Math.max(1, Number(valueAfter('--limit')) || 100));
const output = valueAfter('--output');
const sinceMs = hours * 60 * 60 * 1000;
const report = {
  generatedAt: new Date().toISOString(),
  privacy:
    'No prompts, commands, tool output, file contents, or raw working-directory paths are retained.',
  scope: {
    windowHours: hours,
    eventPayloadIncluded: includeEvents,
    ...(includeEvents ? { eventLimit: limit } : {}),
  },
  summary: hookHealthSummary({ sinceMs }),
};
if (includeEvents) report.events = readHookEvents({ sinceMs, limit });
const json = `${JSON.stringify(report, null, 2)}\n`;

if (output) {
  const destination = resolve(output);
  writeFileSync(destination, json, { encoding: 'utf8' });
  console.log(destination);
} else {
  process.stdout.write(json);
}
