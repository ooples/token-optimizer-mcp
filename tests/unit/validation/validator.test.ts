import { describe, it, expect } from '@jest/globals';
import { validateToolArgs } from '../../../src/validation/validator.js';

/**
 * Regression tests for the zod-v4 ZodError crash.
 *
 * Before the fix, validateToolArgs read `error.errors`, which zod v4 removed in
 * favor of `error.issues`. On any validation failure this produced
 * `Cannot read properties of undefined (reading 'map')`. The validator now
 * reads `error.issues ?? error.errors ?? []`, so it must format the failure
 * into a readable message instead of crashing.
 */
describe('validateToolArgs zod-v4 compatibility', () => {
  it('formats a validation failure without throwing the ".map" crash', () => {
    let caught: unknown;
    try {
      // smart_read requires a string `path`; omit it to force a ZodError.
      validateToolArgs('smart_read', { file_path: '/tmp/x' });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    // Must be the friendly formatted message, not the undefined.map crash.
    expect(message).toContain('Validation failed for tool "smart_read"');
    expect(message).toContain('path');
    expect(message).not.toContain('Cannot read properties of undefined');
  });

  it('passes through valid arguments', () => {
    expect(validateToolArgs('smart_read', { path: '/tmp/x' })).toMatchObject({
      path: '/tmp/x',
    });
  });

  it('throws a clear error for an unknown tool', () => {
    expect(() => validateToolArgs('does_not_exist', {})).toThrow(/Unknown tool/);
  });
});
