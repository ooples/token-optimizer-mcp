#!/usr/bin/env node
/** Recompute bounded qualification gates only from hash-bound signed evidence. */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  canonicalJson,
  sha256,
  studyQualificationVerdict,
  verifyEvidenceLedger,
} from '../ucr/index.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RESULTS = join(ROOT, 'evals', 'ucr', 'results');
const TRUST = join(ROOT, 'evals', 'ucr', 'trusted-evidence-keys');
const configured = process.argv.slice(2);
const explicitFiles = configured.length > 0;
const files = configured.length
  ? configured.map((value) => (isAbsolute(value) ? value : resolve(value)))
  : readdirSync(RESULTS)
      .filter((name) => /^full-study-qualification-.*\.json$/i.test(name))
      .map((name) => join(RESULTS, name));
const results = [];

for (const path of files.sort()) {
  const report = JSON.parse(readFileSync(path, 'utf8'));
  if (!report?.selection && !explicitFiles) continue;
  const { reportHash, ...body } = report;
  const rows = report?.ledger?.rows || [];
  const keyId = String(report?.ledgerKeyId || '');
  const trustedKeyPath = /^[A-Za-z0-9._-]+$/.test(keyId)
    ? join(TRUST, `${keyId}.pem`)
    : null;
  const reportHashValid = sha256(body) === reportHash;
  const ledgerVerification = verifyEvidenceLedger(report.ledger, {
    publicKey:
      trustedKeyPath && existsSync(trustedKeyPath)
        ? readFileSync(trustedKeyPath, 'utf8')
        : null,
  });
  const selectedTrialIdsHashValid =
    report?.selection?.selectedTrialIdsHash ===
    sha256(rows.map((row) => row.trialId));
  const qualification = report?.selection
    ? studyQualificationVerdict({
        rows,
        selectedTrialCount: report.selection.selectedTrials,
        plannedArms: String(report.selection.arms || '')
          .split(',')
          .map((arm) => arm.trim())
          .filter(Boolean),
        failures: report.failures,
      })
    : {
        status: 'unverifiable',
        passed: false,
        failed: ['selectionMetadataMissing'],
      };
  const passed =
    reportHashValid &&
    ledgerVerification.valid &&
    selectedTrialIdsHashValid &&
    qualification.passed;
  results.push({
    file: basename(path),
    passed,
    reportHashValid,
    ledgerValid: ledgerVerification.valid,
    selectedTrialIdsHashValid,
    qualification,
    embeddedQualificationMatches:
      report?.qualification?.passed === qualification.passed,
  });
}

const passed = results.length > 0 && results.every((result) => result.passed);
process.stdout.write(canonicalJson({ passed, results }));
if (!passed) process.exitCode = 1;
