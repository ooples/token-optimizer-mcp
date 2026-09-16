import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { hashes } from './confirmation-freeze.mjs';

const source = resolve(process.argv[2]);
const destination = resolve(process.argv[3]);
const journal = JSON.parse(
  await readFile(join(source, 'execution.json'), 'utf8')
);
if (
  journal.status !== 'incomplete' ||
  journal.error !== 'RangeError: Array buffer allocation failed' ||
  journal.pairs.some(
    (pair) => pair.status !== 'complete' || pair.runnerExit !== 0
  )
)
  throw Error(
    'Only complete prefixes interrupted by hashing can be registered'
  );
await mkdir(destination);
const evidence = [
  'execution.json',
  'freeze.json',
  'freeze-at-stop.json',
  'plan.json',
  'PROTOCOL.md',
].map((name) => join(source, name));
for (const name of ['plan.json', 'PROTOCOL.md'])
  await copyFile(join(source, name), join(destination, name));
for (const pair of journal.pairs) {
  await mkdir(join(destination, 'cases', pair.id), { recursive: true });
  for (const name of [
    'manifest.json',
    'provenance.json',
    'results.json',
    'validation.json',
    'summary.json',
    'cost-scenario.json',
  ]) {
    const original = join(source, 'cases', pair.id, name);
    const copied = join(destination, 'cases', pair.id, name);
    await copyFile(original, copied);
    evidence.push(original, copied);
  }
}
await writeFile(
  join(destination, 'continuation.json'),
  JSON.stringify(
    {
      created: new Date().toISOString(),
      source,
      completedPairs: journal.pairs.length,
      evidenceSha256: await hashes(evidence),
    },
    null,
    2
  ) + '\n',
  { flag: 'wx' }
);
console.log(
  JSON.stringify({ source, destination, completedPairs: journal.pairs.length })
);
