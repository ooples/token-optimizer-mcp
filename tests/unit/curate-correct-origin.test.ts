/**
 * A correction must not claim to be a person's assertion.
 *
 * `correct()` stamped `origin: ORIGIN_HUMAN` unconditionally, so a correction
 * written programmatically was recorded as hand-curated. curate.mjs itself
 * warns about exactly this: "a hand-written assertion and a machine guess look
 * identical three months later, which quietly destroys the reader's ability to
 * calibrate trust". It also has a ranking consequence -- human findings carry
 * the highest weight, so a machine correction outranked the human claim it
 * replaced.
 *
 * Observed live: correcting a machine-written finding produced a replacement
 * labelled `human`.
 */
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { pathToFileURL } from 'url';
import { join } from 'path';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';

const CURATE = pathToFileURL(
  join(process.cwd(), 'hooks-core', 'curate.mjs')
).href;
const WIKI = pathToFileURL(join(process.cwd(), 'hooks-core', 'wiki.mjs')).href;

let dir: string;
let anchor: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'curate-origin-'));
  anchor = join(dir, 'subject.ts');
  writeFileSync(anchor, 'export function subject() {\n  return 1;\n}\n');
});

afterEach(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* windows can hold a handle briefly */
  }
});

/** The replacement finding produced by correct(). */
async function findingFor(store: string, key: string) {
  const { load, nodeId } = await import(WIKI);
  return load(store).nodes.get(nodeId('finding', key));
}

describe('curate.correct origin', () => {
  it('records the caller-supplied origin rather than assuming human', async () => {
    const { create, correct, ORIGIN_HARVESTED } = await import(CURATE);

    const key = create(dir, {
      claim: 'subject() returns one',
      anchors: [anchor],
    });
    expect(key).toBeTruthy();

    const replacementKey = correct(dir, key, 'subject() actually returns two', {
      origin: ORIGIN_HARVESTED,
    });
    expect(replacementKey).toBeTruthy();

    const replacement = await findingFor(dir, replacementKey);
    expect(replacement.origin).toBe(ORIGIN_HARVESTED);
  });

  it('still defaults to human, because curate is the hand-curation path', async () => {
    const { create, correct, ORIGIN_HUMAN } = await import(CURATE);

    const key = create(dir, {
      claim: 'subject() returns one',
      anchors: [anchor],
    });
    const replacementKey = correct(dir, key, 'subject() returns two');

    const replacement = await findingFor(dir, replacementKey);
    expect(replacement.origin).toBe(ORIGIN_HUMAN);
  });

  it('falls back to human for a nonsense origin rather than storing it', async () => {
    const { create, correct, ORIGIN_HUMAN } = await import(CURATE);

    const key = create(dir, {
      claim: 'subject() returns one',
      anchors: [anchor],
    });
    const replacementKey = correct(dir, key, 'subject() returns two', {
      origin: 42 as unknown as string,
    });

    const replacement = await findingFor(dir, replacementKey);
    expect(replacement.origin).toBe(ORIGIN_HUMAN);
  });

  it('falls back to human for an empty-string origin', async () => {
    // A separate branch of the guard from the type check above: '' is a string,
    // so it passes `typeof origin === 'string'` and is caught only by the
    // truthiness test. Storing it would leave a finding whose origin is neither
    // absent nor meaningful, which ranks at the neutral weight while looking
    // deliberate to a reader.
    const { create, correct, ORIGIN_HUMAN } = await import(CURATE);

    const key = create(dir, {
      claim: 'subject() returns one',
      anchors: [anchor],
    });
    const replacementKey = correct(dir, key, 'subject() returns two', {
      origin: '',
    });

    const replacement = await findingFor(dir, replacementKey);
    expect(replacement.origin).toBe(ORIGIN_HUMAN);
  });

  it('keeps the correction anchored and supersedes the original', async () => {
    // The origin change must not disturb the rest of the contract.
    const { create, correct } = await import(CURATE);
    const { load, nodeId } = await import(WIKI);

    const key = create(dir, {
      claim: 'subject() returns one',
      anchors: [anchor],
    });
    const replacementKey = correct(dir, key, 'subject() returns two');

    const graph = load(dir);
    const replacementId = nodeId('finding', replacementKey);

    const anchored = graph.edges.some(
      (e: any) => e.edge === 'derived_from' && e.from === replacementId
    );
    const supersedes = graph.edges.some(
      (e: any) =>
        e.edge === 'supersedes' &&
        e.from === replacementId &&
        e.to === nodeId('finding', key)
    );

    expect(anchored).toBe(true);
    expect(supersedes).toBe(true);
    expect(graph.nodes.get(nodeId('finding', key)).retired).toBe(true);
  });
});
