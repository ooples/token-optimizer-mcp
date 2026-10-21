/**
 * Reduce at the source: Claude Code's SessionStart writes quiet tool defaults
 * to CLAUDE_ENV_FILE, which every later Bash call (subagents included) sources.
 */
import { describe, test, expect, afterAll } from '@jest/globals';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { quietEnvScript, applyQuietEnv, QUIET_ENV_DEFAULTS } from '../../hooks-core/quiet-env.mjs';

const root = mkdtempSync(join(tmpdir(), 'quiet-env-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('quietEnvScript', () => {
  test('exports every absent default and appends -q to PYTEST_ADDOPTS', () => {
    const { script, names } = quietEnvScript({});
    expect(names).toEqual([...Object.keys(QUIET_ENV_DEFAULTS), 'PYTEST_ADDOPTS']);
    expect(script).toContain("export GIT_PAGER='cat'\n");
    expect(script).toContain("export PYTEST_ADDOPTS='-q'\n");
  });

  test('a value the user set wins, and PYTEST_ADDOPTS is augmented, not replaced', () => {
    const { script, names } = quietEnvScript({ GIT_PAGER: 'less', PYTEST_ADDOPTS: "-x -k 'a b'" });
    expect(names).not.toContain('GIT_PAGER');
    expect(script).not.toContain('GIT_PAGER');
    expect(script).toContain(`export PYTEST_ADDOPTS='-x -k '\\''a b'\\'' -q'`);
  });

  test('an existing -q is left alone', () => {
    const { names } = quietEnvScript({ PYTEST_ADDOPTS: '-q -x' });
    expect(names).toContain('GIT_PAGER');
    expect(names).not.toContain('PYTEST_ADDOPTS');
  });

  test('TOKEN_OPTIMIZER_QUIET_ENV=0 turns it off', () => {
    expect(quietEnvScript({ TOKEN_OPTIMIZER_QUIET_ENV: '0' })).toEqual({ script: '', names: [] });
  });

  // Git Bash is what Claude Code's Bash tool runs on Windows; `bash` on PATH there is WSL's.
  const shell = process.platform === 'win32'
    ? [process.env.CLAUDE_CODE_GIT_BASH_PATH, 'C:/Program Files/Git/bin/bash.exe'].find((p) => p && existsSync(p))
    : 'bash';
  (shell ? test : test.skip)('the exports survive a real POSIX shell', () => {
    const file = join(root, 'env.sh');
    writeFileSync(file, '');
    applyQuietEnv({ CLAUDE_ENV_FILE: file, PYTEST_ADDOPTS: "-k 'it''s'" });
    const r = spawnSync(shell, ['-c', `. '${file.replace(/\\/g, '/')}' && printf '%s|%s' "$GIT_PAGER" "$PYTEST_ADDOPTS"`], { encoding: 'utf8' });
    expect(r.stdout).toBe("cat|-k 'it''s' -q");
  });

  test('without CLAUDE_ENV_FILE nothing is written', () => {
    expect(applyQuietEnv({})).toEqual([]);
  });
});

// THE WIRING: the packaged Claude Code SessionStart entry writes the file.
describe('the Claude Code SessionStart hook', () => {
  test('writes the quiet defaults to CLAUDE_ENV_FILE', () => {
    const workspace = mkdtempSync(join(root, 'ws-'));
    mkdirSync(join(workspace, '.git'));
    const envFile = join(workspace, 'session.sh');
    writeFileSync(envFile, '');
    const env = { ...process.env, CLAUDE_ENV_FILE: envFile, TOKEN_OPTIMIZER_MODE: 'assist',
      TOKEN_OPTIMIZER_STATE_DIR: join(workspace, '.state'), TOKEN_OPTIMIZER_WIKI_DIR: join(workspace, '.wiki'),
      TOKEN_OPTIMIZER_SHARED_DIR: join(workspace, '.wiki'), TOKEN_OPTIMIZER_UCR_DIR: join(workspace, '.ucr') };
    delete env.GIT_PAGER;
    delete env.PYTEST_ADDOPTS;
    spawnSync(process.execPath, [join(process.cwd(), 'plugin', 'hooks', 'session-start.mjs')], {
      cwd: workspace, env, encoding: 'utf8', timeout: 30_000,
      input: JSON.stringify({ hook_event_name: 'SessionStart', session_id: `quiet-${Date.now()}`, cwd: workspace, source: 'startup' }),
    });
    const written = readFileSync(envFile, 'utf8');
    expect(written).toContain("export GIT_PAGER='cat'");
    expect(written).toContain("export PYTEST_ADDOPTS='-q'");
  });
});
