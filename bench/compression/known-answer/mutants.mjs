/**
 * DOES THE KNOWN-ANSWER CHECK ACTUALLY CATCH A BROKEN SCORER?
 *
 * A check that passes tells you nothing about what it would refuse. Every green
 * run in this directory is evidence only if a deliberately broken instrument
 * turns it red, so this file breaks the instrument on purpose -- one defect at a
 * time, each one a defect this project has actually shipped -- and reports how
 * many the check caught.
 *
 * A SURVIVING MUTANT IS A HOLE IN THE CHECK, not a curiosity. It means that
 * exact defect could be reintroduced tomorrow and every test would stay green.
 *
 * The mutation is textual and the original bytes are held in memory, restored in
 * a finally block, and verified by digest afterwards -- because a restore that
 * silently did not happen would leave the working tree broken and the next run
 * measuring a file nobody meant to change.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..');
const H2H = join(REPO, 'bench', 'compression', 'head-to-head.mjs');
const RET = join(REPO, 'bench', 'compression', 'retention.mjs');
const CHECK = join(HERE, 'scorer.check.mjs');

const digest = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
/**
 * Each mutant names the defect it reintroduces, and the property that should
 * refuse it. `file` and the from/to pair must match exactly once, or the mutant
 * is reported as STALE rather than silently doing nothing -- a mutant that fails
 * to apply is the most dangerous kind, because it counts as caught.
 */
const MUTANTS = [
  {
    name: 'retention denominator is the raw scrape again',
    defect: 'the buckets were counted over the safe subset and printed beside a larger set',
    caughtBy: 'the buckets must close, and the denominator is enumerated by name',
    file: H2H,
    from: 'const { want, unsafeIds } = splitScorable(identifiers(text));',
    to: 'const { unsafeIds } = splitScorable(identifiers(text));\r\n  const want = identifiers(text);',
  },
  {
    name: 'a sinkless arm reports a measured zero',
    defect: 'inSpill read 0 on every workload because the branch could not fire',
    caughtBy: 'identity: the sinkless headline arm reports null',
    file: RET,
    from: 'inSpill: hasSink ? inSpill : null,',
    to: 'inSpill,',
  },
  {
    name: 'their token column is estimated, ours is tokenised',
    defect: 'their own counter is len(text) // 4; using it for one side only biases every ratio',
    caughtBy: 'mirror: the same bytes must score the same token saving',
    file: H2H,
    from: 'const theirAfter = tokens(t.bestText ?? text);',
    to: 'const theirAfter = Math.max(1, Math.floor((t.bestText ?? text).length / 4));',
  },
  {
    name: 'our denominator is taken after the envelope, theirs before',
    defect: 'the base = len(text) escape layer 1 found, in the other column',
    caughtBy: 'mirror: the same bytes must score the same size saving',
    file: H2H,
    from: 'ours: 1 - after / before,',
    to: 'ours: 1 - after / (before + 1),',
  },
  {
    name: 'a short identifier is scored by substring after all',
    defect: 'a three-character id matches by accident and lands in inOut as a free pass',
    caughtBy: 'identity: the denominator is the set that was actually scored',
    file: RET,
    from: 'const MIN_ID_LEN = 8;',
    to: 'const MIN_ID_LEN = 1;',
  },
  {
    name: 'identifiers found in the payload rather than the output',
    defect: 'scoring retention against the input always reports perfect retention',
    caughtBy: 'lossy: exactly DROP identifiers must have left the context',
    file: RET,
    from: 'if (output.includes(id)) inOut++;',
    to: 'inOut++;',
  },
];

const originals = new Map();
for (const f of [H2H, RET]) originals.set(f, readFileSync(f, 'utf8'));
const before = new Map([...originals.keys()].map((f) => [f, digest(f)]));

let caught = 0;
let survived = 0;
let stale = 0;

try {
  for (const m of MUTANTS) {
    const src = originals.get(m.file);
    const hits = src.split(m.from).length - 1;
    if (hits !== 1) {
      stale++;
      console.log(`  STALE   ${m.name}`);
      console.log(`          its anchor matches ${hits} times, so it mutated nothing`);
      continue;
    }
    writeFileSync(m.file, src.replace(m.from, m.to), 'utf8');
    const run = spawnSync('node', [CHECK], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    writeFileSync(m.file, src, 'utf8');
    if (run.status !== 0) {
      caught++;
      console.log(`  caught  ${m.name}`);
    } else {
      survived++;
      console.log(`  SURVIVED ${m.name}`);
      console.log(`           defect: ${m.defect}`);
      console.log(`           should have been refused by: ${m.caughtBy}`);
    }
  }
} finally {
  for (const [f, src] of originals) writeFileSync(f, src, 'utf8');
}

// A RESTORE THAT SILENTLY DID NOT HAPPEN would leave a mutated instrument in
// the tree and every later run would be measuring it.
for (const [f, d] of before) {
  if (digest(f) !== d) {
    console.log(`\nFAILED TO RESTORE ${f} -- check it out before running anything else`);
    process.exit(2);
  }
}

const total = caught + survived + stale;
console.log(`\nmutation score ${caught}/${total} caught` + (stale ? `, ${stale} stale` : ''));
if (survived || stale) {
  console.log(
    survived
      ? 'each surviving mutant is a defect that could be reintroduced with every test green'
      : 'a stale mutant counts as caught without testing anything; fix its anchor'
  );
}
process.exit(survived || stale ? 1 : 0);