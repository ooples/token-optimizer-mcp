/**
 * Short agent prompts (#567): with an approved agent brief, the session is told
 * once at start that its agents already get the rules and the paths, so the
 * parent stops restating them in every prompt -- output it pays for at 5x.
 * Without a brief the line would be false, so it is never said.
 */
import { describe, expect, test } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = join(fileURLToPath(import.meta.url), '..', '..', '..');
const LINE = "Agents you start receive the user's approved rules";

function sessionStart({ brief, extra = {} }) {
  const root = mkdtempSync(join(tmpdir(), 'brief-start-'));
  const home = join(root, 'home');
  const project = join(root, 'project');
  mkdirSync(home, { recursive: true });
  mkdirSync(project, { recursive: true });
  if (brief) writeFileSync(join(home, 'agent-brief.md'), '## Rules\n- Never push to main.\n');
  const result = spawnSync(process.execPath, [join(repo, 'src', 'plugin', 'hooks', 'session-start.mjs')], {
    input: JSON.stringify({ hook_event_name: 'SessionStart', session_id: 's1', cwd: project, source: 'startup' }),
    encoding: 'utf8',
    timeout: 30_000,
    env: {
      ...process.env,
      TOKEN_OPTIMIZER_HOME: home,
      TOKEN_OPTIMIZER_STATE_DIR: join(root, 'state'),
      TOKEN_OPTIMIZER_WIKI_DIR: join(root, 'graph'),
      TOKEN_OPTIMIZER_SHARED_DIR: join(root, 'graph'),
      CLAUDE_CONFIG_DIR: join(root, 'claude'),
      TOKEN_OPTIMIZER_MODE: 'assist',
      TOKEN_OPTIMIZER_EXPERIMENT_ARM: '',
      TOKEN_OPTIMIZER_HOLDOUT: 'off',
      ...extra,
    },
  });
  return result.stdout;
}

describe('the short-prompts line at session start', () => {
  test('is said when a brief is approved', () => {
    expect(sessionStart({ brief: true })).toContain(LINE);
  });

  test('is not said when switched off', () => {
    const out = sessionStart({ brief: true, extra: { TOKEN_OPTIMIZER_AGENT_BRIEF_NOTICE: 'off' } });
    expect(out.length).toBeGreaterThan(0);
    expect(out).not.toContain(LINE);
  });

  test('is never said without one', () => {
    const out = sessionStart({ brief: false });
    // the control: the hook did speak, just not this line
    expect(out.length).toBeGreaterThan(0);
    expect(out).not.toContain(LINE);
  });
});
