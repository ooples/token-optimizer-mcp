/**
 * Every field the hooks write onto session state survives a save and a load.
 *
 * Each hook call is a new process, so state lives only in what `loadState`
 * reads back -- and `loadState` copies a whitelist of fields. A field written by
 * the code but missing from that whitelist is silently forgotten between calls.
 * That has now happened three times: `advised` (the search advisory repeated on
 * every search), and in issue #473 both `routingAdvised` (the "said once" record)
 * and `seenUrls` (repeated-WebFetch detection, which therefore never fired).
 *
 * This ratchet finds the fields by scanning the source for writes, so a new one
 * fails here the day it is added rather than after it is measured in a transcript.
 */

import { readFileSync, readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Fields assigned, incremented or mutated on a `state` object in hook code. */
function writtenFields() {
  const sources = [
    ...readdirSync(join(ROOT, 'hooks-core'))
      .filter((f) => f.endsWith('.mjs'))
      .map((f) => join(ROOT, 'hooks-core', f)),
    ...readdirSync(join(ROOT, 'plugin', 'hooks'))
      .filter((f) => f.endsWith('.mjs'))
      .map((f) => join(ROOT, 'plugin', 'hooks', f)),
  ];
  const fields = new Set();
  const writes = [
    // state.field = / ++ / += / .push( / .add(, including state.field[key] = ...
    /\bstate\.([A-Za-z_]+)(?:\[[^\]]*\])?\s*(?:=(?!=)|\+\+|\+=|\.push\(|\.add\()/g,
    // state['field'] = ...
    /\bstate\[\s*['"]([A-Za-z_]+)['"]\s*\](?:\[[^\]]*\])?\s*=(?!=)/g,
    // A helper handed the state and a field NAME, e.g. stampTool(state, 'x', ...)
    // -- the route optimizerToolAbsentAt and optimizerToolOkAt are written by,
    // which the first pattern could not see.
    /\(\s*state\s*,\s*['"]([A-Za-z_]+)['"]/g,
  ];
  for (const file of sources) {
    const text = readFileSync(file, 'utf8');
    for (const write of writes) for (const match of text.matchAll(write)) fields.add(match[1]);
  }
  return [...fields].sort();
}

let stateRoot;
const PRIOR = process.env.TOKEN_OPTIMIZER_STATE_DIR;

beforeAll(() => {
  stateRoot = mkdtempSync(join(tmpdir(), 'state-fields-'));
  process.env.TOKEN_OPTIMIZER_STATE_DIR = stateRoot;
});
afterAll(() => {
  if (PRIOR === undefined) delete process.env.TOKEN_OPTIMIZER_STATE_DIR;
  else process.env.TOKEN_OPTIMIZER_STATE_DIR = PRIOR;
  rmSync(stateRoot, { recursive: true, force: true });
});

test('the scan finds the fields it exists to protect', () => {
  // A scan that matched nothing would pass every assertion below vacuously.
  expect(writtenFields()).toEqual(
    expect.arrayContaining([
      'seen',
      'routingAdvised',
      'seenUrls',
      'subagentBriefed',
      'optimizerToolAbsentAt',
      'optimizerToolOkAt',
    ])
  );
});

test('every written state field round-trips through saveState and loadState', async () => {
  const { loadState, saveState } = await import('../../hooks-core/policy.mjs');
  const session = `fields-${randomUUID()}`;
  const fields = writtenFields();

  const state = loadState(session, null);
  for (const field of fields) {
    // Present in the empty default, so the code never meets `undefined`.
    expect({ field, present: field in state }).toEqual({ field, present: true });
  }

  // A marker of the field's own type, so a type check in loadState accepts it.
  // Map values are numbers: actCounts merges by Math.max, and a number is also a
  // valid value in every other keyed map (seen, denied, seenUrls).
  const marked = {};
  for (const field of fields) {
    const empty = state[field];
    if (Array.isArray(empty)) marked[field] = ['marker'];
    else if (typeof empty === 'boolean') marked[field] = true;
    else if (typeof empty === 'number') marked[field] = 7;
    else if (empty && typeof empty === 'object') marked[field] = { marker: 1 };
    else continue;
    state[field] = marked[field];
  }
  saveState(session, state, null);

  const reloaded = loadState(session, null);
  for (const [field, value] of Object.entries(marked)) {
    expect({ field, value: reloaded[field] }).toEqual({ field, value });
  }

  // INDEPENDENT OF THE SCAN: whatever saveState puts on disk must come back.
  // A field merged on save but missing from loadState is lost on the next load
  // however it was written, so this holds even for a write route no pattern
  // above recognises.
  const files = readdirSync(stateRoot).filter((name) => name.endsWith('.json'));
  expect(files.length).toBeGreaterThan(0);
  for (const name of files) {
    const onDisk = JSON.parse(readFileSync(join(stateRoot, name), 'utf8'));
    for (const [field, value] of Object.entries(onDisk)) {
      expect({ field, value: reloaded[field] }).toEqual({ field, value });
    }
  }
});
