import { afterAll, describe, expect, test } from '@jest/globals';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sha256 } from '../../ucr/index.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SOURCE = join(
  ROOT,
  'evals',
  'ucr',
  'results',
  'full-study-qualification-codex-to-claude-v10.json'
);
const VERIFY = join(ROOT, 'scripts', 'verify-ucr-qualification.mjs');
const TEMP = mkdtempSync(join(tmpdir(), 'ucr-qualification-verifier-'));

afterAll(() => rmSync(TEMP, { recursive: true, force: true }));

function tamperedReport(name, mutate) {
  const report = JSON.parse(readFileSync(SOURCE, 'utf8'));
  mutate(report);
  const { reportHash: _oldHash, ...body } = report;
  report.reportHash = sha256(body);
  const path = join(TEMP, `${name}.json`);
  writeFileSync(path, JSON.stringify(report), 'utf8');
  return path;
}

function verify(path, options = []) {
  const child = spawnSync(process.execPath, [VERIFY, ...options, path], {
    cwd: ROOT,
    encoding: 'utf8',
    windowsHide: true,
  });
  return {
    status: child.status,
    output: JSON.parse(child.stdout),
  };
}

describe('qualification verifier fails closed', () => {
  test('separates authentic negative evidence from the release qualification gate', () => {
    const verification = verify(SOURCE);
    expect(verification.status).toBe(0);
    expect(verification.output.results[0]).toMatchObject({
      artifactValid: true,
      qualified: false,
      passed: true,
    });
    const gate = verify(SOURCE, ['--require-qualified']);
    expect(gate.status).toBe(1);
    expect(gate.output.results[0]).toMatchObject({
      artifactValid: true,
      qualified: false,
      passed: false,
    });
  });

  test('rejects an unsigned but otherwise hash-consistent ledger', () => {
    const path = tamperedReport('unsigned', (report) => {
      delete report.ledger.signature;
    });
    const result = verify(path);
    expect(result.status).toBe(1);
    expect(result.output.results[0].signatureTrusted).toBe(false);
    expect(result.output.results[0].passed).toBe(false);
  });

  test('rejects declared arms and trial counts that disagree with signed rows', () => {
    const path = tamperedReport('forged-selection', (report) => {
      report.selection.arms = 'runtime';
      report.selection.selectedTrials = 1;
    });
    const result = verify(path);
    expect(result.status).toBe(1);
    expect(result.output.results[0].armsMatchRows).toBe(false);
    expect(result.output.results[0].selectedTrialsMatchRows).toBe(false);
  });

  test('rejects an embedded verdict that differs from recomputation', () => {
    const path = tamperedReport('forged-verdict', (report) => {
      report.qualification = {
        ...report.qualification,
        status: 'failed',
        passed: false,
        failed: ['forged'],
      };
    });
    const result = verify(path);
    expect(result.status).toBe(1);
    expect(result.output.results[0].embeddedQualificationMatches).toBe(false);
  });
});
