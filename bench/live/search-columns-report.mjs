import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { heldoutFixture } from './heldout-cases.mjs';

const evidence = resolve(process.argv[2]);
const read = async (path) => JSON.parse(await readFile(path, 'utf8'));
const fresh = await read(join(evidence, 'local/fresh/results.json'));
const replay = await read(join(evidence, 'local/replay/results.json'));
assert.equal(fresh.complete, true);
assert.equal(replay.complete, true);
assert.equal(fresh.rows.length, 16);
assert.equal(replay.rows.length, 40);
let reconstructed = 0;
for (const [name, run] of [
  ['fresh', fresh],
  ['replay', replay],
]) {
  for (const row of run.rows.filter((row) => row.arm === 'proxy')) {
    const body = await read(
      join(evidence, 'local', name, `${row.seed}-proxy.json`)
    );
    const output = body.input.find(
      (item) => item.type === 'function_call_output'
    ).output;
    const [header, ...rows] = output.split('\n');
    const match =
      /^(.*):(\d+)-(\d+) \[exact declaration rows: .*?concatenate template (\[.*\]) around/.exec(
        header
      );
    assert.ok(match);
    const [, path, first, last, encoded] = match;
    const [before, between, after] = JSON.parse(encoded);
    assert.equal(rows.length, Number(last) - Number(first) + 1);
    const restored = rows
      .map((line, index) => {
        const fields = line.split('\t');
        assert.equal(fields.length, 2);
        return `${path}:${Number(first) + index}:${before}${fields[0]}${between}${fields[1]}${after}`;
      })
      .join('\n');
    assert.equal(restored, heldoutFixture('code', row.seed).content);
    reconstructed++;
  }
}
const mean = (rows, key) =>
  rows.reduce((total, row) => total + row[key], 0) / rows.length;
const arms = Object.fromEntries(
  ['proxy', 'headroom'].map((arm) => [
    arm,
    Object.fromEntries(
      ['forwardedBytes', 'estimatedO200kTokens', 'milliseconds'].map((key) => [
        key,
        mean(
          fresh.rows.filter((row) => row.arm === arm),
          key
        ),
      ])
    ),
  ])
);
const prior = await read(
  'bench/live/evidence/local-proxy-performance-2026-09-16/results.json'
);
const groups = prior.records.filter(
  (row) => row.task === 'code' && row.mode === 'unique'
);
// Assert exact original request sizes in order, not only similar seed labels.
for (const group of groups)
  for (const [index, sample] of group.samples.entries())
    assert.equal(sample.sentBytes, replay.rows[index].rawBytes);
const oldProxy = mean(
  groups.filter((row) => row.arm === 'proxy').flatMap((row) => row.samples),
  'forwardedBytes'
);
const oldHeadroom = mean(
  groups.filter((row) => row.arm === 'headroom').flatMap((row) => row.samples),
  'forwardedBytes'
);
const newProxy = mean(replay.rows, 'forwardedBytes');
const result = {
  reconstructedProxyBodies: reconstructed,
  fresh: {
    cases: 8,
    arms,
    reductions: Object.fromEntries(
      Object.keys(arms.proxy).map((key) => [
        key,
        1 - arms.proxy[key] / arms.headroom[key],
      ])
    ),
    byteWins: fresh.rows.filter(
      (row) =>
        row.arm === 'proxy' &&
        row.forwardedBytes <
          fresh.rows.find(
            (other) => other.arm === 'headroom' && other.seed === row.seed
          ).forwardedBytes
    ).length,
  },
  originalLosingInputs: {
    cases: 40,
    oldProxyMeanBytes: oldProxy,
    archivedHeadroomMeanBytes: oldHeadroom,
    newProxyMeanBytes: newProxy,
    reductionVersusArchivedHeadroom: 1 - newProxy / oldHeadroom,
    reductionVersusOldProxy: 1 - newProxy / oldProxy,
  },
  limitations: [
    'Local upstream; no model-quality or billed-cost inference.',
    'o200k_base measures serialized request-body token estimates, not observed model usage.',
    'Eight fresh cases, two opposite arm orders, no inferential interval.',
    'Original-input replay compares new proxy bytes with archived comparator bytes; not a concurrent latency comparison.',
  ],
};
await writeFile(
  join(evidence, 'local-summary.json'),
  JSON.stringify(result, null, 2) + '\n',
  { flag: 'wx' }
);
console.log(JSON.stringify(result, null, 2));
