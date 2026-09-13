/**
 * Pressure to record.
 *
 * The property under test is that this fires when a conclusion exists and is being lost, and stays
 * quiet otherwise. A nudge that fires too early has nothing to point at; one that repeats becomes
 * the thing you learn to skip; one that never fires is what the product shipped with -- measured at
 * 340 read events and zero findings in one project's graph.
 */

import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  recordingNudge, compactionNudge, semanticHarvestPrompt, findingCount,
  isSubstantive, NUDGE_AFTER_EDITS,
} from '../../hooks-core/recording.mjs';
import { putNode } from '../../hooks-core/wiki.mjs';

let dir;
beforeEach(() => { dir = join(mkdtempSync(join(tmpdir(), 'rec-')), 'wiki'); mkdirSync(dir, { recursive: true }); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const many = (n) => Array.from({ length: n }, (_, i) => `C:/repo/src/file${i % 3}.ts`);

describe('it fires only once real work exists', () => {
  test('silent before the threshold, however empty the graph', () => {
    // Firing at the start would point at nothing: there is no conclusion yet to record.
    expect(recordingNudge(dir, { edits: NUDGE_AFTER_EDITS - 1, files: many(3) })).toBeNull();
  });

  test('fires past the threshold on a graph that has learned nothing', () => {
    const out = recordingNudge(dir, { edits: NUDGE_AFTER_EDITS, files: many(9) });
    expect(out).toMatch(/wiki_write/);
    expect(out).toMatch(new RegExp(`${NUDGE_AFTER_EDITS} edits`));
  });

  test('names the files, because "record what you learned" is wallpaper', () => {
    const out = recordingNudge(dir, {
      edits: 12,
      files: ['C:/repo/hooks-core/keepwarm.mjs', 'C:/repo/hooks-core/lessons.mjs'],
    });
    expect(out).toContain('keepwarm.mjs');
    expect(out).toContain('lessons.mjs');
    // The path is trimmed to the basename: a nudge that wraps three lines is one nobody reads.
    expect(out).not.toContain('C:/repo/hooks-core/');
  });

  test('at most three files are named however many were touched', () => {
    const out = recordingNudge(dir, {
      edits: 30,
      files: Array.from({ length: 20 }, (_, i) => `C:/repo/f${i}.ts`),
    });
    expect((out.match(/f\d+\.ts/g) || []).length).toBe(3);
  });
});

describe('it stays quiet where it would be noise', () => {
  test('a project whose graph already holds findings is left alone', () => {
    // The question is whether this project has EVER learned anything, not whether something was
    // recorded in the last few minutes. A graph with findings needs no prompting.
    putNode(dir, {
      kind: 'finding',
      key: 'already-known',
      claim: 'Something was already learned here.',
      anchors: ['C:/repo/src/a.ts'],
    });
    expect(findingCount(dir)).toBeGreaterThan(0);
    expect(recordingNudge(dir, { edits: 50, files: many(9) })).toBeNull();
  });

  test('once nudged, never again in that session', () => {
    expect(recordingNudge(dir, { state: { recordingNudged: true }, edits: 99, files: many(9) })).toBeNull();
  });

  test('a corrupt or absent graph is treated as empty rather than throwing', () => {
    expect(findingCount(join(dir, 'nope'))).toBe(0);
  });
});

describe('compaction asks again, because that is when the answer is destroyed', () => {
  test('it fires after any real work, not just past the router threshold', () => {
    // Deliberately a lower bar than the router's. Compaction is the event this subsystem exists
    // for: an unrecorded conclusion does not survive it.
    expect(compactionNudge(dir, { edits: 1 })).toMatch(/wiki_write/);
  });

  test('a session that changed nothing is not asked', () => {
    expect(compactionNudge(dir, { edits: 0 })).toBeNull();
  });

  test('a graph that already holds findings is not asked', () => {
    putNode(dir, { kind: 'finding', key: 'known', claim: 'Known.', anchors: ['C:/repo/src/a.ts'] });
    expect(compactionNudge(dir, { edits: 40 })).toBeNull();
  });
});

describe('only decisions count as work', () => {
  test('edits and writes count', () => {
    for (const t of ['Edit', 'MultiEdit', 'Write', 'NotebookEdit']) expect(isSubstantive(t)).toBe(true);
  });

  test('looking at something does not', () => {
    // Otherwise every session trips the threshold within a minute of reading around, and the
    // nudge fires before there is any conclusion to record.
    for (const t of ['Read', 'Grep', 'Glob', 'Bash', undefined, null]) expect(isSubstantive(t)).toBe(false);
  });
});

describe('the active model performs the final semantic harvest', () => {
  test('asks the model that did the work and forbids delegation', () => {
    const out = semanticHarvestPrompt({
      edits: 3,
      files: ['C:/repo/src/cache.ts'],
      model: 'gpt-5.6-sol',
    });

    expect(out).toMatch(/active gpt-5\.6-sol model/i);
    expect(out).toMatch(/wiki_write/);
    expect(out).toMatch(/do not delegate/i);
    expect(out).toContain('cache.ts');
  });

  test('does not invent work or loop after Codex already continued Stop', () => {
    expect(semanticHarvestPrompt({ edits: 0 })).toBeNull();
    expect(semanticHarvestPrompt({ edits: 5, stopHookActive: true })).toBeNull();
  });

  test('uses the active-model fallback and omits an empty file subject', () => {
    const out = semanticHarvestPrompt({ edits: 1, model: '', files: [] });

    expect(out).toMatch(/the active model that did the reasoning/i);
    expect(out).not.toMatch(/Work touched/);
  });

  test('demands the answer back, because this prompt owns the last message', () => {
    // REGRESSION PIN, with a measured failure behind it. This prompt CONTINUES
    // the turn, so the model's reply to it is the final message of the session
    // -- and on THOL's report-pdf the model replied "Recorded. The finding:
    // pip3 install requires --break-system-packages", scoring 0.30 against
    // control's 0.90 on 5 of 5 runs across two campaigns. The PDF was correct;
    // only the answer was missing, because a harvest confirmation had replaced
    // it.
    //
    // Asserted on the SHIPPED prompt rather than on a copy of the wording, and
    // positively rather than as a `not.toContain`: a rule about what must be
    // absent passes on an empty string, which is exactly the vacuous assertion
    // this repo's lint rule rejects.
    const out = semanticHarvestPrompt({
      edits: 2,
      files: ['C:/repo/src/report.ts'],
    });

    expect(out).toMatch(/restating the answer to the original task in full/i);
    expect(out).toMatch(/last thing the reader sees/i);
    // The instruction has to come AFTER the request to record, or it reads as
    // advice about the recording rather than about what follows it.
    expect(out.indexOf('wiki_write')).toBeLessThan(
      out.indexOf('restating the answer')
    );
  });
});
