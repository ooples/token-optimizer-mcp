import { afterAll, beforeAll, expect, test } from '@jest/globals';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import ts from 'typescript';
import { pathToFileURL } from 'node:url';

const work = mkdtempSync(join(tmpdir(), 'cli-dispatch-review-'));
const server = join(work, 'dist/server');
const scripts = join(work, 'scripts');
const marker = join(work, 'server-imported');
const entry = join(server, 'index.js');
beforeAll(() => {
  mkdirSync(server, { recursive: true });
  mkdirSync(scripts);
  writeFileSync(join(work, 'package.json'), JSON.stringify({ type: 'module', version: '7.8.0' }));
  for (const name of ['index', 'cli-dispatch', 'plugin-instructions']) {
    const source = readFileSync(join(process.cwd(), `src/server/${name}.ts`), 'utf8');
    writeFileSync(join(server, `${name}.js`), ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText);
  }
  writeFileSync(join(server, 'mcp-server.js'), `import{writeFileSync}from'node:fs';writeFileSync(${JSON.stringify(marker)},'imported');`);
});
afterAll(() => rmSync(work, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }));

test('help and version flush output without loading database-backed server modules', () => {
  for (const [arg, expected] of [['--version', '7.8.0\n'], ['--help', 'Usage:']]) {
    const result = spawnSync(process.execPath, [entry, arg], { encoding: 'utf8', windowsHide: true });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(expected);
    expect(result.stderr).toBe('');
    expect(existsSync(marker)).toBe(false);
  }
});

test('dispatch forwards arguments and preserves the child failure status', () => {
  writeFileSync(join(scripts, 'doctor.mjs'), "console.log(JSON.stringify(process.argv.slice(2)));process.exitCode=7;");
  const result = spawnSync(process.execPath, [entry, 'doctor', '--fixture'], { encoding: 'utf8', windowsHide: true });
  expect(result.status).toBe(7);
  expect(JSON.parse(result.stdout)).toEqual(['--fixture']);
  expect(existsSync(marker)).toBe(false);
});

test('a signal-terminated child is a failed dispatch', () => {
  writeFileSync(join(scripts, 'doctor.mjs'), "process.kill(process.pid,'SIGTERM');");
  const result = spawnSync(process.execPath, [entry, 'doctor'], { encoding: 'utf8', windowsHide: true });
  expect(result.status).not.toBe(0);
});

test('the default invocation still starts the server', () => {
  const result = spawnSync(process.execPath, [entry], { encoding: 'utf8', windowsHide: true });
  expect(result.status).toBe(0);
  expect(existsSync(marker)).toBe(true);
});

const signalTest = process.platform === 'win32' ? test.skip : test;
signalTest('termination reaches the run child so it can clean up', async () => {
  const ready = join(work, 'ready');
  const cleaned = join(work, 'cleaned');
  writeFileSync(join(scripts, 'run-client.mjs'), "import{writeFileSync}from'node:fs';process.on('SIGTERM',()=>{writeFileSync(process.env.REVIEW_CLEANED,'yes');process.exit(0)});writeFileSync(process.env.REVIEW_READY,'yes');setInterval(()=>{},1000);");
  const child = spawn(process.execPath, [entry, 'run', 'fixture'], { stdio: 'ignore', env: { ...process.env, REVIEW_READY: ready, REVIEW_CLEANED: cleaned } });
  const exited = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  try {
    const deadline = Date.now() + 5000;
    while (!existsSync(ready) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(existsSync(ready)).toBe(true);
    child.kill('SIGTERM');
    expect(await exited).toBe(0);
    expect(existsSync(cleaned)).toBe(true);
  } finally { child.kill('SIGKILL'); }
}, 10000);

test('the package entry retains both public instruction exports', () => {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', "process.argv.push('--help'); const entry = await import(process.env.REVIEW_ENTRY); if (typeof entry.instructionsFor !== 'function' || typeof entry.PLUGIN_INSTRUCTIONS !== 'string' || entry.instructionsFor({CLAUDE_PLUGIN_ROOT:'plugin'}) !== entry.PLUGIN_INSTRUCTIONS) process.exitCode=1;"], { encoding: 'utf8', windowsHide: true, env: { ...process.env, REVIEW_ENTRY: pathToFileURL(entry).href } });
  expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' });
});

