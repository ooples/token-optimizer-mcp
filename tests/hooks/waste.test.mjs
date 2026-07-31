/**
 * Behavioural waste: detection, and the ratchet it turns into.
 *
 * The properties under test are the ones a detector-list product cannot have:
 * the expensive patterns are DERIVED from this project rather than enumerated,
 * the question-level detector catches what no command comparison can see, a
 * detection's deliverable is a durable measured fix rather than a line in a
 * report, a fix that has been applied actually bites at the routing decision,
 * detectors carry their own track record without being silently retired, and
 * nothing that belongs to the user is ever changed without a yes.
 */

import { mkdtempSync, rmSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { record, recordRead } from '../../hooks-core/metrics.mjs';
import { detect, derivedDetections, detectorScores } from '../../hooks-core/waste.mjs';
import {
  applyRemedy, revertRemedy, activeRules, measureRemedy, briefing, wasteReport, proposal,
} from '../../hooks-core/remedy.mjs';
import { load, putNode, putEdge, nodeId } from '../../hooks-core/wiki.mjs';
import { indexFile } from '../../hooks-core/staleness.mjs';
import { decide } from '../../hooks-core/decide.mjs';

let workspace;
let dir;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'waste-'));
  // The layout `decide()` will compute for this cwd, so the routing test
  // exercises the real lookup rather than a directory only the test knows.
  dir = join(workspace, '.token-optimizer', 'wiki');
});

afterEach(() => rmSync(workspace, { recursive: true, force: true }));

const graph = () => load(dir);

/** Reads an anchor in a session, at a cost. */
const read = (sessionId, anchor, tokens) => recordRead(dir, { sessionId, anchor, bytes: tokens * 4 });

describe('the command unit catches the literal repeat', () => {
  test('a file read three times in one session reports the waste after the first', () => {
    read('s1', '/a.ts', 1000);
    read('s1', '/a.ts', 1000);
    read('s1', '/a.ts', 1000);

    const hit = detect(dir, null).find((d) => d.id === 're-read');
    // The first read was necessary; everything after it is the waste.
    expect(hit.costPerSession).toBe(2000);
  });

  test('generated and binary files are caught by the shipped floor on day one', () => {
    // No history required -- a fresh install must not be blank.
    read('s1', '/repo/dist/bundle.min.js', 5000);
    const hit = detect(dir, null).find((d) => d.id === 'generated-read');
    expect(hit.remedy.type).toBe('skip');
  });
});

describe('the question unit catches what no command comparison can', () => {
  test('re-reading a file whose answer is already established is re-derivation', () => {
    // Four different commands asking one question share no string, so a command
    // log finds nothing. The graph knows it was answered.
    const path = join(workspace, 'auth.ts');
    writeFileSync(path, 'export function verify() { return 1; }');
    indexFile(dir, path);
    const f = putNode(dir, { kind: 'finding', key: 'f1', confidence: 0.9, claim: 'verify compares exp to the local clock' });
    putEdge(dir, f, 'derived_from', nodeId('file', path));

    read('s1', path, 4000);

    const hit = detect(dir, graph()).find((d) => d.id === 're-derivation');
    expect(hit.unit).toBe('question');
    expect(hit.evidence[0]).toContain('already known');
  });
});

describe('the flow unit names an amount, and says so', () => {
  test('a session far above this project\'s median is flagged', () => {
    for (const s of ['a', 'b', 'c', 'd']) read(s, '/x.ts', 100);
    read('spike', '/x.ts', 9000);

    const hit = detect(dir, null).find((d) => d.id === 'flow-anomaly');
    expect(hit.unit).toBe('flow');
    // Deliberately no remedy: inventing a fix for a spike would be exactly the
    // false confidence this project criticises elsewhere.
    expect(hit.remedy).toBeNull();
  });
});

describe('the expensive detections are derived from THIS project', () => {
  test('a file read in every session that never yielded a finding is waste no rule names', () => {
    for (const s of ['s1', 's2', 's3', 's4']) read(s, '/repo/src/schema.ts', 3000);
    const hit = derivedDetections(dir, graph()).find((d) => d.id === 'barren-anchor');

    expect(hit.derived).toBe(true);
    expect(hit.costPerSession).toBe(3000);
    expect(hit.remedy.type).toBe('skeleton-only');
  });

  test('a file that HAS yielded a finding is not barren, however often it is read', () => {
    const path = join(workspace, 'auth.ts');
    writeFileSync(path, 'export function verify() { return 1; }');
    indexFile(dir, path);
    const f = putNode(dir, { kind: 'finding', key: 'f1', confidence: 0.9, claim: 'something learned' });
    putEdge(dir, f, 'derived_from', nodeId('file', path));
    for (const s of ['s1', 's2', 's3', 's4']) read(s, path, 3000);

    expect(derivedDetections(dir, graph()).some((d) => d.id === 'barren-anchor')).toBe(false);
  });

  test('files never opened apart are proposed as one composite touch', () => {
    for (const s of ['s1', 's2', 's3']) {
      read(s, '/repo/fixtures.ts', 500);
      read(s, '/repo/setup.ts', 500);
    }
    const hit = derivedDetections(dir, graph()).find((d) => d.id === 'co-touched');
    expect(hit.remedy.type).toBe('composite');
  });

  test('nothing is derived before there is enough history to derive from', () => {
    read('s1', '/repo/src/schema.ts', 3000);
    expect(derivedDetections(dir, graph())).toHaveLength(0);
  });
});

describe('a detection becomes a durable fix, not a line in a report', () => {
  test('applying a remedy writes a rule and records its baseline', () => {
    for (const s of ['s1', 's2', 's3']) read(s, '/repo/src/schema.ts', 3000);
    const detection = derivedDetections(dir, graph()).find((d) => d.id === 'barren-anchor');

    const rule = applyRemedy(dir, detection);
    expect(rule.type).toBe('skeleton-only');
    // Everything the report says later is measured against this.
    expect(rule.baselinePerSession).toBe(3000);
    expect(activeRules(dir)).toHaveLength(1);
  });

  test('an applied fix stops being reported as a problem', () => {
    // Continuing to report a solved problem is how a report becomes noise.
    read('s1', '/repo/dist/bundle.min.js', 5000);
    const before = detect(dir, null).find((d) => d.id === 'generated-read');
    applyRemedy(dir, before);
    expect(detect(dir, null).some((d) => d.id === 'generated-read')).toBe(false);
  });

  test('the fix BITES at the routing decision, or it was a report with extra steps', () => {
    const path = join(workspace, 'schema.ts');
    // Over the refusal floor: below it no branch issues a refusal at all,
    // because the message would cost more than the file it replaces.
    writeFileSync(path, 'export type X = 1;\n'.repeat(120));
    for (const s of ['s1', 's2', 's3']) read(s, path, 3000);

    const detection = derivedDetections(dir, graph()).find((d) => d.id === 'barren-anchor');
    applyRemedy(dir, detection);

    const verdict = decide(
      { tool_name: 'Read', tool_input: { file_path: path }, cwd: workspace },
      { seen: {} }
    );
    expect(verdict).not.toBeNull();
    expect(verdict.reason).toMatch(/covered by a fix applied/);
    // And it names the way out, because an unrevertible auto-fix is a trap.
    expect(verdict.reason).toMatch(/revert the rule/);
  });

  test('reverting takes the rule out of force and out of the routing decision', () => {
    const path = join(workspace, 'schema.ts');
    // Over the refusal floor: below it no branch issues a refusal at all,
    // because the message would cost more than the file it replaces.
    writeFileSync(path, 'export type X = 1;\n'.repeat(120));
    for (const s of ['s1', 's2', 's3']) read(s, path, 3000);
    const rule = applyRemedy(dir, derivedDetections(dir, graph()).find((d) => d.id === 'barren-anchor'));

    expect(revertRemedy(dir, rule.id)).toBe(true);
    expect(activeRules(dir)).toHaveLength(0);
    expect(decide({ tool_name: 'Read', tool_input: { file_path: path }, cwd: workspace }, { seen: {} })).toBeNull();
  });
});

describe('a fix reports what it saved, or that it cannot tell yet', () => {
  test('an unmeasurable saving is null rather than a success', () => {
    for (const s of ['s1', 's2', 's3']) read(s, '/repo/src/schema.ts', 3000);
    const rule = applyRemedy(dir, derivedDetections(dir, graph()).find((d) => d.id === 'barren-anchor'));

    const measured = measureRemedy(dir, rule.id);
    expect(measured.savedPerSession).toBeNull();
    expect(measured.reason).toMatch(/not enough sessions/);
  });

  test('once sessions accumulate, the saving is a comparison against the baseline', () => {
    for (const s of ['s1', 's2', 's3']) read(s, '/repo/src/schema.ts', 3000);
    const rule = applyRemedy(dir, derivedDetections(dir, graph()).find((d) => d.id === 'barren-anchor'));

    // Afterwards the same anchor costs almost nothing.
    read('s4', '/repo/src/schema.ts', 100);
    read('s5', '/repo/src/schema.ts', 100);

    expect(measureRemedy(dir, rule.id).savedPerSession).toBe(2900);
  });
});

describe('detectors carry their own track record, and are never silently retired', () => {
  test('a detector measured and found worthless is marked weak, not removed', () => {
    // Removing it is the user's decision; a silent removal would be the same
    // overreach as a silent fix.
    for (const anchor of ['/repo/a.ts', '/repo/b.ts']) {
      for (const s of ['s1', 's2', 's3']) read(s, anchor, 1000);
    }
    for (const detection of derivedDetections(dir, graph()).filter((d) => d.id === 'barren-anchor')) {
      applyRemedy(dir, detection);
    }
    // The fix changed nothing: the same cost continues afterwards.
    for (const anchor of ['/repo/a.ts', '/repo/b.ts']) {
      read('s4', anchor, 1000);
      read('s5', anchor, 1000);
    }

    const scores = detectorScores(dir);
    expect(scores['barren-anchor'].weak).toBe(true);
    expect(scores['barren-anchor'].applied).toBe(2);
  });

  test('a new detector is not branded a failure for being unmeasured', () => {
    for (const s of ['s1', 's2', 's3']) read(s, '/repo/src/schema.ts', 3000);
    applyRemedy(dir, derivedDetections(dir, graph()).find((d) => d.id === 'barren-anchor'));
    expect(detectorScores(dir)['barren-anchor'].weak).toBe(false);
  });
});

describe('what belongs to the user is proposed, never applied', () => {
  test('a remedy that edits the user\'s files is refused by the applier', () => {
    const detection = {
      id: 'cache-breaking-config', title: 'CLAUDE.md embeds a timestamp',
      remedy: { kind: 'yours', type: 'edit', file: 'CLAUDE.md', diff: '-now: 2026-07-30\n' },
    };
    // Silently editing somebody's CLAUDE.md is how a tool gets uninstalled.
    expect(applyRemedy(dir, detection)).toBeNull();
    expect(existsSync(join(dir, 'rules.json'))).toBe(false);
  });

  test('it comes back as a proposal with the diff and no action taken', () => {
    const detection = {
      id: 'cache-breaking-config', title: 'CLAUDE.md embeds a timestamp',
      remedy: { kind: 'yours', type: 'edit', file: 'CLAUDE.md', diff: '-now: 2026-07-30\n' },
    };
    const out = proposal(detection);
    expect(out.diff).toContain('now: 2026-07-30');
    expect(out.apply).toMatch(/nothing has been changed/);
  });
});

describe('the briefing is the cheapest surface, and it is concrete', () => {
  test('no rules means no briefing rather than a generic exhortation', () => {
    expect(briefing(dir)).toBeNull();
  });

  test('it names the actual files, because a fact changes a decision', () => {
    for (const s of ['s1', 's2', 's3']) read(s, '/repo/src/schema.ts', 3000);
    applyRemedy(dir, derivedDetections(dir, graph()).find((d) => d.id === 'barren-anchor'));

    const text = briefing(dir);
    expect(text).toContain('schema.ts');
    // A few dozen tokens: it must never become a second token problem.
    expect(Math.ceil(text.length / 4)).toBeLessThan(120);
  });
});

describe('the report ranks by cost and compares against last week', () => {
  test('the trend is a comparison against the previous window, not a feeling', () => {
    const week = 7 * 24 * 60 * 60 * 1000;
    // A minute ahead, so the freshly recorded read is inside the current window
    // however many milliseconds elapse between here and there. Reading `now`
    // before the write made the boundary a race, and a test that fails on a
    // slow machine is worse than no test.
    const now = Date.now() + 60_000;

    // A read from ten days ago, written directly because `record` stamps the
    // present. The previous window has to actually contain something, or there
    // is no comparison to make and the report correctly says nothing.
    read('s1', '/a.ts', 4000);
    appendFileSync(
      join(dir, 'metrics.jsonl'),
      `${JSON.stringify({ kind: 'read', anchor: '/a.ts', sessionId: 'old', tokens: 1000, at: now - 10 * 24 * 60 * 60 * 1000 })}\n`
    );

    const report = wasteReport(dir, detect(dir, null), { windowMs: week, now });
    expect(report.text).toMatch(/Read spend is \d+% higher than the previous window/);
    expect(report.previous).toBe(1000);
  });

  test('an empty report is null rather than a page saying nothing', () => {
    expect(wasteReport(dir, [])).toBeNull();
  });

  test('a finding with no automatic fix says so instead of inventing one', () => {
    for (const s of ['a', 'b', 'c', 'd']) read(s, '/x.ts', 100);
    read('spike', '/x.ts', 9000);
    const report = wasteReport(dir, detect(dir, null));
    expect(report.text).toMatch(/names an amount, not a thing to stop doing/);
  });
});
