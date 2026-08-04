/**
 * The always-on set, and why it has to stay small.
 *
 * Trigger-fired injection answers "this situation is happening now". Some rules
 * are not about a situation at all -- they govern how every turn is conducted --
 * and by the time a command matched a trigger, a turn governed by such a rule
 * would already be going wrong. Those must arrive before the first tool call.
 *
 * The danger is the opposite one: an always-on block that grows with the project
 * until the model stops reading the thing it always sees. So the qualifying set
 * is narrow and the budget is fixed rather than earned.
 */
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { standingRules } from '../../hooks-core/inject.mjs';
import { load, putNode, wikiDir } from '../../hooks-core/wiki.mjs';
import { spawnSync } from 'child_process';
import { mkdtempSync, rmSync, readFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

let dir;

function seed(props) {
  return putNode(dir, { kind: 'finding', confidence: 0.9, ...props });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'standing-'));
});

afterEach(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* windows can hold a handle briefly */
  }
});

describe('what qualifies', () => {
  it('includes a pinned finding', () => {
    seed({ key: 'p1', claim: 'Build against an isolated worktree, never live WIP.', pinned: true });
    const out = standingRules(dir, load(dir));
    expect(out).toContain('isolated worktree');
  });

  it('includes a human-verified feedback lesson', () => {
    seed({
      key: 'f1',
      claim: 'Report the number you measured, not the one you expected.',
      type: 'feedback',
      origin: 'human',
    });
    expect(standingRules(dir, load(dir))).toContain('Report the number you measured');
  });

  it('excludes a feedback lesson whose quote was never verified', () => {
    // Stored as harvested because the quote could not be found in the archive.
    // A model's paraphrase of a correction is not a standing rule.
    seed({
      key: 'f2',
      claim: 'Prefer the thing the user seemed to want.',
      type: 'feedback',
      origin: 'harvested',
    });
    expect(standingRules(dir, load(dir))).toBeNull();
  });

  it('excludes ordinary findings, which wait for their trigger', () => {
    seed({ key: 'c1', claim: 'Run npm test, not npx jest.', type: 'command', trigger: 'jest' });
    seed({ key: 'm1', claim: 'The harvest builds a digest and calls a model.', type: 'map' });
    expect(standingRules(dir, load(dir))).toBeNull();
  });

  it('excludes a retired rule even if it was pinned', () => {
    // Retirement is how a person withdraws a claim. The always-on block is the
    // first thing read, so a withdrawn rule appearing there is the worst place
    // for it to survive.
    seed({ key: 'p2', claim: 'An old rule.', pinned: true, retired: true });
    expect(standingRules(dir, load(dir))).toBeNull();
  });
});

describe('ordering', () => {
  it("puts a person's own correction above an inferred pin", () => {
    seed({ key: 'pin', claim: 'PINNED RULE', pinned: true, confidence: 0.99 });
    seed({
      key: 'human',
      claim: 'HUMAN RULE',
      type: 'feedback',
      origin: 'human',
      confidence: 0.9,
    });

    const out = standingRules(dir, load(dir));
    expect(out.indexOf('HUMAN RULE')).toBeLessThan(out.indexOf('PINNED RULE'));
  });
});

describe('the budget', () => {
  it('never exceeds it, and says how many were dropped', () => {
    for (let i = 0; i < 40; i++) {
      seed({ key: `p${i}`, claim: `Rule number ${i}: ${'x'.repeat(120)}`, pinned: true });
    }

    const out = standingRules(dir, load(dir), { budget: 200 });
    expect(out).toBeTruthy();
    // A silent cap reads as "these are all the rules", which is worse than
    // admitting the list is truncated.
    expect(out).toMatch(/further standing rule/);
    expect(out).toMatch(/TOKEN_OPTIMIZER_STANDING_BUDGET/);
    // Roughly within budget: 4 chars per token, plus the truncation notice.
    expect(out.length).toBeLessThan(200 * 4 + 400);
  });

  it('says nothing at all when there are no standing rules', () => {
    seed({ key: 'x', claim: 'ordinary', type: 'command' });
    expect(standingRules(dir, load(dir))).toBeNull();
  });

  it('records what the always-on block cost, so it can be judged later', () => {
    seed({ key: 'p1', claim: 'A pinned rule that costs tokens every session.', pinned: true });
    standingRules(dir, load(dir));

    const rows = readFileSync(join(dir, 'metrics.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .filter((r) => r.kind === 'standing');

    expect(rows).toHaveLength(1);
    expect(rows[0].count).toBe(1);
    expect(rows[0].tokens).toBeGreaterThan(0);
  });
});

describe('through the real SessionStart hook', () => {
  it('delivers standing rules alongside the policy notice, and nothing else', () => {
    // The unit tests prove the selection. This proves the hook actually emits
    // it -- the distinction that mattered for forTouch, which was correct and
    // called by nothing for its entire life.
    const project = mkdtempSync(join(tmpdir(), 'standing-e2e-'));
    mkdirSync(join(project, '.git'), { recursive: true });
    const graphDir = wikiDir(project);

    putNode(graphDir, {
      kind: 'finding', key: 'h1', type: 'feedback', origin: 'human', confidence: 0.95,
      claim: 'Report the number you measured, not the one you expected.',
    });
    putNode(graphDir, {
      kind: 'finding', key: 'p1', pinned: true, confidence: 0.9,
      claim: 'Build against an isolated worktree, never live WIP.',
    });
    putNode(graphDir, {
      kind: 'finding', key: 'c1', type: 'command', trigger: 'jest', confidence: 0.95,
      claim: 'Run npm test, not npx jest.',
    });

    const r = spawnSync(process.execPath, [join(process.cwd(), 'plugin', 'hooks', 'session-start.mjs')], {
      input: '{}',
      encoding: 'utf8',
      timeout: 30_000,
      env: { ...process.env, TOKEN_OPTIMIZER_WIKI_DIR: graphDir, CLAUDE_PROJECT_DIR: project },
    });

    const ctx = JSON.parse(r.stdout || '{}')?.hookSpecificOutput?.additionalContext || '';
    expect(ctx).toContain('# Standing rules');
    expect(ctx).toContain('Report the number you measured');
    expect(ctx).toContain('isolated worktree');
    // A situational finding must NOT be in the always-on block; it waits for
    // its trigger, which is the whole reason the always-on set can stay small.
    expect(ctx).not.toContain('npx jest');

    try { rmSync(project, { recursive: true, force: true }); } catch { /* windows */ }
  });
});
