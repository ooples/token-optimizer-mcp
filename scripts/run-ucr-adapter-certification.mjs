#!/usr/bin/env node

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  UCR_CLIENT_REGISTRY,
  certifyAdapterProcess,
  sha256,
} from '../ucr/index.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const fixture = JSON.parse(
  readFileSync(join(ROOT, 'evals', 'ucr', 'conformance-fixture-v1.json'), 'utf8')
);
const results = Object.keys(UCR_CLIENT_REGISTRY)
  .sort()
  .map((client) => certifyAdapterProcess(client, fixture.inputs));
const semanticHashes = new Set(results.map((result) => result.semanticHash));
const body = {
  schemaVersion: 'ucr.adapter-process-certification/1',
  evidenceClass: 'executable-adapter-process-conformance-not-live-client-model',
  registeredClients: results.length,
  processSmokesPassed: results.filter(
    (result) => result.certified && result.executableSmoke === 'passed'
  ).length,
  distinctProcesses: new Set(results.map((result) => result.processId)).size,
  semanticParity: semanticHashes.size === 1,
  lifecycleFamilies: new Set(results.map((result) => result.family)).size,
  results,
  sourceHash: sha256([
    readFileSync(join(ROOT, 'ucr', 'adapter-sdk.mjs'), 'utf8'),
    readFileSync(join(ROOT, 'scripts', 'ucr-adapter-process.mjs'), 'utf8'),
  ]),
  executedAt: new Date().toISOString(),
};
const reportBody = {
  ...body,
  passed:
    body.processSmokesPassed === results.length &&
    body.distinctProcesses === results.length &&
    body.semanticParity,
};
const report = { ...reportBody, reportHash: sha256(reportBody) };
if (process.argv.includes('--write')) {
  const output = join(
    ROOT,
    'evals',
    'ucr',
    'results',
    'adapter-process-certification-v1.json'
  );
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(output);
}
console.log(JSON.stringify(report, null, 2));
if (!report.passed) process.exitCode = 1;
