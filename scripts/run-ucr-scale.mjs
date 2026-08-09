#!/usr/bin/env node

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { benchmarkGraphProjection, sha256 } from '../ucr/index.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const options = {
  events: 1_000_000,
  maximumMs: 120_000,
  maximumRssBytes: 768 * 1024 * 1024,
  write: false,
};
for (let index = 2; index < process.argv.length; index++) {
  const arg = process.argv[index];
  if (arg === '--write') options.write = true;
  else if (arg === '--events') options.events = Number(process.argv[++index]);
  else if (arg === '--maximum-ms')
    options.maximumMs = Number(process.argv[++index]);
  else if (arg === '--maximum-rss-bytes')
    options.maximumRssBytes = Number(process.argv[++index]);
  else throw new Error(`unknown option ${arg}`);
}

const result = benchmarkGraphProjection({
  eventCount: options.events,
  maximumMs: options.maximumMs,
  maximumRssBytes: options.maximumRssBytes,
});
const body = {
  ...result,
  evidenceClass: 'conformance-scale-not-model-effectiveness',
  sourceHash: sha256(readFileSync(join(ROOT, 'ucr', 'scale.mjs'), 'utf8')),
  executedAt: new Date().toISOString(),
};
const report = { ...body, reportHash: sha256(body) };
if (options.write) {
  const output = join(ROOT, 'evals', 'ucr', 'results', 'graph-scale-v1.json');
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(output);
}
console.log(JSON.stringify(report, null, 2));
if (!report.passed) process.exitCode = 1;
