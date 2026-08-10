#!/usr/bin/env node
/** Recompute bounded qualification gates only from hash-bound signed evidence. */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  canonicalJson,
  sha256,
  studyQualificationVerdict,
  validateModelAttestation,
  verifyEvidenceLedger,
} from '../ucr/index.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RESULTS = join(ROOT, 'evals', 'ucr', 'results');
const TRUST = join(ROOT, 'evals', 'ucr', 'trusted-evidence-keys');
const requireQualified = process.argv.includes('--require-qualified');
const configured = process.argv
  .slice(2)
  .filter((value) => value !== '--require-qualified');
const files = configured.length
  ? configured.map((value) => (isAbsolute(value) ? value : resolve(value)))
  : readdirSync(RESULTS)
      .filter((name) => /^full-study-qualification-.*\.json$/i.test(name))
      .map((name) => join(RESULTS, name));
const results = [];

for (const path of files.sort()) {
  const report = JSON.parse(readFileSync(path, 'utf8'));
  const { reportHash, ...body } = report;
  const rows = report?.ledger?.rows || [];
  const keyId = String(report?.ledgerKeyId || '');
  const trustedKeyPath = /^[A-Za-z0-9._-]+$/.test(keyId)
    ? join(TRUST, `${keyId}.pem`)
    : null;
  const reportHashValid = sha256(body) === reportHash;
  let trustedPublicKey = null;
  if (trustedKeyPath && existsSync(trustedKeyPath)) {
    try {
      trustedPublicKey = readFileSync(trustedKeyPath, 'utf8');
    } catch {
      trustedPublicKey = null;
    }
  }
  const ledgerVerification = verifyEvidenceLedger(report.ledger, {
    publicKey: trustedPublicKey,
  });
  const signatureTrusted =
    Boolean(trustedPublicKey) && ledgerVerification.validSignature === true;
  const selectedTrialIdsHashValid =
    report?.selection?.selectedTrialIdsHash ===
    sha256(rows.map((row) => row.trialId));
  const observedArms = [
    ...new Set(rows.map((row) => String(row?.arm || '')).filter(Boolean)),
  ].sort();
  const declaredArms = String(report?.selection?.arms || '')
    .split(',')
    .map((arm) => arm.trim())
    .filter(Boolean)
    .sort();
  const armsMatchRows =
    observedArms.length > 0 &&
    canonicalJson(declaredArms) === canonicalJson(observedArms);
  const selectedTrialsMatchRows =
    Number.isInteger(report?.selection?.selectedTrials) &&
    report.selection.selectedTrials === rows.length;
  const qualification = report?.selection
    ? studyQualificationVerdict({
        rows,
        selectedTrialCount: rows.length,
        plannedArms: observedArms,
        failures: report.failures,
      })
    : {
        status: 'unverifiable',
        passed: false,
        failed: ['selectionMetadataMissing'],
      };
  const embeddedQualificationMatches =
    canonicalJson(report?.qualification ?? null) ===
    canonicalJson(qualification);
  const modelAttestationsValid =
    rows.length > 0 &&
    rows.every((row) => {
      const attestations = row?.modelAttestations || [];
      if (attestations.length !== row?.expectedProviderInvocations) return false;
      return attestations.every((entry) => {
        const producer = entry?.role === 'producer';
        const expectedClient = producer
          ? row.producerClient
          : row.consumerClient;
        const expectedModel = producer
          ? row.producerModelVersion
          : row.consumerModelVersion;
        const expectedTransport = producer
          ? row.producerTransport
          : row.consumerTransport;
        return (
          entry?.transport === expectedTransport &&
          validateModelAttestation(entry?.attestation, {
            client: expectedClient,
            requestedModel: expectedModel,
            providerRequestId: entry?.providerRequestId,
          }).valid
        );
      });
    });
  const consumerMcpIsolation =
    rows.length > 0 &&
    rows.every((row) => row?.consumerMcpExposed === false);
  const semanticEvidenceVerified =
    rows.length > 0 &&
    rows.every(
      (row) =>
        row?.semanticEvidenceVerification?.verified === true &&
        Array.isArray(row.semanticEvidenceVerification.anchors) &&
        row.semanticEvidenceVerification.anchors.length > 0
    );
  const artifactValid =
    reportHashValid &&
    ledgerVerification.valid &&
    signatureTrusted &&
    selectedTrialIdsHashValid &&
    armsMatchRows &&
    selectedTrialsMatchRows &&
    embeddedQualificationMatches;
  const qualified =
    artifactValid &&
    modelAttestationsValid &&
    consumerMcpIsolation &&
    semanticEvidenceVerified &&
    qualification.passed;
  const passed = artifactValid && (!requireQualified || qualified);
  results.push({
    file: basename(path),
    passed,
    artifactValid,
    qualified,
    reportHashValid,
    ledgerValid: ledgerVerification.valid,
    signatureTrusted,
    selectedTrialIdsHashValid,
    armsMatchRows,
    selectedTrialsMatchRows,
    modelAttestationsValid,
    consumerMcpIsolation,
    semanticEvidenceVerified,
    qualification,
    embeddedQualificationMatches,
  });
}

const passed = results.length > 0 && results.every((result) => result.passed);
process.stdout.write(canonicalJson({ passed, requireQualified, results }));
if (!passed) process.exitCode = 1;
