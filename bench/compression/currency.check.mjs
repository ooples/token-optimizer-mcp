/**
 * The currency is a recording, so the recording is an instrument too.
 *
 * Three things could go wrong with a committed fixture of token counts, and
 * each would be invisible in the published figures:
 *
 *   - IT COULD ANSWER A STRING IT NEVER MEASURED. A digest-keyed fixture goes
 *     stale the instant an engine changes a byte, and a lookup that quietly
 *     fell back to chars/4 would publish a part-measured figure as measured.
 *   - IT COULD CARRY THE CORPUS. Counts are stored by digest precisely so the
 *     text never is; a serialization mistake here would commit conversation
 *     fixtures and, in a re-record against real sessions, worse.
 *   - ITS ENVELOPE COULD BE EDITED. Every count is `count(text) - envelope`, so
 *     a hand-adjusted envelope shifts every figure in the harness at once, by a
 *     constant, with nothing to show it happened.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { FIXTURE, MODEL, RECORD_COMMAND, digest, tokens } from './currency.mjs';

const raw = readFileSync(FIXTURE, 'utf8');
const record = JSON.parse(raw);

/** Recorded because `proof-metrics.check.mjs` asks for it by name. */
const MARKER = '[... 269 bytes, next above ~x18p57]';

test('every entry is a digest and a count', () => {
  const keys = Object.keys(record.counts);
  assert.ok(keys.length > 100, `only ${keys.length} counts recorded`);
  for (const key of keys) {
    assert.match(key, /^[0-9a-f]{64}$/);
    assert.ok(
      Number.isInteger(record.counts[key]) && record.counts[key] >= 0,
      `${key} is not a count`
    );
  }
});

test('the fixture carries no text it was measured on', () => {
  // The positive control is the assertion above: a fixture of 100+ real counts
  // is doing its job, so this cannot be passing by being empty.
  assert.deepEqual(
    Object.keys(record)
      .filter((k) => typeof record[k] === 'string')
      .sort(),
    ['model', 'recordedAt']
  );
  assert.equal(record.model, MODEL);
  for (const needle of [
    'C:\Users',
    '/home/',
    '/Users/',
    'export ',
    'function ',
  ])
    assert.equal(raw.includes(needle), false, `${needle} reached the fixture`);
});

test('the envelope is the one the ladder derives', () => {
  const rungs = record.ladder;
  const [first, last] = [rungs[0], rungs[rungs.length - 1]];
  const slope = (last[1] - first[1]) / (last[0] - first[0]);
  assert.equal(first[1] - slope * first[0], record.envelope);
  for (const [n, count] of rungs)
    assert.equal(
      count,
      record.envelope + slope * n,
      `rung ${n} is off the fit`
    );
});

test('a recorded string is answered from the recording', () => {
  assert.equal(tokens(MARKER), 15);
  assert.ok(digest(MARKER) in record.counts);
  // An empty block carries nothing, and the endpoint refuses to price one.
  assert.equal(tokens(''), 0);
});

test('an unrecorded string is refused, and the refusal says how to fix it', () => {
  // The whole point of the fixture is that this throws rather than estimating.
  const never = `not recorded: ${digest(FIXTURE)} ${MARKER}`;
  assert.equal(digest(never) in record.counts, false);
  assert.throws(
    () => tokens(never),
    (error) =>
      error.message.includes(RECORD_COMMAND) &&
      error.message.includes(digest(never))
  );
});
