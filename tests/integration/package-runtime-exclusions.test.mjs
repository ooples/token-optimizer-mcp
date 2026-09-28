import { expect, it } from '@jest/globals';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { parsePackReport } from '../../scripts/npm-pack-report.mjs';

/**
 * npm's own cli.js, run under the node we are already running.
 *
 * NOT `process.env.npm_execpath`, WHICH IS ONLY SET WHEN NPM IS THE PARENT.
 * That is true for `npm test` and false for every other way this suite is
 * started -- `node node_modules/jest/bin/jest.js`, an IDE runner, a CI step that
 * calls jest directly -- and undefined as argv[1] makes node exit with
 * "Cannot find module ...\undefined", which reads like a packaging failure
 * rather than a harness one. It cost a real triage.
 *
 * THROWS RATHER THAN SKIPS if npm cannot be found: this test is the only thing
 * asserting that the published tarball excludes what must not ship, and a
 * silent skip would leave that unasserted while the suite stayed green.
 */
function npmCli() {
  const fromNpm = process.env.npm_execpath;
  const candidates = [
    ...(fromNpm && fromNpm.endsWith('.js') ? [fromNpm] : []),
    join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(
      dirname(process.execPath),
      '..',
      'lib',
      'node_modules',
      'npm',
      'bin',
      'npm-cli.js'
    ),
  ];
  for (const at of candidates) if (existsSync(at)) return at;
  throw new Error(
    `could not locate npm's cli.js; looked at: ${candidates.join(', ')}`
  );
}

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
          npmCli(),
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
