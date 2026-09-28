/**
 * The code workloads must not read the working tree.
 *
 * WHY THIS IS A GATE AND NOT A COMMENT. These fixtures used to walk this
 * repository's own .ts/.mjs files at bench time. Commit 44b28702 added ~2 KB to
 * src/core/cache-engine.ts and, with no benchmark change at all,
 * codebase-exploration grew by 2,088 canonical characters and repeated-reads by
 * 6,264. payloadsDigest moves with those bytes, so every ratchet on those rows
 * was unholdable and no figure could be reproduced from another checkout. The
 * fix was a pinned snapshot; nothing stopped a later edit from undoing it.
 *
 * THE PROBE IS BEHAVIOURAL, not a grep for `readFileSync`. It plants a real
 * source file inside a walked directory and asserts the exported fixtures do
 * not move.
 *
 * AND IT CARRIES A POSITIVE CONTROL, because "the hash did not change" has two
 * causes: the fixtures are pinned, or the probe never perturbed anything the
 * walk would have read. The control runs the LIVE walker over the same
 * directory across the same edit and requires it to change. If the control does
 * not move, the probe is blind and this check fails rather than passing.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CORPUS_SPEC,
  REPO,
  fixtures,
  realSourcesLive,
  searchResultsLive,
  searchKey,
  sourcesKey,
} from './fixtures.mjs';

let failures = 0;
const ok = (name, detail = '') =>
  console.log(`ok  ${name}${detail ? ` -- ${detail}` : ''}`);
const bad = (name, detail) => {
  failures += 1;
  console.log(`FAIL ${name} -- ${detail}`);
};
const check = (cond, name, detail = '') =>
  cond ? ok(name, detail) : bad(name, detail || 'false');

const SNAPSHOT = JSON.parse(
  readFileSync(fileURLToPath(new URL('./corpus.snapshot.json', import.meta.url)), 'utf8')
);

const digest = () =>
  createHash('sha256')
    .update(JSON.stringify(fixtures().map((f) => [f.name, f.request])))
    .digest('hex');

// ---------------------------------------------------------------- spec <-> snapshot

const specKeys = CORPUS_SPEC.map((item) => {
  const root = join(REPO, ...item.root);
  return item.kind === 'sources'
    ? sourcesKey(root, item.budget)
    : searchKey(root, item.pattern, item.budget);
});

for (const key of specKeys) {
  const text = SNAPSHOT.entries[key];
  check(
    typeof text === 'string' && text.length > 0,
    `snapshot carries ${key}`,
    typeof text === 'string' ? `${text.length} chars` : 'absent'
  );
}

// A KEY NOBODY ASKS FOR IS A STALE SNAPSHOT, which is how a corpus quietly
// keeps measuring a directory the fixtures stopped using.
const orphans = Object.keys(SNAPSHOT.entries).filter(
  (k) => !specKeys.includes(k)
);
check(
  orphans.length === 0,
  'snapshot has no orphaned entries',
  orphans.length ? orphans.join(', ') : `${specKeys.length} entries, all claimed`
);

// ---------------------------------------------------------------- the probe

// Sorts first inside its directory, so the walkers reach it well inside their
// character budgets. `function ` is there so the search walker matches it too.
const PROBE_NAME = 'a-hermeticity-probe.generated.ts';
const PROBE_BODY = [
  '// Planted by hermetic.check.mjs. If this file is committed, that check',
  '// crashed between writing it and removing it -- delete it.',
  'export function hermeticityProbe(): string {',
  `  return '${'probe-'.repeat(200)}';`,
  '}',
  '',
].join('\n');

const WALKED = [
  join(REPO, 'src', 'core'),
  join(REPO, 'hooks-core'),
];

const planted = [];
try {
  const before = digest();
  const controlBefore = [
    realSourcesLive(WALKED[0], 12_000),
    searchResultsLive(WALKED[1], /function |=> \{/, 12_000),
  ];

  for (const dir of WALKED) {
    const at = join(dir, PROBE_NAME);
    if (existsSync(at)) {
      bad('probe site is clean', `${at} already exists; refusing to overwrite`);
      break;
    }
    writeFileSync(at, PROBE_BODY, 'utf8');
    planted.push(at);
  }

  if (planted.length === WALKED.length) {
    const controlAfter = [
      realSourcesLive(WALKED[0], 12_000),
      searchResultsLive(WALKED[1], /function |=> \{/, 12_000),
    ];

    // THE CONTROL COMES FIRST. If planting the file does not move the live
    // walkers, the probe is blind and a clean result below proves nothing.
    check(
      controlAfter[0] !== controlBefore[0],
      'control: the live source walk sees the planted file',
      `${controlBefore[0].length} -> ${controlAfter[0].length} chars`
    );
    check(
      controlAfter[1] !== controlBefore[1],
      'control: the live search walk sees the planted file',
      `${controlBefore[1].length} -> ${controlAfter[1].length} chars`
    );

    const after = digest();
    check(
      after === before,
      'fixtures do not move when a walked directory changes',
      after === before ? before.slice(0, 16) : `${before.slice(0, 16)} -> ${after.slice(0, 16)}`
    );
  }
} finally {
  for (const at of planted) {
    try {
      unlinkSync(at);
    } catch {
      console.log(`FAIL could not remove the planted probe at ${at}`);
      failures += 1;
    }
  }
}

console.log(
  failures === 0
    ? `hermetic corpus: ${specKeys.length} pinned walk(s), fixtures unmoved by the working tree`
    : `hermetic corpus: ${failures} problem(s)`
);
process.exit(failures === 0 ? 0 : 1);
