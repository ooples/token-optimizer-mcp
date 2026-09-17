// Local CPU probe. Run once per build, outside live model timing campaigns.
import { performance } from 'node:perf_hooks';
import { writeFileSync } from 'node:fs';
import { TokenCounter } from '../../dist/core/token-counter.js';

const cases = {
  ascii: 'x'.repeat(8192 * 32),
  emoji: '\u{1F600}'.repeat(4096 * 32),
  cycle: 'abcdefghijklmnopqrstuvwxyz'.repeat(10083),
  json: JSON.stringify(
    Array.from({ length: 4000 }, (_, i) => ({
      id: i,
      value: i * 37,
      status: `status-${i % 11}`,
    }))
  ),
};
const rows = [];
for (const [name, text] of Object.entries(cases)) {
  const counter = new TokenCounter('gpt-4');
  counter.count('warm');
  const start = performance.now();
  const result = counter.count(text);
  rows.push({
    name,
    characters: text.length,
    tokens: result.tokens,
    ms: performance.now() - start,
  });
  counter.free();
}
const output = JSON.stringify({ node: process.version, rows }, null, 2) + '\n';
if (process.argv[2]) writeFileSync(process.argv[2], output);
console.log(output);
