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

/**
 * Reads stdin while holding at most `retain` bytes from each end.
 *
 * WHY THIS IS NOT `Buffer.concat(chunks)`. That form kept every chunk, then
 * allocated a second full copy to concatenate, and `.toString('utf8')` made a
 * third. A command emitting hundreds of megabytes -- a verbose build, a test
 * suite dumping fixtures, `cat` on a large artefact -- therefore exhausted
 * memory and killed this process, and it died BEFORE emitting anything. That is
 * this file's first rule broken by the code enforcing it: the model receives an
 * empty result for a command that actually succeeded.
 *
 * The middle is what gets dropped, and it is exactly what the bound would have
 * dropped anyway -- so for any input small enough to matter the result is
 * byte-identical to the old behaviour, and for input too large to hold the
 * degradation is head-and-tail rather than death.
 *
 * Memory is bounded at roughly `2 * retain` regardless of input size.
 */
function readStdin(retain) {
  const head = [];
  let headBytes = 0;
  const tail = [];
  let tailBytes = 0;
  let total = 0;

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

    const chunk = Buffer.from(buffer.subarray(0, read));
    total += chunk.length;

    if (headBytes < retain) {
      const take = Math.min(chunk.length, retain - headBytes);
      head.push(chunk.subarray(0, take));
      headBytes += take;
    }

    tail.push(chunk);
    tailBytes += chunk.length;
    // Keep at least `retain` bytes, dropping whole chunks from the front. The
    // guard is on the SURVIVING size, so the ring never shrinks below retain.
    while (tail.length > 1 && tailBytes - tail[0].length >= retain) {
      tailBytes -= tail.shift().length;
    }
  }

  // Everything fit: this is the ordinary case and it is exact.
  if (total <= retain) return { buffer: Buffer.concat(head), total, truncated: false };

  return {
    buffer: Buffer.concat(head),
    tail: Buffer.concat(tail),
    total,
    truncated: true,
  };
}

const [previousPath, maxBytesArg] = process.argv.slice(2);
const maxBytes = Number.parseInt(maxBytesArg, 10) || 8000;

// Enough room for the compactor to find repeated lines around the bound, and
// still a hard ceiling: a few megabytes rather than the whole stream.
const RETAIN_BYTES = Math.max(maxBytes * 4, 1024 * 1024);

const stdin = readStdin(RETAIN_BYTES);
// What a pass-through can still honour. For anything that fit, this IS the
// input; past the ceiling it is the two ends, which is what the bound would
// have produced regardless.
const input = stdin.truncated
  ? Buffer.concat([
      stdin.buffer,
      Buffer.from(
        `\n... ${stdin.total - stdin.buffer.length - stdin.tail.length} bytes not shown ...\n`,
        'utf8'
      ),
      stdin.tail,
    ])
  : stdin.buffer;

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
