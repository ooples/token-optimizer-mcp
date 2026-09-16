/** Run with node --max-old-space-size=32; deliberately exceeds capture capacity.
 * Optional module argument permits the identical pressure against a baseline build.
 */
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const modulePath = resolve(process.argv[2] || 'dist/proxy/capture.js');
const { captureRequest } = await import(pathToFileURL(modulePath).href);
const dir = await mkdtemp(join(tmpdir(), 'capture-pressure-'));
console.log(
  JSON.stringify({ dir, modulePath, started: new Date().toISOString() })
);
const body = Buffer.alloc(128 * 1024, 'x');
const results = await Promise.all(
  Array.from({ length: 2000 }, () => captureRequest(dir, '/responses', body))
);
const result = {
  accepted: results.filter(Boolean).length,
  rejected: results.filter((value) => !value).length,
  memory: process.memoryUsage(),
};
console.log(JSON.stringify(result));
await writeFile(
  join(dir, 'result.json'),
  JSON.stringify(result, null, 2) + '\n'
);
