/** Compare exact codec outputs against the pre-optimization source revision. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile, mkdtemp, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import ts from 'typescript';
import { compressJsonFragments } from '../../dist/compress/json-fragments.js';
const evidence = resolve(process.argv[2]);
const read = async (path) => JSON.parse(await readFile(path, 'utf8'));
const baselineRevision = '510d570a';
const source = execFileSync(
  'git',
  ['show', `${baselineRevision}:src/compress/json-fragments.ts`],
  { encoding: 'utf8' }
);
const temporary = await mkdtemp(join(tmpdir(), 'fragment-fastpath-'));
const baselinePath = join(temporary, 'baseline.mjs');
const compiled = ts
  .transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ES2022,
    },
  })
  .outputText.replace(
    "'./types.js'",
    JSON.stringify(pathToFileURL(resolve('dist/compress/types.js')).href)
  );
await writeFile(baselinePath, compiled);
const baseline = (await import(pathToFileURL(baselinePath).href))
  .compressJsonFragments;
const original = resolve(
  'bench/live/evidence/confirmation-2026-09-16-v3-continuation'
);
const oldExecution = await read(join(original, 'execution.json'));
const losses = await read(join(evidence, 'loss-audit.json'));
const followup = await read(join(evidence, 'followup-execution.json'));
const outer = await read(join(evidence, 'outer-summary.json'));
const captures = [];
for (const row of losses.cases) {
  const manifest = await read(join(original, 'cases', row.id, 'manifest.json'));
  captures.push(
    join(
      oldExecution.pairs.find((p) => p.id === row.id).raw,
      `${manifest.tasks[0]}-1-proxy`,
      'requests.jsonl'
    )
  );
}
for (const row of followup) {
  const manifest = await read(join(evidence, 'cases', row.id, 'manifest.json'));
  captures.push(
    join(row.raw, `${manifest.tasks[0]}-1-proxy`, 'requests.jsonl')
  );
}
for (const rep of [1, 2])
  captures.push(join(outer.raw, `refresh-${rep}-proxy`, 'requests.jsonl'));
const seen = new Set();
let compressed = 0;
function visit(value, depth = 0) {
  if (depth > 8 || value == null) return;
  if (typeof value === 'string') {
    if (value.length < 1000 || seen.has(value)) return;
    seen.add(value);
    const before = baseline(value),
      after = compressJsonFragments(value);
    assert.deepEqual(after, before);
    if (after.text !== value) compressed++;
    let nested;
    try {
      nested = JSON.parse(value);
    } catch {
      return;
    }
    visit(nested, depth + 1);
  } else if (Array.isArray(value)) value.forEach((v) => visit(v, depth + 1));
  else if (typeof value === 'object')
    Object.values(value).forEach((v) => visit(v, depth + 1));
}
for (const capture of captures) {
  const records = (await readFile(capture, 'utf8'))
    .trim()
    .split('\n')
    .map(JSON.parse);
  for (const row of records) {
    if (!row.body.startsWith('{')) continue;
    for (const item of JSON.parse(row.body).input ?? [])
      if (item.output) visit(item.output);
  }
}
const report = {
  baselineRevision,
  captures: captures.length,
  uniqueLargeStrings: seen.size,
  compressedStrings: compressed,
  allResultsByteIdentical: true,
  compiledSha256: createHash('sha256')
    .update(await readFile('dist/compress/json-fragments.js'))
    .digest('hex'),
};
const target = join(evidence, 'fastpath');
await mkdir(target, { recursive: true });
await writeFile(
  join(target, 'equivalence.json'),
  JSON.stringify(report, null, 2) + '\n',
  { flag: 'wx' }
);
console.log(JSON.stringify(report, null, 2));
