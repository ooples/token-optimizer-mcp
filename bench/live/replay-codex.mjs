#!/usr/bin/env node
/** Diagnostic byte replay only; never a live quality or provider-token result. */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const { compressResponses } = await import(
  pathToFileURL(resolve(process.argv[3] || 'dist/proxy/responses.js')).href
);
const records = (await readFile(resolve(process.argv[2]), 'utf8'))
  .trim()
  .split(/\r?\n/)
  .map(JSON.parse);
const results = [];
for (const [index, row] of records.entries()) {
  if (!row.path?.endsWith('/responses')) continue;
  const request = JSON.parse(row.body);
  const result = compressResponses(
    Buffer.from(row.body),
    request,
    () => '/diagnostic-only/original.txt'
  );
  results.push({
    request: index + 1,
    before: result.summary.beforeBytes,
    after: result.body.length,
    elisions: result.summary.elisions,
    compressed: result.summary.compressed,
  });
}
console.log(
  JSON.stringify({ diagnosticOnly: true, requests: results }, null, 2)
);
