import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { hashes } from './confirmation-freeze.mjs';
import { continuationPrefix } from './confirmation-continuation.mjs';

const root = await mkdtemp(join(tmpdir(), 'confirmation-resume-check-'));
const source = join(root, 'source'),
  study = join(root, 'study');
await mkdir(source);
await mkdir(join(study, 'cases', 'one'), { recursive: true });
const plan = {
  pairs: 2,
  schedule: [{ id: 'one', arms: ['proxy', 'headroom'] }, { id: 'two' }],
};
const save = (file, value) => writeFile(file, JSON.stringify(value));
await save(join(source, 'plan.json'), plan);
await save(join(study, 'plan.json'), plan);
const journal = {
  raw: join(root, 'raw'),
  status: 'incomplete',
  error: 'RangeError: Array buffer allocation failed',
  pairs: [{ id: 'one', status: 'complete', runnerExit: 0 }],
};
await mkdir(join(journal.raw, 'one'), { recursive: true });
await save(join(source, 'execution.json'), journal);
// A failed task is retained; eligibility must never select only successful pairs.
await save(join(study, 'cases/one/validation.json'), [
  { arm: 'proxy', verdict: 'FAIL' },
  { arm: 'headroom', verdict: 'PASS' },
]);
const product = join(root, 'product.js');
await writeFile(product, 'original');
await save(join(source, 'freeze.json'), { sha256: await hashes([product]) });
const registration = {
  source,
  completedPairs: 1,
  evidenceSha256: await hashes([join(source, 'execution.json')]),
};
await save(join(study, 'continuation.json'), registration);
const freeze = {
  root,
  sha256: { [join(study, 'continuation.json')]: 'frozen' },
};
assert.equal((await continuationPrefix(study, plan, freeze)).pairs.length, 1);
await assert.rejects(
  continuationPrefix(study, plan, { root, sha256: {} }),
  /not frozen/
);
await writeFile(product, 'changed');
await assert.rejects(
  continuationPrefix(study, plan, freeze),
  /changed a product/
);
await writeFile(product, 'original');
journal.pairs[0].status = 'running';
await save(join(source, 'execution.json'), journal);
registration.evidenceSha256 = await hashes([join(source, 'execution.json')]);
await save(join(study, 'continuation.json'), registration);
await assert.rejects(continuationPrefix(study, plan, freeze), /partial pair/);
journal.pairs[0].status = 'complete';
await save(join(source, 'execution.json'), journal);
registration.evidenceSha256 = await hashes([join(source, 'execution.json')]);
await save(join(study, 'continuation.json'), registration);
await save(join(study, 'plan.json'), { ...plan, pairs: 3 });
await assert.rejects(
  continuationPrefix(study, plan, freeze),
  /changed the schedule/
);
await save(join(study, 'plan.json'), plan);
await save(join(study, 'cases/one/validation.json'), [
  { arm: 'proxy', verdict: 'INVALID_READ' },
  { arm: 'headroom', verdict: 'INVALID_READ' },
]);
await assert.rejects(
  continuationPrefix(study, plan, freeze),
  /measurement-exposure/
);
console.log(
  'Continuation guards passed: complete prefix, failures retained, frozen registration, unchanged product/schedule, no partial-pair reuse, no exposure-failure resume.'
);
