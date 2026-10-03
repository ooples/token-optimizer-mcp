import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  proseDrift,
  DECLARED,
  Source,
  MINIMUM_FIGURES,
} from '../../bench/compression/readme-prose.check.mjs';

// readme-table.check.mjs pins the marked TABLES; this pins the sentences around
// them. A review found four prose figures stale against a table two markers
// above them, so the value of the check is entirely in whether it can fail --
// every arm below breaks the README on purpose and names what comes back.

const README = readFileSync(
  fileURLToPath(new URL('../../README.md', import.meta.url)),
  'utf8'
);

const kinds = (r) => r.faults.map((f) => f.kind);

describe('the README as committed', () => {
  it('has no prose figure the guarded tables do not hold', () => {
    const report = proseDrift(README);
    expect(report.faults).toEqual([]);
    expect(report.checked).toBeGreaterThanOrEqual(MINIMUM_FIGURES);
  });

  it('reads the whole covered region, not a remnant of it', () => {
    const report = proseDrift(README);
    // FLOORS, NOT EXACT COUNTS, and the difference is what this test is for.
    // What makes a region a remnant is that it got SMALLER; prose being added
    // to it is the ordinary case, and an exact count turns every such edit
    // into a failing test with nothing wrong behind it -- which is what
    // happened, three times, until these numbers were stale enough that the
    // test said nothing about the region at all. A region disappearing is
    // caught on its own terms: proseDrift raises a `scope` fault for a marker
    // pair it cannot find, which the control below holds it to.
    expect(report.checked).toBeGreaterThanOrEqual(37);
    expect(report.coveredLines).toBeGreaterThanOrEqual(205);
  });

  it('declares every figure with a reason of a known kind', () => {
    const known = new Set(Object.values(Source));
    expect(DECLARED.length).toBeGreaterThanOrEqual(18);
    expect(DECLARED.filter((d) => !known.has(d.kind))).toEqual([]);
    expect(DECLARED.filter((d) => !d.from || !d.anchor)).toEqual([]);
    expect(
      DECLARED.filter((d) => d.kind === Source.RETRACTED).length
    ).toBeGreaterThanOrEqual(11);
  });
});

describe('control: the check catches the drift it was written for', () => {
  it('catches a prose figure edited away from its table', () => {
    // The exact defect the review found: the table says 97.2%, the sentence
    // restating it says something else.
    const drifted = README.replace(
      'this section -- 97.5%, 97.8%',
      'this section -- 97.4%, 97.8%'
    );
    // The forgery has to LAND. An anchor that no longer appears in the README
    // leaves `drifted` identical to it, and a control arm that forges nothing
    // passes on a check that has stopped working.
    expect(drifted).not.toBe(README);
    const report = proseDrift(drifted);
    expect(kinds(report)).toEqual(['undeclared']);
    expect(report.faults[0].figure).toBe('97.4%');
  });

  it('catches a new percentage dropped into covered prose', () => {
    const added = README.replace(
      'tree had moved.',
      'tree had moved. A later pass took it to 99.4%.'
    );
    const report = proseDrift(added);
    expect(kinds(report)).toEqual(['undeclared']);
    expect(report.faults[0].figure).toBe('99.4%');
  });

  it('catches a registry entry whose sentence was rewritten out from under it', () => {
    const rewritten = README.replace('of the whole payload', 'of the request');
    expect(rewritten).not.toBe(README);
    const report = proseDrift(rewritten);
    // TWICE, and both are wanted: the entry no longer finds its sentence, and
    // the figure it used to cover is now undeclared. Reporting only the first
    // would leave the reader thinking the registry is the whole problem.
    expect(report.faults.map((f) => [f.kind, f.figure])).toEqual([
      ['stale-registry', '44.3%'],
      ['undeclared', '44.3%'],
    ]);
  });

  it('catches a retracted figure that a guarded table has started holding', () => {
    // 61.3% is quoted as a number the tree moved past. Put it back in the
    // guarded table and the sentence telling that story is now false -- which
    // a check comparing prose to tables the ordinary way round would call a
    // pass.
    // BUILT FROM THE ROW, not from a pasted copy of it. The table's column
    // widths belong to the formatter and have already moved twice, and each
    // time a hand-copied anchor stopped matching -- so the forgery stopped
    // being a forgery while the test went on reporting a pass.
    const row = README.split('\n').find((line) =>
      line.startsWith('| codebase-exploration')
    );
    const cells = row.split('|');
    const resurrected = README.replace(
      row,
      cells
        .map((cell, i) => (i === 4 ? cell.replace(/[\d.]+%/, '61.3%') : cell))
        .join('|')
    );
    expect(resurrected).not.toBe(README);
    const report = proseDrift(resurrected);
    expect(report.faults.map((f) => f.kind)).toContain('resurrected');
    expect(report.faults.filter((f) => f.figure === '61.3%')).toHaveLength(2);
  });

  it('catches the covered region being removed instead of fixed', () => {
    const unscoped = README.replace(
      '<!-- PROSE-CLAIMS:START',
      '<!-- prose-claims-disabled'
    );
    const report = proseDrift(unscoped);
    expect(kinds(report)).toContain('scope');
    expect(report.checked).toBeLessThan(MINIMUM_FIGURES + 100);
  });

  it('does not police prose outside the covered regions', () => {
    // The installation and dashboard sections carry figures from harnesses this
    // check does not run. Saying so is the point: a check that implied a sweep
    // it does not do would be worse than one with a stated edge.
    const elsewhere = README.replace(
      '## Installation',
      '## Installation\n\nAn uncovered sentence claiming 3.7% of nothing.'
    );
    expect(elsewhere).not.toBe(README);
    expect(proseDrift(elsewhere).faults).toEqual([]);
  });
});
