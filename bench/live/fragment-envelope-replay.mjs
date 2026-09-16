/** Replay the actual missed outer-truncated result and independently decode it. */
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { get_encoding } from 'tiktoken';
import { compressJsonFragments } from '../../dist/compress/json-fragments.js';
import { compressResponses } from '../../dist/proxy/responses.js';
const capture = resolve(process.argv[2]);
const evidence = resolve(process.argv[3]);
const requests = (await readFile(capture, 'utf8'))
  .trim()
  .split('\n')
  .map(JSON.parse)
  .filter((r) => r.body.startsWith('{'));
const encoder = get_encoding('o200k_base');
const samples = new Map();
const rows = [];
function expand(text) {
  return text.replace(
    /\[JSON fragment records; missing records remain unknown\. Join template parts, replacing numeric slots with verbatim text fragments from each row\. Template: (\[[^\n]+\])\]\n([\s\S]*?)\[\/JSON fragment records\]\n/g,
    (_, encoded, lines) =>
      lines
        .trim()
        .split('\n')
        .map((line) => {
          const values = JSON.parse(line);
          return JSON.parse(encoded)
            .map((part) => (typeof part === 'number' ? values[part] : part))
            .join('');
        })
        .join('')
  );
}
try {
  for (const { body } of requests) {
    const request = JSON.parse(body);
    const out = compressResponses(Buffer.from(body), request, () => {
      throw Error('Expected exact inline representation');
    });
    rows.push({
      beforeBytes: Buffer.byteLength(body),
      afterBytes: out.body.length,
      beforeEstimatedTokens: encoder.encode(body).length,
      afterEstimatedTokens: encoder.encode(out.body.toString()).length,
    });
    for (const item of request.input)
      for (const part of Array.isArray(item.output) ? item.output : []) {
        const text = part.text;
        if (typeof text !== 'string' || text.length < 1000 || samples.has(text))
          continue;
        const compressed = compressJsonFragments(text);
        if (compressed.text === text) continue;
        assert.equal(expand(compressed.text), text);
        samples.set(text, compressed.text);
      }
  }
  assert.ok(samples.size > 0);
  await mkdir(evidence, { recursive: true });
  let index = 0;
  const fragments = [];
  for (const [before, after] of samples) {
    await writeFile(join(evidence, `${index}-input.txt`), before, {
      flag: 'wx',
    });
    await writeFile(join(evidence, `${index}-output.txt`), after, {
      flag: 'wx',
    });
    fragments.push({
      index: index++,
      beforeBytes: Buffer.byteLength(before),
      afterBytes: Buffer.byteLength(after),
      beforeEstimatedTokens: encoder.encode(before).length,
      afterEstimatedTokens: encoder.encode(after).length,
      byteExactReconstruction: true,
    });
  }
  const report = {
    scope:
      'Replay of captured synthetic tool results; token counts are o200k_base estimates, not provider usage. Original live result remains retained.',
    capture,
    compiledSha256: createHash('sha256')
      .update(await readFile('dist/compress/json-fragments.js'))
      .digest('hex'),
    fragments,
    requests: rows,
  };
  await writeFile(
    join(evidence, 'replay.json'),
    JSON.stringify(report, null, 2) + '\n',
    { flag: 'wx' }
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  encoder.free();
}
