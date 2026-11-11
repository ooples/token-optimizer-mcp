/**
 * Jest, restricted to the tests that cover the traversal safety primitives.
 *
 * WHY A SEPARATE CONFIG. Stryker runs the test suite once as a dry run and then
 * again per surviving mutant. Against the full suite -- 239 files, ~200 s -- the
 * dry run alone exceeds Stryker's default timeout, and 140 mutants would take
 * hours. Mutation testing is only affordable when the tests it runs are the ones
 * that could actually kill the mutant, so this config names them.
 *
 * Keep this list in step with `mutate` in stryker.config.json: a mutant whose
 * killing test is not listed here is scored as SURVIVED, which is a false alarm
 * of exactly the kind that gets a gate switched off.
 */
import base from './jest.config.js';

export default {
  ...base,
  testMatch: [
    '<rootDir>/tests/unit/file-operations/bounded-traversal.test.ts',
    '<rootDir>/tests/unit/code-analysis/analysis-traversal-is-bounded.test.ts',
  ],
};
