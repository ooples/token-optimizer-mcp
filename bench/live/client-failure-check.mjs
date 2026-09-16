import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { clientAllocationFailure } from './client-failure.mjs';

const captured = await readFile(
  new URL(
    './evidence/joint-confirmation-2026-09-16/diagnostics/nullable-9/agent.stderr.txt',
    import.meta.url
  ),
  'utf8'
);
assert.match(
  clientAllocationFailure(3221226505, captured),
  /allocation failure/
);
assert.equal(clientAllocationFailure(0, captured), null);
assert.equal(clientAllocationFailure(undefined, captured), null);
assert.equal(
  clientAllocationFailure(1, 'Reading additional input from stdin...'),
  null
);
assert.equal(
  clientAllocationFailure(
    1,
    'warning: example memory allocation of 20 bytes failed'
  ),
  null
);
assert.match(
  clientAllocationFailure(
    134,
    'FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory\n'
  ),
  /allocation failure/
);
console.log('Native client allocation classification checks passed.');
