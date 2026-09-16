/** Verify incomplete captures cannot become wins, using a copy of a real campaign. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFile, cp, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const source = resolve(process.argv[2]);
const destination = resolve(process.argv[3]);
const hash = (data) => createHash('sha256').update(data).digest('hex');
const original = await readFile(join(source, 'validation.json'));
const passing = JSON.parse(original).find(
  (row) => row.verdict === 'PASS' && row.arm === 'proxy'
);
assert.ok(passing, 'A passing proxy attempt is required');
const temporary = await mkdtemp(join(tmpdir(), 'capture-audit-check-'));
await cp(source, temporary, { recursive: true });
await appendFile(
  join(
    temporary,
    `${passing.task}-${passing.rep}-${passing.arm}`,
    'proxy.stderr'
  ),
  '\ntoken-optimizer proxy: capture incomplete (write failed or memory queue full)\n'
);
const report = spawnSync(
  process.execPath,
  ['bench/live/report-codex.mjs', temporary],
  {
    encoding: 'utf8',
    windowsHide: true,
  }
);
assert.equal(report.status, 1, report.stderr);
const audit = JSON.parse(
  await readFile(join(temporary, 'validation.json'), 'utf8')
);
const row = audit.find(
  (row) =>
    row.task === passing.task &&
    row.rep === passing.rep &&
    row.arm === passing.arm
);
assert.equal(row.verdict, 'INVALID_CAPTURE');
assert.ok(
  row.clientErrors.some((message) => message.includes('capture was incomplete'))
);
assert.equal(
  hash(await readFile(join(source, 'validation.json'))),
  hash(original)
);
await writeFile(
  destination,
  JSON.stringify(
    {
      source,
      temporary,
      originalPreserved: true,
      originalValidationSha256: hash(original),
      reportExit: report.status,
      audit: row,
    },
    null,
    2
  ) + '\n',
  { flag: 'wx' }
);
console.log('Incomplete capture rejected; original evidence preserved.');
