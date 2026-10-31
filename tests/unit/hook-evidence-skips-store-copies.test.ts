/**
 * Analytics reads every per-user project store (#538), but not the copies of
 * store data that migration keeps: the backup, an in-progress staging copy, or
 * a store kept after a restore. Those hold the same evidence again and used up
 * the per-client file budget ahead of the live stores.
 */
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hookEvidenceFiles } from '../../src/analytics/native-provider-usage.js';

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'evidence-home-'));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

function evidence(...parts: string[]): string {
  const dir = join(home, '.token-optimizer', 'projects', ...parts);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'evidence.jsonl');
  writeFileSync(file, '{}\n');
  return file;
}

describe('hookEvidenceFiles', () => {
  it('reads a live per-user store and skips migration copies', () => {
    const live = evidence('0123456789abcdef', 'store', 'wiki');
    evidence('0123456789abcdef', 'backup-2026-10-31T00-00-00-000Z-1', 'wiki');
    evidence(
      '0123456789abcdef',
      'store.staging-2026-10-31T00-00-00-000Z-1',
      'wiki'
    );
    evidence(
      '0123456789abcdef',
      'store.restored-2026-10-31T00-00-00-000Z-1',
      'wiki'
    );
    const found = hookEvidenceFiles(home, 0).map((f) => f.replace(/\\/g, '/'));
    expect(found).toEqual([live.replace(/\\/g, '/')]);
  });
});
