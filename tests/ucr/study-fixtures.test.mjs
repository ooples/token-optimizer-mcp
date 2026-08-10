import { afterEach, describe, expect, test } from '@jest/globals';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BENCHMARK_FAMILIES,
  gradeStudyFixture,
  materializeStudyFixture,
} from '../../ucr/index.mjs';

const roots = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop(), { recursive: true, force: true });
});

describe('parent-owned natural-task fixtures', () => {
  test.each(BENCHMARK_FAMILIES)(
    'grades %s from filesystem state, not prose',
    (family) => {
      const root = mkdtempSync(join(tmpdir(), 'ucr-study-fixture-'));
      roots.push(root);
      const task = {
        id: `${family}-test`,
        family,
        prompt: 'complete repository task',
        grader: { requiredState: { completed: `verified-${family}` } },
      };
      const trial = {
        arm: 'runtime',
        hiddenVariantId: 'hidden-variant',
        variantPrompt: 'complete the hidden repository task',
        publicVariant: { entitySuffix: 'a1b2c3d4' },
      };
      const fixture = materializeStudyFixture({ task, trial, root });
      writeFileSync(
        join(root, 'result.json'),
        JSON.stringify({ answer: fixture.private.expectedAnswer, receipts: [] })
      );
      expect(gradeStudyFixture({ task, fixture })).toMatchObject({
        correct: true,
        proseUsedAsOracle: false,
        changedProtected: [],
      });
      const protectedPath = Object.keys(fixture.private.protectedHashes)[0];
      writeFileSync(
        join(root, protectedPath),
        `${readFileSync(join(root, protectedPath), 'utf8')}tampered`
      );
      expect(gradeStudyFixture({ task, fixture }).correct).toBe(false);
    }
  );
});
