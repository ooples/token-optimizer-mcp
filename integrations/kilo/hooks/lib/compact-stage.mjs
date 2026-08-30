// GENERATED FILE -- do not edit.
// Source of truth: hooks-core/compact-stage.mjs. Regenerate with `npm run sync:hooks`.
/**
 * The pipe stage that compacts a command's output against its previous run.
 *
 *   ... | node compact-stage.mjs <previousFile> <maxBytes>
 *
 * IT REPLACES `{ head -c H; tail -c T; }`, so it inherits that stage's two hard
 * obligations, and both are failure modes it must not have:
 *
 *   IT MUST NOT SWALLOW OUTPUT   this stage is the only thing standing between
 *                                the command and the model. Any error here has
 *                                to degrade to passing stdin through untouched,
 *                                never to an empty result.
 *   IT MUST ALWAYS EXIT 0        the wrapper runs under `pipefail`, so a
 *                                non-zero exit here would report a SUCCESSFUL
 *                                command as failed -- the status masking the
 *                                whole wrapper exists to prevent, in the
 *                                direction that makes a model debug a passing
 *                                build.
 *
 * Everything below is written to those two rules: one try, a pass-through
 * catch, and a single exit at the end.
 */

import { readFileSync, writeFileSync, mkdirSync, writeSync, readSync } from 'node:fs';
import { dirname } from 'node:path';
import { compact } from './compact.mjs';

/** Keep at most this much of a run for the NEXT run to compare against. */
const MAX_REMEMBERED_BYTES = 512 * 1024;

/** The same synchronous write the hooks use, for the same reason: exit truncates. */
function emit(buffer) {
  let written = 0;
  while (written < buffer.length) {
    try {
      written += writeSync(1, buffer, written, buffer.length - written);
    } catch (error) {
      if (error?.code === 'EAGAIN') {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);
        continue;
      }
      return;
    }
  }
}

function readStdin() {
  const chunks = [];
  const buffer = Buffer.alloc(64 * 1024);
  // Reading fd 0 synchronously, because this stage has nothing else to do and
  // an async read racing the exit is how output goes missing.
  for (;;) {
    let read = 0;
    try {
      read = readSync(0, buffer, 0, buffer.length, null);
    } catch (error) {
      if (error?.code === 'EAGAIN') continue;
      if (error?.code === 'EOF') break;
      break;
    }
    if (read <= 0) break;
    chunks.push(Buffer.from(buffer.subarray(0, read)));
  }
  return Buffer.concat(chunks);
}

const [previousPath, maxBytesArg] = process.argv.slice(2);
const maxBytes = Number.parseInt(maxBytesArg, 10) || 8000;

const input = readStdin();

try {
  const text = input.toString('utf8');

  let previous = '';
  try {
    previous = readFileSync(previousPath, 'utf8');
  } catch {
    // No previous run for this command in this session, which is the ordinary
    // first-run case: `compact` then degrades to the plain head-and-tail bound.
  }

  emit(Buffer.from(compact(text, { previous, maxBytes }), 'utf8'));

  // Remembered AFTER emitting, so a failure to write the state file can never
  // cost the model its output.
  try {
    mkdirSync(dirname(previousPath), { recursive: true });
    writeFileSync(previousPath, text.slice(0, MAX_REMEMBERED_BYTES));
  } catch {
    // A read-only or full temp directory costs the next run its comparison and
    // nothing else.
  }
} catch {
  // ANY failure above: hand over exactly what arrived. Bounded output is an
  // optimisation; the command's output is not.
  emit(input);
}

process.exit(0);
