/**
 * The command a user actually runs.
 *
 * Two of these matter more than the rest. Nothing may be written without --write,
 * because a tool that edits a user's instructions file the first time they ask it to
 * look at something has misunderstood what it was asked. And a third-party plugin
 * that throws on import must not take the pass down with it: the agents that do work
 * still owe the user an answer.
 */
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseArguments, run } from '../../../src/learn/cli.js';
import { BLOCK_START } from '../../../src/learn/report.js';

const PLUGIN_ENV = 'TOKEN_OPTIMIZER_LEARN_PLUGINS';

/** A transcript with one habit in it: the same command failing four times. */
function transcript(cwd: string): string {
  const records: unknown[] = [
    { type: 'user', cwd, timestamp: '2026-09-01T10:00:00.000Z', message: { role: 'user', content: [{ type: 'text', text: 'go' }] } },
  ];
  for (let turn = 0; turn < 4; turn += 1) {
    const id = `t${turn}`;
    records.push({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'gh pr view 7' } }] },
    });
    records.push({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: id, is_error: true, content: [{ type: 'text', text: 'Exit code 1\nfatal: not a git repository' }] }],
      },
    });
  }
  return records.map((record) => JSON.stringify(record)).join('\n') + '\n';
}

describe('parseArguments', () => {
  it('reads the options a user gives', () => {
    const options = parseArguments(['--agent', 'CODEX', '--max-sessions', '5', '--write', '--json']);
    expect(options.agent).toBe('codex');
    expect(options.maxSessions).toBe(5);
    expect(options.write).toBe(true);
    expect(options.json).toBe(true);
  });

  it('treats auto as no agent named', () => {
    expect(parseArguments(['--agent', 'auto']).agent).toBeNull();
  });

  it('refuses a value it cannot use rather than guessing one', () => {
    expect(() => parseArguments(['--since', 'lots'])).toThrow('--since');
    expect(() => parseArguments(['--since', '-3'])).toThrow('--since');
    expect(() => parseArguments(['--max-sessions', '2.5'])).toThrow('--max-sessions');
    expect(() => parseArguments(['--agent'])).toThrow('needs a value');
    expect(() => parseArguments(['--nope'])).toThrow('unknown option: --nope');
  });

  it('defaults to reading, not writing', () => {
    const options = parseArguments([]);
    expect(options.write).toBe(false);
    expect(options.since).toBeNull();
  });
});
describe('run', () => {
  let home = '';
  let project = '';
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'learn-cli-home-'));
    project = mkdtempSync(join(tmpdir(), 'learn-cli-project-'));
    const dir = join(home, '.claude', 'projects', 'encoded-project');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'session-a.jsonl'), transcript(project), 'utf8');
    process.env.TOKEN_OPTIMIZER_CLAUDE_HOME = home;
  });
  afterEach(() => {
    delete process.env.TOKEN_OPTIMIZER_CLAUDE_HOME;
    delete process.env[PLUGIN_ENV];
    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  });

  const claude = (...extra: string[]) => run(['--agent', 'claude', '--project', project, ...extra], {});

  it('prints what it found and writes nothing', async () => {
    const outcome = await claude();
    expect(outcome.exitCode).toBe(0);
    const text = outcome.lines.join('\n');
    expect(text).toContain('`gh pr` failed 4 times');
    expect(existsSync(join(project, 'CLAUDE.md'))).toBe(false);
  });

  it('writes the block only when asked, and says which file it touched', async () => {
    const outcome = await claude('--write');
    expect(outcome.lines.join('\n')).toContain('added a block to CLAUDE.md');
    const written = readFileSync(join(project, 'CLAUDE.md'), 'utf8');
    expect(written).toContain(BLOCK_START);
    expect(written).toContain('`gh pr` failed 4 times');
    const again = await claude('--write');
    expect(again.lines.join('\n')).toContain('CLAUDE.md already said this');
  });

  it('reports a project it has no sessions for instead of inventing one', async () => {
    const elsewhere = mkdtempSync(join(tmpdir(), 'learn-cli-other-'));
    try {
      const outcome = await run(['--agent', 'claude', '--project', elsewhere], {});
      expect(outcome.lines.join('\n')).toContain('no sessions recorded for this project');
      expect(outcome.results).toHaveLength(0);
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it('lists the projects an agent has, and stops there', async () => {
    const outcome = await claude('--projects');
    expect(outcome.lines.join('\n')).toContain(project);
    expect(outcome.results).toHaveLength(0);
  });

  it('prints JSON that parses, for a caller that is not a human', async () => {
    const outcome = await claude('--json');
    expect(outcome.lines).toHaveLength(1);
    const parsed: unknown = JSON.parse(outcome.lines[0] ?? '');
    expect(Array.isArray(parsed)).toBe(true);
  });

  it('answers a usage mistake with the usage, and a non-zero code', async () => {
    const outcome = await run(['--nope'], {});
    expect(outcome.exitCode).toBe(2);
    expect(outcome.lines.join('\n')).toContain('token-optimizer-learn [options]');
    const named = await run(['--agent', 'emacs'], {});
    expect(named.exitCode).toBe(2);
  });

  it('prints the usage for --help and does nothing else', async () => {
    const outcome = await run(['--help'], {});
    expect(outcome.exitCode).toBe(0);
    expect(outcome.lines.join('\n')).toContain('Nothing is written unless --write is given.');
    expect(outcome.results).toHaveLength(0);
  });

  it('reports a broken external plugin without abandoning the working agents', async () => {
    const outcome = await run(['--agent', 'claude', '--project', project], {
      [PLUGIN_ENV]: 'this-module-does-not-exist',
    });
    const text = outcome.lines.join('\n');
    expect(text).toContain('PLUGIN:');
    expect(text).toContain('`gh pr` failed 4 times');
    expect(outcome.exitCode).toBe(0);
  });
});