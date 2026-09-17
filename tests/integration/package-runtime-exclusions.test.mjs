import { expect, it } from '@jest/globals';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { parsePackReport } from '../../scripts/npm-pack-report.mjs';

it('excludes runtime data from broad npm allowlists while keeping client assets', () => {
  const original = JSON.parse(
    readFileSync(new URL('../../package.json', import.meta.url), 'utf8')
  );
  const root = mkdtempSync(join(tmpdir(), 'package-runtime-exclusions-'));
  const shipped = [
    'dist/server/index.js',
    'hooks/hooks.json',
    'gemini-extension.json',
    'GEMINI.md',
    'integrations/gemini/hooks/session-start.mjs',
  ];
  const excluded = [
    'hooks/logs/dispatcher.log',
    'plugin/hooks/run.log',
    'integrations/codex/.cache/session.json',
    'hooks/.token-optimizer/wiki.json',
    'hooks/cache.db',
    'hooks/cache.db-wal',
    'plugin/cache.sqlite3-shm',
    'scripts/partial.tmp',
    'hooks/.token-optimizer-edit-abcd.lock',
    'hooks/.env',
    'hooks/.env.local',
  ];
  try {
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({
        name: 'release-runtime-exclusion-fixture',
        version: '1.0.0',
        files: original.files,
      })
    );
    for (const path of [...shipped, ...excluded]) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), 'synthetic fixture');
    }
    const pack = parsePackReport(
      execFileSync(
        process.execPath,
        [
          process.env.npm_execpath,
          'pack',
          '--dry-run',
          '--ignore-scripts',
          '--json',
        ],
        { cwd: root, encoding: 'utf8', windowsHide: true }
      ),
      'release-runtime-exclusion-fixture'
    );
    const files = pack.files.map((file) => file.path);
    for (const path of shipped) expect(files).toContain(path);
    for (const path of excluded) expect(files).not.toContain(path);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 20000);
