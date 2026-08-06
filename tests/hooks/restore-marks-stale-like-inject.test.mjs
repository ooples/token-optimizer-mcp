import { describe, it, expect } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The restoration brief must mark a stale finding on the SAME rule the injector
 * uses, or the two surfaces disagree about the same finding.
 *
 * `inject.mjs` demands both halves before it uses the strong framing:
 *
 *     if (!finding.staleEvidence || !finding.diff) { ...weak marker... }
 *
 * `restore.mjs` checked only `staleEvidence`, so a finding carrying evidence but
 * no reconstructable diff was written `! STALE` in the brief and softened
 * everywhere else. The strong marker is the one that tells a reader "this claim
 * is contradicted and here is the proof" -- printing it with no proof to show is
 * exactly the bare stale finding the staleness design calls worse than having no
 * graph at all.
 *
 * Asserted against the SOURCE of both renderers rather than by rendering, because
 * the defect is that two conditions drifted apart: comparing outputs would pass
 * whenever a fixture happened to carry both fields.
 */

const core = (name) =>
  readFileSync(join(process.cwd(), 'hooks-core', name), 'utf8');

describe('the stale marker in the restoration brief', () => {
  it('requires a diff, exactly as the injector does', () => {
    const restore = core('restore.mjs');

    // The CONDITION, not its punctuation. An earlier version of this test
    // matched a parenthesised ternary and broke the moment prettier reformatted
    // the same logic -- asserting shape rather than behaviour.
    expect(restore).toMatch(/staleEvidence\s*&&\s*finding\.diff/);

    // And the weak marker must still exist as the alternative, or the strong one
    // is simply never reached.
    expect(restore).toMatch(/'! STALE '/);
    expect(restore).toMatch(/'~ '/);
  });

  it('still guards on staleEvidence, so the fix cannot be a blanket weakening', () => {
    // Dropping to `finding.diff` alone would also satisfy a naive check while
    // losing the distinction the marker exists to draw.
    const inject = core('inject.mjs');

    expect(inject).toMatch(/!finding\.staleEvidence \|\| !finding\.diff/);
  });
});
