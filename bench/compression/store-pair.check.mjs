/**
 * NO CLAIM MAY REST ON WHAT THEIR STORE HAPPENED TO HOLD.
 *
 * Their engine reads its redeemable content out of a durable store on disk, and
 * the arms that decide the comparable cost and retention columns move by up to
 * two orders of magnitude between a sweep that started from an empty one and a
 * sweep that started from a warm one. Those are two experiments, not one noisier
 * one, and we do not get to pick which of them a reader's machine is in. So the
 * set we enforce has to be the set that survives both, and this check is what
 * makes that a gate rather than a sentence in a comment.
 *
 * WHAT IT READS IS WHAT IS PUBLISHED. The four records under
 * `headroom/results/` are the pair: two recordings of the warm arm, which is the
 * published capture, and two of the empty arm. Both arms are needed twice over
 * because the gate decides a speed row only when it can see two recordings of
 * one capture, and speed is a fifth of the criteria.
 *
 * THE FAILURE IT IS LOOKING FOR is an ENFORCED pair that turns on the store, or
 * one the pair cannot decide on both arms. A criterion that is merely open may
 * turn on the store freely -- that is a measurement, and it is printed -- because
 * nothing is being claimed from it.
 */

import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sideFromRecord, storeEffect } from './store-effect.mjs';
import { readEntry } from './ratchet.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const results = join(here, 'headroom', 'results');
const at = (name) => join(results, name);

let failures = 0;
const ok = (name, detail = '') => console.log(`ok   ${name}${detail ? ` -- ${detail}` : ''}`);
const bad = (name, detail) => {
  failures++;
  console.log(`FAIL ${name} -- ${detail}`);
};

const ARMS = {
  warm: { record: 'head-to-head.json', replicate: 'head-to-head.replicate.json' },
  empty: {
    record: 'head-to-head.store-empty.json',
    replicate: 'head-to-head.store-empty.replicate.json',
  },
};

// THE FOUR FILES ARE CHECKED FOR BEFORE ANYTHING IS READ, because a missing arm
// is the one way this check could pass by measuring nothing: `storeEffect` over
// an absent side would throw, and a throw inside a roster reads like an
// infrastructure problem rather than the claim it actually is.
for (const [arm, files] of Object.entries(ARMS)) {
  for (const which of ['record', 'replicate']) {
    if (!existsSync(at(files[which]))) {
      bad(`the ${arm} arm's ${which} is published`, `${files[which]} is not there`);
    }
  }
}
if (failures > 0) {
  console.log(`\n${failures} FAILED`);
  process.exit(1);
}

const empty = sideFromRecord('empty-store', at(ARMS.empty.record), at(ARMS.empty.replicate));
const warm = sideFromRecord('warm-store', at(ARMS.warm.record), at(ARMS.warm.replicate));
console.log(`empty-store: capture ${empty.capture}, ${empty.fingerprint}`);
console.log(`warm-store:  capture ${warm.capture}, ${warm.fingerprint}`);

const pair = storeEffect({ empty, warm });
if (pair.refusal !== null) {
  bad('the published pair is one variable apart', pair.refusal);
  console.log(`\n${failures} FAILED`);
  process.exit(1);
}
ok('the published pair differs in the store and nothing else');

const ratchet = JSON.parse(readFileSync(at('must-win.ratchet.json'), 'utf8'));
const enforced = (name, criterion) => readEntry(ratchet.enforced?.[`${name}/${criterion}`]).enforced;

// THE ENFORCED SET IS NOT EMPTY, asserted rather than assumed. Every rule below
// is a filter over it, and a filter over nothing passes every rule while proving
// nothing at all -- which is exactly what a renamed ratchet key would produce.
const enforcedRows = pair.rows.filter((r) => enforced(r.name, r.criterion));
if (enforcedRows.length === 0) {
  bad('the pair covers the enforced set', 'no enforced pair appears in this capture at all');
} else {
  ok(`${enforcedRows.length} enforced pair(s) are covered by both arms`);
}

for (const row of enforcedRows) {
  const where = `${row.name}/${row.criterion}`;
  if (row.pairing === 'needs-empty-store' || row.pairing === 'needs-warm-store') {
    bad(
      `${where} is enforced and holds under both stores`,
      `it passes only from a ${row.pairing === 'needs-empty-store' ? 'empty' : 'warm'} store: ` +
        `empty says ${row.onEmpty.detail}; warm says ${row.onWarm.detail}`
    );
  } else if (row.pairing === 'undecided') {
    bad(
      `${where} is enforced and decided on both arms`,
      `the gate returned no verdict on ${row.onEmpty.pass === null ? 'the empty' : 'the warm'} arm, ` +
        'so nothing says the claim survives that store state'
    );
  }
}
if (enforcedRows.every((r) => r.pairing === 'agree-pass' || r.pairing === 'agree-fail')) {
  ok('every enforced pair reaches the same verdict from either store');
}

// A CRITERION COVERED BY ONE ARM ONLY is not a store dependency, it is a hole in
// the pair, and it would otherwise be invisible: `storeEffect` drops it from the
// rows rather than guessing, so the count above would simply be smaller.
for (const gap of pair.summary.missing) {
  const [where] = gap.split(' is only in ');
  const [name, criterion] = where.split('/');
  if (criterion !== undefined && enforced(name, criterion)) {
    bad(`${where} is enforced and measured on both arms`, gap);
  }
}

const s = pair.summary;
console.log(
  `\n${s.criteria} criteria paired: ${s.agreePass} hold from either store, ${s.agreeFail} fail ` +
    `from either, ${s.storeDependent.length} turn on the store, ${s.undecided.length} undecided.`
);
// PRINTED WHETHER OR NOT IT FAILS. An open criterion that turns on their store is
// the measurement this pair exists to produce; suppressing it because nothing is
// claimed from it yet would throw away the finding.
if (s.storeDependent.length) console.log(`\nTURNS ON THEIR STORE STATE:\n  ${s.storeDependent.join('\n  ')}`);
if (s.undecided.length) console.log(`\nUNDECIDED ON ONE SIDE:\n  ${s.undecided.join('\n  ')}`);
if (s.missing.length) console.log(`\nCOVERED BY ONE ARM ONLY:\n  ${s.missing.join('\n  ')}`);

console.log(failures === 0 ? '\nall checks pass' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
