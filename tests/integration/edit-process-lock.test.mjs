import { afterEach, expect, it } from '@jest/globals';
import { spawn } from 'node:child_process';
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const moduleUrl =
  process.env.TOKEN_OPTIMIZER_TEST_REPLACE_FILE_URL ??
  new URL('../../dist/utils/replace-file.js', import.meta.url).href;
const children = [];
const roots = [];
const worker = `
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
const input = JSON.parse(process.argv[1]);
if (input.pause) {
  const rename = fs.rename;
  fs.rename = async (...args) => {
    process.send({ event: 'ready' });
    await new Promise(resolve => process.once('message', resolve));
    return rename(...args);
  };
  syncBuiltinESMExports();
}
try {
  const { replaceFile } = await import(input.moduleUrl);
  await replaceFile(input.target, input.content, 'utf8', 'original');
  process.send({ event: 'result', success: true });
} catch (error) {
  process.send({ event: 'result', success: false, error: error.message });
}
process.disconnect();
`;

function start(target, content, pause = false) {
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      worker,
      JSON.stringify({ moduleUrl, target, content, pause }),
    ],
    {
      cwd: fileURLToPath(new URL('../..', import.meta.url)),
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      windowsHide: true,
    }
  );
  children.push(child);
  return child;
}
function message(child) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Child did not report its edit outcome')),
      10000
    );
    child.once('message', (value) => {
      clearTimeout(timer);
      resolve(value);
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'edit-process-lock-'));
  roots.push(root);
  const target = join(root, 'file.txt');
  writeFileSync(target, 'original');
  return { root, target };
}
async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve) => {
    child.once('exit', resolve);
    child.kill();
  });
}
afterEach(async () => {
  await Promise.all(children.splice(0).map(stop));
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

it('excludes a separate process during the final verification/rename gap', async () => {
  const { root, target } = fixture();
  const owner = start(target, 'first edit', true);
  expect(await message(owner)).toEqual({ event: 'ready' });
  const contender = start(target, 'second edit', true);
  expect(await message(contender)).toMatchObject({
    event: 'result',
    success: false,
    error: expect.stringContaining('Another edit holds'),
  });
  expect(readFileSync(target, 'utf8')).toBe('original');
  const committed = message(owner);
  owner.send('commit');
  expect(await committed).toMatchObject({ success: true });
  expect(readFileSync(target, 'utf8')).toBe('first edit');
  const stale = start(target, 'stale edit');
  expect(await message(stale)).toMatchObject({
    success: false,
    error: expect.stringContaining('File changed'),
  });
  expect(readFileSync(target, 'utf8')).toBe('first edit');
  expect(readdirSync(root)).toEqual(['file.txt']);
}, 20000);

it('fails closed after an owner dies without stealing its abandoned lock', async () => {
  const { root, target } = fixture();
  const owner = start(target, 'never committed', true);
  expect(await message(owner)).toEqual({ event: 'ready' });
  await stop(owner);
  const contender = start(target, 'replacement');
  expect(await message(contender)).toMatchObject({
    success: false,
    error: expect.stringContaining('abandoned lock'),
  });
  expect(readFileSync(target, 'utf8')).toBe('original');
  expect(
    readdirSync(root).filter((name) => name.endsWith('.lock'))
  ).toHaveLength(1);
}, 20000);
