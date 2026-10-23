/**
 * Reduce at the source: Claude Code's SessionStart writes quiet tool defaults
 * to CLAUDE_ENV_FILE, which every later Bash call (subagents included) sources.
 */
import { describe, test, expect, afterAll } from '@jest/globals';
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  quietEnvScript,
  applyQuietEnv,
  QUIET_ENV_DEFAULTS,
  QUIET_ENV_MARKER,
} from '../../hooks-core/quiet-env.mjs';

const root = mkdtempSync(join(tmpdir(), 'quiet-env-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('quietEnvScript', () => {
  test('guards every absent default in the sourcing shell', () => {
    const { script, names } = quietEnvScript({});
    expect(names).toEqual([
      ...Object.keys(QUIET_ENV_DEFAULTS),
      'PYTEST_ADDOPTS',
    ]);
    expect(script).toContain(
      `[ -n "\${GIT_PAGER+x}" ] || export GIT_PAGER='cat'\n`
    );
    expect(script).toContain('*" -q "*) ;;');
  });

  test('a value set in this process is skipped up front', () => {
    const { script, names } = quietEnvScript({ GIT_PAGER: 'less' });
    expect(names).toContain('PIP_QUIET');
    expect(names).not.toContain('GIT_PAGER');
    expect(script).not.toContain('GIT_PAGER');
  });

  test('TOKEN_OPTIMIZER_QUIET_ENV=0 turns it off', () => {
    expect(quietEnvScript({ TOKEN_OPTIMIZER_QUIET_ENV: '0' })).toEqual({
      script: '',
      names: [],
    });
  });

  // Git Bash is what Claude Code's Bash tool runs on Windows; `bash` on PATH there is WSL's.
  const shell =
    process.platform === 'win32'
      ? [
          process.env.CLAUDE_CODE_GIT_BASH_PATH,
          'C:/Program Files/Git/bin/bash.exe',
        ].find((p) => p && existsSync(p))
      : 'bash';
  (shell ? test : test.skip)(
    'in a real POSIX shell: defaults apply, the shell’s own values win, -q is appended once',
    () => {
      const file = join(root, 'env.sh');
      writeFileSync(file, '');
      applyQuietEnv({ CLAUDE_ENV_FILE: file });
      const run = (pre) =>
        spawnSync(
          shell,
          [
            '-c',
            `${pre} . '${file.replace(/\\/g, '/')}' && printf '%s|%s|%s' "$GIT_PAGER" "$PIP_QUIET" "$PYTEST_ADDOPTS"`,
          ],
          { encoding: 'utf8' }
        ).stdout;
      expect(run('unset GIT_PAGER PIP_QUIET PYTEST_ADDOPTS;')).toBe('cat|1|-q');
      // Set only in the sourcing shell (a profile export the hook never saw).
      expect(run("export GIT_PAGER=less PYTEST_ADDOPTS='-x';")).toBe(
        'less|1|-x -q'
      );
      expect(run("export PYTEST_ADDOPTS='-q -x';")).toMatch(/\|-q -x$/);
    }
  );

  test('a repeated SessionStart does not append a second block', () => {
    const file = join(root, 'env-twice.sh');
    writeFileSync(file, '');
    expect(applyQuietEnv({ CLAUDE_ENV_FILE: file }).length).toBeGreaterThan(0);
    expect(applyQuietEnv({ CLAUDE_ENV_FILE: file })).toEqual([]);
    expect(readFileSync(file, 'utf8').split(QUIET_ENV_MARKER).length).toBe(2);
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
    const env = {
      ...process.env,
      CLAUDE_ENV_FILE: envFile,
      TOKEN_OPTIMIZER_MODE: 'assist',
      TOKEN_OPTIMIZER_STATE_DIR: join(workspace, '.state'),
      TOKEN_OPTIMIZER_WIKI_DIR: join(workspace, '.wiki'),
      TOKEN_OPTIMIZER_SHARED_DIR: join(workspace, '.wiki'),
      TOKEN_OPTIMIZER_UCR_DIR: join(workspace, '.ucr'),
    };
    delete env.GIT_PAGER;
    delete env.PYTEST_ADDOPTS;
    spawnSync(
      process.execPath,
      [join(process.cwd(), 'plugin', 'hooks', 'session-start.mjs')],
      {
        cwd: workspace,
        env,
        encoding: 'utf8',
        timeout: 30_000,
        input: JSON.stringify({
          hook_event_name: 'SessionStart',
          session_id: `quiet-${Date.now()}`,
          cwd: workspace,
          source: 'startup',
        }),
      }
    );
    const written = readFileSync(envFile, 'utf8');
    expect(written).toContain(QUIET_ENV_MARKER);
    expect(written).toContain("export GIT_PAGER='cat'");
    expect(written).toContain('-q');
  });
});
