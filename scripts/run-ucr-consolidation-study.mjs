#!/usr/bin/env node

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { consolidationStudy, sha256 } from '../ucr/index.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const write = process.argv.includes('--write');
const sessions = Array.from({ length: 100 }, (_, index) => ({
  id: `session-${String(index + 1).padStart(3, '0')}`,
  delayedReuseOf: index >= 12 ? `memory-${index % 12}` : null,
  objects: [
    {
      id: `memory-${index}`,
      type: 'failure',
      state: 'active',
      trigger: `gotcha-${index % 12}`,
      correction: `verified correction ${index % 12}`,
      confidence: 0.95,
      learnedAt: 1_710_000_000_000 + index,
      expectedUtility: 0.5,
      verificationReceiptIds: [`receipt-${index}`],
    },
  ],
}));
const study = consolidationStudy(sessions, {
  author: 'separate-consolidation-runtime',
  now: 1_710_000_001_000,
});
const body = {
  ...study,
  evidenceClass: 'conformance-long-horizon-not-live-model-effectiveness',
  sourceHash: sha256(readFileSync(join(ROOT, 'ucr', 'consolidation.mjs'), 'utf8')),
  passed:
    study.sessions === 100 &&
    study.sourceMutations === 0 &&
    study.activeGrowthRatio < 0.25 &&
    study.delayedReuseRetained === study.delayedReuseCases,
  executedAt: new Date().toISOString(),
};
const report = { ...body, reportHash: sha256(body) };
if (write) {
  const output = join(
    ROOT,
    'evals',
    'ucr',
    'results',
    'consolidation-study-v1.json'
  );
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(output);
}
console.log(JSON.stringify(report, null, 2));
if (!report.passed) process.exitCode = 1;
