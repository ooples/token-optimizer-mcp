import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, dirname } from 'node:path';
const exec = promisify(execFile);
export async function provenance(root, codex, python, proxyBin) {
  const version = async (command, args) => {
    try {
      return (
        await exec(command, args, {
          cwd: root,
          timeout: 30000,
          windowsHide: true,
        })
      ).stdout.trim();
    } catch (error) {
      return { error: String(error.message) };
    }
  };
  const files = [
    ...[
      'dist/server/index.js',
      'dist/server/tool-profile.js',
      'dist/tools/file-operations/smart-read.js',
    ].map((name) => join(root, name)),
    'bench/live/codex.mjs',
    'bench/live/codex-workflows.mjs',
    'bench/live/codex-mcp-evidence.mjs',
    'bench/live/report-codex.mjs',
    ...[
      'cli.js',
      'server.js',
      'responses.js',
      'accounting.js',
      'capture.js',
    ].map((name) => join(dirname(proxyBin), name)),
    ...[
      'router.js',
      'tap.js',
      'json-fragments.js',
      'json.js',
      'json-facts.js',
    ].map((name) => join(dirname(proxyBin), '../compress', name)),
  ];
  const sha256 = {};
  for (const name of files) {
    const path = name.startsWith('bench/') ? join(root, name) : name;
    try {
      sha256[name] = createHash('sha256')
        .update(await readFile(path))
        .digest('hex');
    } catch {
      sha256[name] = null;
    }
  }
  const [client, competitor, gitHead] = await Promise.all([
    version(
      codex.endsWith('.js') ? process.execPath : codex,
      codex.endsWith('.js') ? [codex, '--version'] : ['--version']
    ),
    version(python, ['-c', 'import headroom; print(headroom.__version__)']),
    version('git', ['rev-parse', 'HEAD']),
  ]);
  return {
    capturedAt: new Date().toISOString(),
    node: process.version,
    codex: client,
    headroom: competitor,
    gitHead,
    proxyBin,
    sha256,
  };
}
