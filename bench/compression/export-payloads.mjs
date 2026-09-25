/**
 * Export our twelve fixtures in the shape their pipeline consumes natively.
 *
 * WHY THIS EXISTS. The published head-to-head carries four rows because four
 * workloads had a comparator; the harness runs twelve. The other eight were
 * never measured against anything, and a tally over four fixtures has been read
 * as a statement about the product. Their compressors take arbitrary input, so
 * the missing comparator was never a limitation of theirs -- only of ours.
 *
 * NATIVE, NOT SERIALISED. Each fixture is written as its `request.messages`
 * list, because `is_messages` in run-theirs.py routes a list of role-bearing
 * dicts to `pipeline.apply`, their production path. Flattening to a string
 * first would send their conversation workloads down the blob path, score the
 * result as their capability, and be wrong in the direction that flatters us.
 *
 * THE SYSTEM PROMPT IS EXCLUDED, from both sides. It is the same few hundred
 * bytes on every fixture, it is not what either compressor is being asked to
 * reduce, and including it on one side only would shift every ratio. The bytes
 * both arms are scored on are the ones run-theirs.py dumps to payloads.json.
 *
 * Usage:
 *   node bench/compression/export-payloads.mjs <out.json>
 *   python bench/compression/headroom/run-theirs.py - <dir> --extra <out.json>
 */

import { writeFileSync } from 'node:fs';
import { fixtures } from './fixtures.mjs';

const out = process.argv[2];
if (!out) {
  console.error('usage: node bench/compression/export-payloads.mjs <out.json>');
  process.exit(2);
}

const payloads = {};
for (const fixture of fixtures()) {
  const messages = fixture.request?.messages;
  if (!Array.isArray(messages) || messages.length === 0)
    throw new Error(`fixture ${fixture.name} has no messages to export`);
  // Their `is_messages` requires a role on every entry; a fixture that failed
  // this would be silently routed to the blob path and scored as if their
  // pipeline had been given its native input.
  const roleless = messages.filter((m) => typeof m?.role !== 'string');
  if (roleless.length)
    throw new Error(
      `fixture ${fixture.name}: ${roleless.length} message(s) without a role`
    );
  if (payloads[fixture.name])
    throw new Error(`duplicate fixture name ${fixture.name}`);
  payloads[fixture.name] = messages;
}

writeFileSync(out, JSON.stringify(payloads), 'utf8');
console.log(
  `exported ${Object.keys(payloads).length} fixtures -> ${out}\n  ` +
    Object.entries(payloads)
      .map(([name, m]) => `${name} (${m.length} msgs)`)
      .join('\n  ')
);