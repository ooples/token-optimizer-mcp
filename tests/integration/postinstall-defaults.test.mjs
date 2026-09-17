import { test, expect } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { runInNewContext } from 'node:vm';
import * as path from 'node:path';

const source = readFileSync(resolve('scripts/postinstall.cjs'), 'utf8');
function install(env, { fail = false, tty = false } = {}) {
  const calls = [], messages = [];
  const root = resolve('test package with spaces');
  runInNewContext(source, {
    __dirname: join(root, 'scripts'),
    process: { env, execPath: process.execPath, stdout: { isTTY: tty } },
    console: { log: (...args) => messages.push(args.join(' ')), warn: (...args) => messages.push(args.join(' ')) },
    require: (name) => {
      if (name === 'node:path') return path;
      if (name === 'node:child_process') return { execFileSync: (...args) => {
        calls.push(args);
        if (fail) throw Error('fixture installer failure');
      } };
      throw Error(`Unexpected dependency ${name}`);
    },
  });
  return { calls, messages, root };
}

test.each([false, true])('global setup runs with TTY=%s through the packaged Node installer', (tty) => {
  const { calls, root } = install({ npm_config_global: 'true' }, { tty });
  expect(calls).toEqual([[process.execPath, [join(root, 'scripts/install-cli.mjs')], {
    stdio: 'inherit', cwd: root, windowsHide: true,
  }]]);
});

test.each([{ CI: 'true' }, { CI: '1' }, { CONTINUOUS_INTEGRATION: 'true' }, { GITHUB_ACTIONS: 'true' }])('CI remains opt-in for setup: %j', (env) => {
  expect(install({ npm_config_global: 'true', ...env }).calls).toHaveLength(0);
});

test('local installs do not mutate user configuration', () => {
  expect(install({}).calls).toHaveLength(0);
  expect(install({ npm_config_global: 'false' }).calls).toHaveLength(0);
});

test('an explicit false CI flag permits global setup', () => {
  expect(install({ CI: 'false', npm_config_global: 'true' }).calls).toHaveLength(1);
});

test('setup failure reports the recovery command without failing package installation', () => {
  const { messages } = install({ npm_config_global: 'true' }, { fail: true });
  expect(messages.join('\n')).toContain('fixture installer failure');
  expect(messages.join('\n')).toContain('token-optimizer-install');
  expect(messages.join('\n')).not.toContain('commands installed');
});
