import { afterAll, beforeAll, describe, expect, test } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HANDOFF_BUDGET, leanHandoff, leanHandoffEnabled } from '../../hooks-core/output-compact.mjs';

const root = mkdtempSync(join(tmpdir(), 'handoff-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** A worker's long report: a conclusion up front, findings with citations, much narration. */
const report = () =>
  [
    'Root cause: Pricing.round_half_even rounds 10.235 down; fixed in pkgs/pricing/pricing/core.py:42.',
    '',
    ...Array.from({ length: 120 }, (_, i) => `I then looked at the surrounding code to understand step ${i} of the flow in more detail.`),
    '- keepConstant is DEFAULT_KEEP_RELEVANT (src/compress/tools.ts:88), value 5',
    ...Array.from({ length: 60 }, (_, i) => `Further narration about what was considered and ruled out, part ${i}.`),
    'Result: 4 passed, 0 failed.',
  ].join('\n');
const agent = (text) => ({ status: 'completed', agentId: 'a1', content: [{ type: 'text', text }], totalTokens: 9000 });

describe('lean handoffs', () => {
  // Opt-in: these tests turn it on, and the off case is checked on its own below.
  const before = process.env.TOKEN_OPTIMIZER_LEAN_HANDOFF;
  beforeAll(() => {
    process.env.TOKEN_OPTIMIZER_LEAN_HANDOFF = '1';
  });
  afterAll(() => {
    if (before === undefined) delete process.env.TOKEN_OPTIMIZER_LEAN_HANDOFF;
    else process.env.TOKEN_OPTIMIZER_LEAN_HANDOFF = before;
  });

  test('off unless turned on', () => {
    expect(leanHandoffEnabled({})).toBe(false);
    expect(leanHandoffEnabled({ TOKEN_OPTIMIZER_LEAN_HANDOFF: '1' })).toBe(true);
  });

  test('a long report keeps its conclusion, citations, figures and verdict; the rest is one Read away', () => {
    const dir = join(root, 'wiki');
    const full = report();
    const out = leanHandoff(agent(full), { dir });
    const text = out.content[0].text;
    expect(text.length).toBeLessThan(HANDOFF_BUDGET + 400);
    expect(text.length).toBeLessThan(full.length / 3);
    expect(text).toContain('Root cause: Pricing.round_half_even');
    expect(text).toContain('src/compress/tools.ts:88');
    expect(text).toContain('Result: 4 passed, 0 failed.');
    const path = text.match(/the full report: Read (\S+)\]$/)[1];
    expect(readFileSync(path, 'utf8')).toBe(full);
    expect(out.agentId).toBe('a1');
  });

  test('a short report and the off switch pass through', () => {
    const dir = join(root, 'wiki2');
    expect(leanHandoff(agent('All four fixed; suite green.'), { dir })).toBeNull();
    // One long paragraph: no line fits the budget, so nothing could be kept.
    expect(leanHandoff(agent('word '.repeat(2000)), { dir })).toBeNull();
    process.env.TOKEN_OPTIMIZER_LEAN_HANDOFF = '0';
    try {
      expect(leanHandoff(agent(report()), { dir })).toBeNull();
    } finally {
      process.env.TOKEN_OPTIMIZER_LEAN_HANDOFF = '1';
    }
  });
});

describe('through the Claude Code PostToolUse hook', () => {
  test('the lead receives the lean report for an Agent call', () => {
    const workspace = mkdtempSync(join(root, 'ws-'));
    mkdirSync(join(workspace, '.git'));
    const r = spawnSync(process.execPath, [join(process.cwd(), 'plugin', 'hooks', 'post-tool.mjs')], {
      cwd: workspace,
      encoding: 'utf8',
      timeout: 30_000,
      env: {
        ...process.env,
        TOKEN_OPTIMIZER_MODE: 'assist',
        TOKEN_OPTIMIZER_STATE_DIR: join(workspace, '.state'),
        TOKEN_OPTIMIZER_WIKI_DIR: join(workspace, '.wiki'),
        TOKEN_OPTIMIZER_SHARED_DIR: join(workspace, '.wiki'),
        TOKEN_OPTIMIZER_UCR_DIR: join(workspace, '.ucr'),
        TOKEN_OPTIMIZER_LEAN_HANDOFF: '1',
      },
      input: JSON.stringify({
        hook_event_name: 'PostToolUse',
        session_id: `ho-${Date.now()}`,
        cwd: workspace,
        tool_name: 'Agent',
        tool_input: { prompt: 'fix pricing' },
        tool_response: agent(report()),
      }),
    });
    const updated = JSON.parse(r.stdout).hookSpecificOutput.updatedToolOutput;
    expect(updated.content[0].text).toMatch(/\[lean handoff: \d+ characters reported/);
  });
});
