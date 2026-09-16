/** Verify copy-on-write changes preserve complete Responses results on the chosen corpus. */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { compressResponses } from '../../dist/proxy/responses.js';
const before = await import(pathToFileURL(resolve(process.argv[2])).href);
const records = (await readFile(process.argv[3], 'utf8'))
  .trim()
  .split('\n')
  .map(JSON.parse)
  .filter((r) => r.path?.endsWith('/responses'));
assert.ok(records.length > 0, 'No matching Responses captures');
const spillBefore = () => '/profile-only/rows.json',
  spillAfter = () => '/profile-only/rows.json';
for (const r of records) {
  const body = Buffer.from(r.body),
    request = JSON.parse(r.body);
  assert.deepEqual(
    compressResponses(body, request, spillAfter),
    before.compressResponses(body, request, spillBefore)
  );
}
const report = {
  calls: records.length,
  identicalResults: true,
  scope:
    'Nullable-array captured conversation. Numeric-array representation changes are intentionally excluded from this allocation-only equivalence check.',
};
await writeFile(process.argv[4], JSON.stringify(report, null, 2) + '\n', {
  flag: 'wx',
});
console.log(JSON.stringify(report));
