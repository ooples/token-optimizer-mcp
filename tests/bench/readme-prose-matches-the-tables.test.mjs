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
    expect(report.checked).toBe(35);
    expect(report.coveredLines).toBe(180);
  });

  it('declares every figure with a reason of a known kind', () => {
    const known = new Set(Object.values(Source));
    expect(DECLARED.length).toBe(16);
    expect(DECLARED.filter((d) => !known.has(d.kind))).toEqual([]);
    expect(DECLARED.filter((d) => !d.from || !d.anchor)).toEqual([]);
    expect(DECLARED.filter((d) => d.kind === Source.RETRACTED)).toHaveLength(9);
  });
});

describe('control: the check catches the drift it was written for', () => {
  it('catches a prose figure edited away from its table', () => {
    // The exact defect the review found: the table says 97.2%, the sentence
    // restating it says something else.
    const drifted = README.replace(
      'this section -- 97.2%, 97.6%',
      'this section -- 97.3%, 97.6%'
    );
    expect(drifted).not.toBe(README);
    const report = proseDrift(drifted);
    expect(kinds(report)).toEqual(['undeclared']);
    expect(report.faults[0].figure).toBe('97.3%');
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
    const resurrected = README.replace('|  47.4% |  64.9% | ours', '|  61.3% |  64.9% | ours');
    expect(resurrected).not.toBe(README);
    const report = proseDrift(resurrected);
    expect(report.faults.map((f) => f.kind)).toContain('resurrected');
    expect(report.faults.filter((f) => f.figure === '61.3%')).toHaveLength(2);
  });

  it('catches the covered region being removed instead of fixed', () => {
    const unscoped = README.replace('<!-- PROSE-CLAIMS:START', '<!-- prose-claims-disabled');
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
