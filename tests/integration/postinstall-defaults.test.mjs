import { test, expect } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { runInNewContext } from 'node:vm';
import * as path from 'node:path';

const source = readFileSync(resolve('scripts/postinstall.cjs'), 'utf8');
const HOME = resolve('fake home with spaces');

function install(env, { fail = false, tty = false } = {}) {
  const calls = [],
    messages = [];
  const root = resolve('test package with spaces');
  runInNewContext(source, {
    __dirname: join(root, 'scripts'),
    process: { env, execPath: process.execPath, stdout: { isTTY: tty } },
    console: {
      log: (...args) => messages.push(args.join(' ')),
      warn: (...args) => messages.push(args.join(' ')),
    },
    require: (name) => {
      if (name === 'node:path') return path;
      if (name === 'node:os') return { homedir: () => HOME };
      if (name === 'node:child_process')
        return {
          execFileSync: (...args) => {
            calls.push(args);
            if (fail) throw Error('fixture installer failure');
          },
        };
      throw Error(`Unexpected dependency ${name}`);
    },
  });
  return { calls, messages, root };
}

// THE POINT OF ISSUE #449. Installing a package is not consent to edit another
// application's global configuration, and the hooks this installer writes match
// nearly every tool call in every project on the machine -- including sessions
// already running when the install happened. Nothing here may run the installer
// unless something explicitly asked for it.
test.each([false, true])(
  'a global install changes nothing on its own, TTY=%s',
  (tty) => {
    const { calls, messages } = install({ npm_config_global: 'true' }, { tty });
    expect(calls).toEqual([]);
    const said = messages.join('\n');
    expect(said).toContain('Nothing on your machine has been changed yet');
    expect(said).toContain('token-optimizer-install');
  }
);

test('a global install says where activation would write and how to undo it', () => {
  // A notice that only says "run this command" leaves the user no better off
  // than before: what they wanted to know is which file gets edited.
  const said = install({ npm_config_global: 'true' }).messages.join('\n');
  expect(said).toContain(join(HOME, '.claude', 'settings.json'));
  expect(said).toContain('token-optimizer-uninstall');
  expect(said).toContain('TOKEN_OPTIMIZER_AUTO_INSTALL=1');
});

test('the undo it prints is one that actually undoes anything', () => {
  // uninstall.mjs is a dry run unless --apply is passed: without the flag it
  // prints a plan and changes nothing. Someone told the undo is one word runs
  // it, reads a list of things it "would remove", and walks away believing the
  // machine is unwired. The flag is read out of uninstall.mjs here rather than
  // written down twice, so the notice cannot drift away from the gate.
  const uninstaller = readFileSync(resolve('scripts/uninstall.mjs'), 'utf8');
  expect(uninstaller).toContain("process.argv.includes('--apply')");

  const said = install({ npm_config_global: 'true' }).messages.join('\n');
  expect(said).toContain('token-optimizer-uninstall --apply');
});

test.each([
  [{ CLAUDE_CONFIG_DIR: resolve('elsewhere') }, join(resolve('elsewhere'), 'settings.json')],
  [{ TOKEN_OPTIMIZER_SETTINGS: resolve('exact/place.json') }, resolve('exact/place.json')],
])('the notice names the file this machine would really get: %j', (env, expected) => {
  // It reproduces install-cli.mjs's own expression rather than printing the
  // default path, so a machine that redirects its settings is not told the
  // installer will touch a file it will not touch.
  const said = install({ npm_config_global: 'true', ...env }).messages.join('\n');
  expect(said).toContain(expected);
});

test.each([
  { TOKEN_OPTIMIZER_AUTO_INSTALL: '1' },
  { TOKEN_OPTIMIZER_AUTO_INSTALL: 'true' },
  { TOKEN_OPTIMIZER_AUTO_INSTALL: 'yes' },
])('an explicit request runs the packaged Node installer: %j', (env) => {
  // A POSITIVE CONTROL AS WELL AS A FEATURE. Every assertion above is that
  // `calls` is empty, which a harness that could never record a call would
  // also satisfy. This is the arm that proves the harness can see one.
  const { calls, root } = install({ npm_config_global: 'true', ...env });
  expect(calls).toEqual([
    [
      process.execPath,
      [join(root, 'scripts/install-cli.mjs')],
      { stdio: 'inherit', cwd: root, windowsHide: true },
    ],
  ]);
});

test('a provisioning image may ask for setup even in CI', () => {
  // CI used to be the guard against an unwanted write. It is not needed as one
  // any more -- nothing writes unasked -- and a container image build is
  // exactly the case that does want setup done for it.
  expect(
    install({ CI: 'true', TOKEN_OPTIMIZER_AUTO_INSTALL: '1' }).calls
  ).toHaveLength(1);
});

test.each([
  {},
  { npm_config_global: 'false' },
  { CI: 'true', npm_config_global: 'true' },
  { GITHUB_ACTIONS: 'true', npm_config_global: 'true' },
  { npm_config_global: 'true', TOKEN_OPTIMIZER_AUTO_INSTALL: '0' },
  { npm_config_global: 'true', TOKEN_OPTIMIZER_AUTO_INSTALL: 'false' },
  { npm_config_global: 'true', TOKEN_OPTIMIZER_AUTO_INSTALL: '' },
])('no setup without an explicit request: %j', (env) => {
  expect(install(env).calls).toHaveLength(0);
});

test('a local install says so instead of printing the activation banner', () => {
  const said = install({}).messages.join('\n');
  expect(said).toContain('nothing outside this project was changed');
  expect(said).toContain('token-optimizer-install');
  expect(said).not.toContain('Nothing on your machine has been changed yet');
});

test('requested setup that fails reports the recovery command and does not fail the install', () => {
  const { messages } = install(
    { npm_config_global: 'true', TOKEN_OPTIMIZER_AUTO_INSTALL: '1' },
    { fail: true }
  );
  const said = messages.join('\n');
  expect(said).toContain('fixture installer failure');
  expect(said).toContain('token-optimizer-install');
  expect(said).not.toContain('commands installed');
});