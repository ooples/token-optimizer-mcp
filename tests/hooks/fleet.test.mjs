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

import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  discoverProjects, projectCwd, scanProject, transferable, enforcementComparison,
  pareto, renderFleet, slugifyCwd, DEFAULT_LIMIT,
} from '../../hooks-core/fleet.mjs';
import { applyRemedy } from '../../hooks-core/remedy.mjs';
import { canonicalPath } from '../../hooks-core/paths.mjs';

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

// --- scoping, weighting, and reading nothing before consent -------------------------

/**
 * Writes a transcript directly, so a test can control the exact SPELLING of the cwd it
 * reports -- which is the thing the client varies and the thing dedupe has to survive.
 */
function transcriptFor(slug, cwd, { root = join(machine, 'projects'), name = 'session.jsonl' } = {}) {
  const dir = join(root, slug);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, `${JSON.stringify({ type: 'user', cwd, message: { role: 'user', content: 'hi' } })}\n`);
  return path;
}

/** Can this machine make a dangling symlink? Needed to simulate the readdir/stat race. */
const canSymlink = (() => {
  const probe = mkdtempSync(join(tmpdir(), 'fleet-symlink-probe-'));
  try {
    symlinkSync(join(probe, 'does-not-exist'), join(probe, 'link'));
    return true;
  } catch {
    return false;
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
})();

describe('exclusion is matched against the shape the directory actually has', () => {
  test('a pattern spelled as a path excludes the project it names', () => {
    // THE DEFECT: exclude was matched against entry.name, which is the cwd with every
    // non-alphanumeric character replaced by a dash. So every pattern spelled the way a user
    // would spell it could never match, and the project was scanned anyway -- with no
    // diagnostic that the exclusion had not taken.
    const cwd = 'C:\\work\\private';
    transcriptFor(slugifyCwd(cwd), cwd);
    transcriptFor(slugifyCwd('C:\\work\\public'), 'C:\\work\\public');

    const out = discoverProjects({ root: join(machine, 'projects'), exclude: [cwd] });
    expect(out.projects.map((p) => p.slug)).toEqual([slugifyCwd('C:\\work\\public')]);
    expect(out.skipped.find((s) => s.slug === slugifyCwd(cwd)).why).toMatch(/excluded/);
  });

  test('a pattern with an underscore or a dot still matches', () => {
    transcriptFor(slugifyCwd('/src/node_modules/x'), '/src/node_modules/x');
    transcriptFor(slugifyCwd('/src/my.project'), '/src/my.project');
    transcriptFor(slugifyCwd('/src/keep'), '/src/keep');

    const out = discoverProjects({
      root: join(machine, 'projects'), exclude: ['node_modules', 'my.project'],
    });
    expect(out.projects.map((p) => p.slug)).toEqual([slugifyCwd('/src/keep')]);
  });

  test('the literal slug still works, since that is what people copy out of the report', () => {
    project('keep-me', { reads: reads(2, '/a.ts', 100) });
    project('drop-me', { reads: reads(2, '/b.ts', 100) });
    const out = discoverProjects({ root: join(machine, 'projects'), exclude: ['drop-me'] });
    expect(out.projects.map((p) => p.slug)).toEqual(['keep-me']);
  });

  test('an empty pattern excludes nothing rather than everything', () => {
    // '' is a substring of every string, so a stray entry would silently scan zero projects
    // and report them all as deliberately excluded.
    project('keep-me', { reads: reads(2, '/a.ts', 100) });
    const out = discoverProjects({ root: join(machine, 'projects'), exclude: ['', null] });
    expect(out.projects.map((p) => p.slug)).toEqual(['keep-me']);
  });
});

describe('a dry run reads nothing', () => {
  test('resolveCwd: false opens no transcript at all', () => {
    // THE DEFECT: the cwd was resolved during discovery, and resolving it reads 64 KB from the
    // head of the transcript. fleet-tool calls discoverProjects BEFORE it branches on dryRun,
    // so the consent step had already read the head of every transcript on the machine by the
    // time it printed 'Nothing was read'.
    const built = project('proj-a', { reads: reads(2, '/a.ts', 100) });
    const dry = discoverProjects({ root: join(machine, 'projects'), resolveCwd: false });
    expect(dry.projects).toHaveLength(1);
    expect(dry.projects[0].cwd).toBeNull();
    expect(dry.projects[0].slug).toBe('proj-a');

    // and the same call with resolution on does find it, so the null above is the switch
    // working rather than the fixture being unreadable.
    const wet = discoverProjects({ root: join(machine, 'projects') });
    expect(wet.projects[0].cwd).toBe(canonicalPath(built.cwd));
  });

  test('projects beyond the limit are never resolved', () => {
    for (let i = 0; i < 4; i++) project(`p${i}`, { reads: reads(2, '/a.ts', 100) });
    const out = discoverProjects({ root: join(machine, 'projects'), limit: 2 });
    expect(out.projects).toHaveLength(2);
    expect(out.projects.every((p) => p.cwd)).toBe(true);
    expect(out.skipped.filter((s) => /beyond the limit/.test(s.why))).toHaveLength(2);
  });
});

describe('one project is one project however its directory was spelled', () => {
  test('two spellings of the same cwd are scanned once', () => {
    // The client mints one directory per cwd SPELLING, and wikiDir maps every spelling onto the
    // same case-insensitive directory -- so readMetrics returns the SAME event log for each.
    // Undeduped, the project's pareto share multiplies and it contributes that many identical
    // points to whichever arm of the enforcement comparison it lands in.
    transcriptFor('spelling-one', 'C:\\Users\\me\\repo');
    transcriptFor('spelling-two', 'C:/Users/me/repo');

    const out = discoverProjects({ root: join(machine, 'projects') });
    expect(out.projects).toHaveLength(1);
    expect(out.skipped.some((s) => /duplicate of/.test(s.why))).toBe(true);
  });

  test('genuinely different projects are both kept', () => {
    transcriptFor('one', 'C:\\Users\\me\\repo-a');
    transcriptFor('two', 'C:\\Users\\me\\repo-b');
    expect(discoverProjects({ root: join(machine, 'projects') }).projects).toHaveLength(2);
  });
});

(canSymlink ? describe : describe.skip)('a transcript rotated away mid-scan costs only itself', () => {
  test('the project survives, with its remaining transcripts', () => {
    // Transcripts under the discovery root are written and rotated by other live sessions while
    // the scan enumerates them, so a file present at readdirSync can be gone at statSync. The
    // try wrapped the whole per-directory loop, so one such race abandoned the rest of the
    // directory: 'no transcript' for a project that has several, or a stale cwd.
    const built = project('racy', { reads: reads(2, '/a.ts', 100) });
    const dir = join(machine, 'projects', 'racy');
    const dangling = join(dir, 'aaa-rotated.jsonl'); // enumerated before session.jsonl
    symlinkSync(join(dir, 'gone.jsonl'), dangling);

    const out = discoverProjects({ root: join(machine, 'projects') });
    expect(out.projects.map((p) => p.slug)).toEqual(['racy']);
    expect(out.projects[0].cwd).toBe(canonicalPath(built.cwd));
    unlinkSync(dangling);
  });
});

describe('a multi-anchor remedy can transfer', () => {
  const scanFor = (slug, { rules = [], anchors = [] }) => ({ slug, cwd: `/${slug}`, rules, anchors });

  function shared(name, body) {
    const dir = join(machine, 'shared');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, name);
    writeFileSync(path, body);
    return path;
  }

  test('a composite rule transfers when every anchor matches', () => {
    // THE DEFECT: `if (!rule.anchor) continue` skipped every composite rule. remedy.mjs lists
    // composite among the remedy types this product applies itself, and applyRemedy stores those
    // with `anchors` plural and `anchor` undefined -- so they were invisible to transfer
    // analysis, and not reported as skipped either.
    const a = shared('a.ts', 'AAA');
    const b = shared('b.ts', 'BBB');
    const copyDir = join(machine, 'copy');
    mkdirSync(copyDir, { recursive: true });
    writeFileSync(join(copyDir, 'a.ts'), 'AAA');
    writeFileSync(join(copyDir, 'b.ts'), 'BBB');

    const out = transferable([
      scanFor('source', { rules: [{ id: 'composite:1', type: 'composite', anchors: [a, b], why: 'x' }] }),
      scanFor('target', { anchors: [join(copyDir, 'a.ts'), join(copyDir, 'b.ts')] }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].targets.map((t) => t.slug)).toEqual(['target']);
  });

  test('a composite rule does not transfer on a partial match', () => {
    const a = shared('pa.ts', 'AAA');
    const b = shared('pb.ts', 'BBB');
    const copyDir = join(machine, 'partial');
    mkdirSync(copyDir, { recursive: true });
    writeFileSync(join(copyDir, 'pa.ts'), 'AAA');
    writeFileSync(join(copyDir, 'pb.ts'), 'DIFFERENT');

    const out = transferable([
      scanFor('source', { rules: [{ id: 'composite:2', type: 'composite', anchors: [a, b], why: 'x' }] }),
      scanFor('target', { anchors: [join(copyDir, 'pa.ts'), join(copyDir, 'pb.ts')] }),
    ]);
    expect(out).toHaveLength(0);
  });

  test('same name and same length but different bytes does not transfer', () => {
    // The size check added in front of the hash is an optimisation, not a relaxation.
    const a = shared('same-size.ts', 'AAAA');
    const copyDir = join(machine, 'samesize');
    mkdirSync(copyDir, { recursive: true });
    writeFileSync(join(copyDir, 'same-size.ts'), 'BBBB');

    const out = transferable([
      scanFor('source', { rules: [{ id: 'skip:3', type: 'skip', anchor: a, why: 'x' }] }),
      scanFor('target', { anchors: [join(copyDir, 'same-size.ts')] }),
    ]);
    expect(out).toHaveLength(0);
  });
});

describe('the enforcement comparison is pooled over reads', () => {
  const arm = (slug, { reads: n, tokens, enforcing }) => ({
    slug, reads: n, tokens, enforcing, perRead: n ? Math.round(tokens / n) : null,
    rules: [], anchors: [],
  });

  test('a two-read outlier does not decide the fleet result', () => {
    // THE DEFECT: averaging each project's per-read average gave every project equal weight
    // regardless of evidence, so one project with 2 reads counted as much as one with 5,000 --
    // and renderFleet printed the exact inverse of the truth under a heading that calls this the
    // check on the central claim of this product.
    const scans = [
      arm('outlier', { reads: 2, tokens: 300_000, enforcing: true }),
      arm('big-a', { reads: 5_000, tokens: 2_500_000, enforcing: true }),
      arm('big-b', { reads: 4_000, tokens: 1_600_000, enforcing: true }),
      arm('directive', { reads: 3_000, tokens: 2_400_000, enforcing: false }),
    ];

    // What the old unweighted mean reported: enforcing looks ~60x WORSE than directive's 800.
    const unweighted = Math.round((150_000 + 500 + 400) / 3);
    expect(unweighted).toBeGreaterThan(50_000);

    const out = enforcementComparison(scans);
    expect(out.enforcingReads).toBe(9_002);
    expect(out.directiveReads).toBe(3_000);
    expect(out.enforcingPerRead).toBe(Math.round(4_400_000 / 9_002));
    expect(out.enforcingPerRead).toBeLessThan(out.directivePerRead);
  });

  test('the render names the read counts behind each arm', () => {
    const scans = [
      arm('e', { reads: 10, tokens: 1_000, enforcing: true }),
      arm('d', { reads: 20, tokens: 8_000, enforcing: false }),
    ];
    const text = renderFleet({ discovery: { mode: 'enumerate', skipped: [] }, scans });
    expect(text).toMatch(/enforcing {2}100 tokens\/read over 1 project\(s\), 10 read\(s\)/);
    expect(text).toMatch(/directive {2}400 tokens\/read over 1 project\(s\), 20 read\(s\)/);
  });
});
