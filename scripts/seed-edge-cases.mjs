#!/usr/bin/env node
/**
 * Seeds a deliberately hostile graph for live testing.
 *
 * A happy-path demo proves the screenshot. This seeds the things that actually
 * break dashboards: injection payloads in every field that reaches the DOM,
 * unicode and RTL text, claims far longer than any layout expects, paths with
 * quotes and backslashes, contradictions, retired and superseded findings,
 * orphans, zero-confidence entries, and a file large enough to exceed the
 * snapshot limit.
 *
 * Usage: node scripts/seed-edge-cases.mjs [targetDir]
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { putNode, putEdge, nodeId, wikiDir } from '../hooks-core/wiki.mjs';
import { indexFile } from '../hooks-core/staleness.mjs';
import { record, recordRead } from '../hooks-core/metrics.mjs';
import { retire, correct, create } from '../hooks-core/curate.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = process.argv[2] || wikiDir(ROOT);
const SRC = join(ROOT, 'edge-src');

mkdirSync(SRC, { recursive: true });

/** Files whose NAMES are themselves hostile. */
const FILES = {
  normal: 'auth.ts',
  // Windows forbids " < > in filenames, so an apostrophe is the strongest
  // attribute-breaking character actually reachable through a real path. The
  // markup payloads live in claims and symbol names instead, which is where a
  // harvested value can genuinely contain anything.
  quoted: "it's-quoted.ts",
  unicode: 'æøå-日本語-файл.ts',
  spaced: 'a file with spaces.ts',
  markup: 'script-tag.ts',
  huge: 'huge-bundle.ts',
};

writeFileSync(join(SRC, FILES.normal),
  'export function verify(token) {\n  return token.exp > Date.now();\n}\n\n' +
  'export class Session {\n  refresh() { return true; }\n}\n\n' +
  'class Other {\n  refresh() { return false; }\n}\n');
writeFileSync(join(SRC, FILES.quoted), 'export const q = 1;\n');
writeFileSync(join(SRC, FILES.unicode), 'export const u = "日本語";\n');
writeFileSync(join(SRC, FILES.spaced), 'export const s = 1;\n');
writeFileSync(join(SRC, FILES.markup), 'export const m = 1;\n');
// Over the 256 KB snapshot limit, so the file node stores a hash but no snapshot.
writeFileSync(join(SRC, FILES.huge), 'export const big = "' + 'x'.repeat(300_000) + '";\n');

for (const name of Object.values(FILES)) indexFile(DIR, join(SRC, name));

const XSS = '"><img src=x onerror="document.title=\'PWNED\'">';

/** [key, claim, confidence, type, file] */
const FINDINGS = [
  ['f-normal', 'verify() compares exp against the local clock, so clock skew causes spurious 401s', 0.92, 'finding', FILES.normal],
  ['f-xss-claim', `a claim containing markup: ${XSS} and a <script>alert(1)</script> tag`, 0.8, 'finding', FILES.normal],
  ['f-xss-path', 'a finding anchored to a file whose NAME contains a quote', 0.75, 'finding', FILES.quoted],
  ['f-unicode', 'unicode claim: 日本語のテキスト, العربية RTL, emoji 🔥, combining é', 0.7, 'map', FILES.unicode],
  ['f-long', 'a very long claim: ' + 'lorem ipsum dolor sit amet '.repeat(120), 0.65, 'finding', FILES.spaced],
  ['f-newlines', 'a claim\nwith\nembedded\nnewlines\tand\ttabs', 0.6, 'finding', FILES.markup],
  ['f-zero', 'a zero-confidence claim that should sort last and flag in audit', 0.01, 'finding', FILES.normal],
  ['f-huge-anchor', 'anchored to a file too large to snapshot, so evidence cannot be reconstructed', 0.7, 'finding', FILES.huge],
  ['f-contra-a', 'the cache is write-back', 0.55, 'finding', FILES.normal],
  ['f-contra-b', 'the cache is write-through', 0.55, 'finding', FILES.normal],
  ['f-failure', 'tried a shared retry budget across hosts; it deadlocked under burst load', 0.88, 'failure', FILES.normal],
  ['f-decision', 'chose per-host retry budgets; rejected the global one because of the deadlock', 0.9, 'decision', FILES.normal],
  ['f-retired', 'this claim was withdrawn by a human and must never be served', 0.9, 'finding', FILES.normal],
  ['f-corrected', 'this claim was superseded by a correction', 0.8, 'finding', FILES.normal],
];

const ids = {};
for (const [key, claim, confidence, type, file] of FINDINGS) {
  ids[key] = putNode(DIR, { kind: 'finding', key, claim, confidence, type });
  putEdge(DIR, ids[key], 'derived_from', nodeId('file', join(SRC, file)));
}

// A contradiction the audit tab must surface.
putEdge(DIR, ids['f-contra-a'], 'contradicts', ids['f-contra-b']);

// An ORPHAN: an edge pointing at a node that was never created. It looks
// anchored by edge presence but can never be checked.
const orphan = putNode(DIR, { kind: 'finding', key: 'f-orphan', claim: 'anchored to a node that does not exist', confidence: 0.5 });
putEdge(DIR, orphan, 'derived_from', nodeId('file', '/never/created/anywhere.ts'));

// A finding with NO claim at all -- malformed, must not crash any view.
putNode(DIR, { kind: 'finding', key: 'f-noclaim', confidence: 0.4 });

// Curation states.
retire(DIR, 'f-retired');
correct(DIR, 'f-corrected', 'the corrected claim, asserted by a human');
create(DIR, { claim: 'a hand-written finding with a real anchor', anchors: [join(SRC, FILES.normal)] });

// Make one finding STALE by editing its anchor after indexing.
writeFileSync(join(SRC, FILES.normal),
  'export function verify(token) {\n  return token.exp > (Date.now() - SKEW);\n}\n\n' +
  'export class Session {\n  refresh() { return true; }\n}\n\n' +
  'class Other {\n  refresh() { return false; }\n}\n');

// Metrics with enough volume for the balance to report.
for (let i = 0; i < 30; i++) {
  record(DIR, { kind: 'inject', anchor: join(SRC, FILES.normal), sessionId: 'live', holdout: false, tokens: 140 });
  recordRead(DIR, { anchor: join(SRC, FILES.normal), sessionId: 'live', bytes: 2_000 });
}
for (let i = 0; i < 9; i++) {
  record(DIR, { kind: 'inject', anchor: join(SRC, `c${i}.ts`), sessionId: 'live', holdout: true, tokens: 0 });
  recordRead(DIR, { anchor: join(SRC, `c${i}.ts`), sessionId: 'live', bytes: 48_000 });
}
record(DIR, { kind: 'harvest', tokens: 900 });

console.log(`seeded hostile graph at ${DIR}`);
console.log(`source files at ${SRC}`);
