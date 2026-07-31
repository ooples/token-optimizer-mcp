/**
 * The fleet auditor.
 *
 * The properties under test are the ones a per-project scanner cannot have: a
 * fix proven in one project is offered to the others holding the SAME BYTES,
 * the fleet is ranked as a Pareto rather than listed, enforcement is measured
 * from evidence rather than read from configuration, the enforcing-versus-
 * directive comparison is reported with its confound rather than as a result,
 * and the scan says what it read and reads nothing it was not asked to.
 */

import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  discoverProjects, projectCwd, scanProject, transferable, enforcementComparison,
  pareto, renderFleet, DEFAULT_LIMIT,
} from '../../hooks-core/fleet.mjs';
import { applyRemedy } from '../../hooks-core/remedy.mjs';

let machine;

beforeEach(() => { machine = mkdtempSync(join(tmpdir(), 'fleet-')); });
afterEach(() => rmSync(machine, { recursive: true, force: true }));

/**
 * Builds a project: a working directory, a graph with metrics, and a transcript
 * under the discovery root that points back at it.
 */
function project(slug, {
  reads = [], substitutions = 0, sharedFile = null, transcriptRoot = join(machine, 'projects'),
} = {}) {
  const cwd = join(machine, slug);
  const wiki = join(cwd, '.token-optimizer', 'wiki');
  mkdirSync(wiki, { recursive: true });

  if (sharedFile) {
    mkdirSync(join(cwd, 'vendor'), { recursive: true });
    writeFileSync(join(cwd, 'vendor', 'protobuf.d.ts'), sharedFile);
  }

  const now = Date.now();
  const rows = reads.map((read, i) => JSON.stringify({
    kind: 'read', anchor: read.anchor.split('\\').join('/'), sessionId: read.session,
    tokens: read.tokens, at: now - (reads.length - i) * 1000,
  }));
  for (let i = 0; i < substitutions; i++) {
    rows.push(JSON.stringify({ kind: 'substitute', anchor: '/x.ts', tokens: 100, at: now }));
  }
  if (rows.length) writeFileSync(join(wiki, 'metrics.jsonl'), `${rows.join('\n')}\n`);

  const dir = join(transcriptRoot, slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'session.jsonl'),
    `${JSON.stringify({ type: 'user', cwd, message: { role: 'user', content: 'hi' } })}\n`);

  return { slug, cwd, wiki, transcript: join(dir, 'session.jsonl') };
}

const reads = (n, anchor, tokens, sessions = 3) =>
  Array.from({ length: n }, (_, i) => ({ anchor, tokens, session: `s${i % sessions}` }));

describe('discovery reads only what it was asked to', () => {
  test('the project directory comes from the transcript, not from the slug', () => {
    // Un-mangling the slug is lossy: every non-alphanumeric character becomes a
    // dash, so two different paths can produce the same one.
    const built = project('proj-a', { reads: reads(3, '/a.ts', 100) });
    expect(projectCwd(built.transcript)).toBe(built.cwd);
  });

  test('explicit mode discovers nothing at all', () => {
    project('proj-a');
    const out = discoverProjects({ mode: 'explicit', only: [join(machine, 'named')], root: join(machine, 'projects') });
    expect(out.projects).toHaveLength(1);
    expect(out.projects[0].transcript).toBeNull();
  });

  test('enumerate mode reports what it skipped and why', () => {
    project('keep-me', { reads: reads(2, '/a.ts', 100) });
    project('skip-me', { reads: reads(2, '/b.ts', 100) });

    const out = discoverProjects({ root: join(machine, 'projects'), exclude: ['skip-me'] });
    expect(out.projects.map((p) => p.slug)).toEqual(['keep-me']);
    expect(out.skipped[0].why).toMatch(/excluded by pattern/);
  });

  test('a directory with no transcript is skipped and named', () => {
    mkdirSync(join(machine, 'projects', 'empty'), { recursive: true });
    const out = discoverProjects({ root: join(machine, 'projects') });
    expect(out.skipped.find((s) => s.slug === 'empty').why).toBe('no transcript');
  });

  test('enumerate stops at the limit and says how many it left', () => {
    for (let i = 0; i < 4; i++) project(`p${i}`, { reads: reads(2, '/a.ts', 100) });
    const out = discoverProjects({ root: join(machine, 'projects'), limit: 2 });
    expect(out.projects).toHaveLength(2);
    expect(out.skipped.filter((s) => s.why.includes('beyond the limit'))).toHaveLength(2);
  });

  test('all mode takes the cap off', () => {
    for (let i = 0; i < 4; i++) project(`p${i}`, { reads: reads(2, '/a.ts', 100) });
    expect(discoverProjects({ mode: 'all', root: join(machine, 'projects'), limit: 2 }).projects).toHaveLength(4);
  });

  test('a missing transcript root is a reason, not a crash', () => {
    const out = discoverProjects({ root: join(machine, 'nowhere') });
    expect(out.projects).toEqual([]);
    expect(out.reason).toMatch(/no transcript directory/);
  });

  test('the default limit is a real bound, not unlimited', () => {
    expect(DEFAULT_LIMIT).toBeGreaterThan(0);
    expect(Number.isFinite(DEFAULT_LIMIT)).toBe(true);
  });
});

describe('enforcement is measured, not read from configuration', () => {
  test('a project with substitutions is evidence the veto is live', () => {
    // A substitution only exists where a refusal actually replaced a read.
    const built = project('enforced', { reads: reads(6, '/a.ts', 900), substitutions: 4 });
    const scan = scanProject({ ...built, transcript: built.transcript });
    expect(scan.enforcing).toBe(true);
  });

  test('a project with only reads is not claimed as enforcing', () => {
    const built = project('advised', { reads: reads(6, '/a.ts', 900) });
    expect(scanProject(built).enforcing).toBe(false);
  });

  test('a project with no graph scans to zeroes rather than failing', () => {
    const scan = scanProject({ slug: 'bare', cwd: join(machine, 'bare'), transcript: null });
    expect(scan.hasGraph).toBe(false);
    expect(scan.perSession).toBeNull();
  });
});

describe('the fleet is a Pareto, because the money is concentrated', () => {
  test('projects are ranked by cost per session with their share', () => {
    const scans = [
      scanProject(project('cheap', { reads: reads(3, '/a.ts', 100) })),
      scanProject(project('expensive', { reads: reads(3, '/b.ts', 9000) })),
    ];
    const ranked = pareto(scans);

    expect(ranked[0].slug).toBe('expensive');
    expect(ranked[0].share).toBeGreaterThan(0.9);
  });

  test('projects with no measured history are left out rather than shown as free', () => {
    const scans = [scanProject(project('quiet'))];
    expect(pareto(scans)).toHaveLength(0);
  });
});

describe('a fix proven in one project transfers to the others holding the same bytes', () => {
  /** Two projects containing an identical vendored file, one with a rule for it. */
  function pair(sameContents = true) {
    const a = project('proj-a', { sharedFile: 'export type Wire = 1;\n' });
    const b = project('proj-b', { sharedFile: sameContents ? 'export type Wire = 1;\n' : 'different bytes entirely\n' });

    const anchorA = join(a.cwd, 'vendor', 'protobuf.d.ts');
    const anchorB = join(b.cwd, 'vendor', 'protobuf.d.ts');

    // b has read the file; a has a rule about it.
    writeFileSync(join(b.wiki, 'metrics.jsonl'),
      `${JSON.stringify({ kind: 'read', anchor: anchorB.split('\\').join('/'), sessionId: 's1', tokens: 3000, at: Date.now() })}\n`);
    applyRemedy(a.wiki, {
      id: 'barren-anchor', title: 'never repaid a read', costPerSession: 3400,
      remedy: { kind: 'ours', type: 'skeleton-only', anchor: anchorA, why: 'never repaid a read' },
    });

    return [scanProject(a), scanProject(b)];
  }

  test('identical contents in another project make the fix transferable', () => {
    // The graph anchors by content, so a vendored file is the same anchor in
    // every repository that contains it.
    const moves = transferable(pair(true));
    expect(moves).toHaveLength(1);
    expect(moves[0].provenIn).toBe('proj-a');
    expect(moves[0].targets[0].slug).toBe('proj-b');
  });

  test('the same NAME with different contents does not transfer', () => {
    // Matching on filename alone would push a fix onto a file that merely
    // shares a name, which is how a fleet feature becomes a liability.
    expect(transferable(pair(false))).toHaveLength(0);
  });

  test('the evidence travels with the offer', () => {
    expect(transferable(pair(true))[0].measured).toBe(3400);
  });

  test('a project that already has the rule is not offered it again', () => {
    const scans = pair(true);
    scans[1].rules = scans[0].rules;
    expect(transferable(scans)).toHaveLength(0);
  });
});

describe('the natural experiment is reported with its confound', () => {
  test('with both kinds present, the comparison is made', () => {
    const scans = [
      scanProject(project('enforced', { reads: reads(6, '/a.ts', 1000), substitutions: 3 })),
      scanProject(project('advised', { reads: reads(6, '/b.ts', 5000) })),
    ];
    const out = enforcementComparison(scans);

    expect(out.comparable).toBe(true);
    expect(out.enforcingPerRead).toBeLessThan(out.directivePerRead);
    // Stating the confound is what separates evidence from marketing.
    expect(out.caveat).toMatch(/suggestive, not causal/);
    expect(out.caveat).toMatch(/holdout arm is the causal measurement/);
  });

  test('one-sided fleets report that they cannot compare, rather than comparing', () => {
    const scans = [scanProject(project('only-one', { reads: reads(6, '/a.ts', 1000), substitutions: 3 }))];
    const out = enforcementComparison(scans);
    expect(out.comparable).toBe(false);
    expect(out.reason).toMatch(/need projects of both kinds/);
  });
});

describe('the scan accounts for what it opened', () => {
  test('the report states the mode, the count and that nothing left the machine', () => {
    const discovery = discoverProjects({ root: join(machine, 'projects') });
    const text = renderFleet({ discovery, scans: [] });

    expect(text).toMatch(/Scanned 0 project\(s\) in "enumerate" mode/);
    expect(text).toMatch(/nothing left this machine/);
  });

  test('a full report ranks, offers transfers and states the comparison', () => {
    const a = project('proj-a', { reads: reads(6, '/a.ts', 4000), substitutions: 2, sharedFile: 'shared\n' });
    const b = project('proj-b', { reads: reads(6, '/b.ts', 900) });
    applyRemedy(a.wiki, {
      id: 'barren-anchor', title: 'never repaid a read', costPerSession: 3400,
      remedy: { kind: 'ours', type: 'skeleton-only', anchor: join(a.cwd, 'vendor', 'protobuf.d.ts'), why: 'never repaid' },
    });

    const discovery = discoverProjects({ root: join(machine, 'projects') });
    const scans = [scanProject(a), scanProject(b)];
    const text = renderFleet({ discovery, scans });

    expect(text).toMatch(/Where the cost is:/);
    expect(text).toMatch(/\[enforcing\]/);
    expect(text).toMatch(/Enforcing vs directive/);
  });
});
