#!/usr/bin/env node
/**
 * What the graph is actually doing, on this machine, right now.
 *
 * NOT A TEST, and that is the entire point. Every instance of the wiring defect
 * this work closed PASSED CI. `forTouch` had 27 green tests and no production
 * caller; `wiki_query` was named in twelve shipped copies of injected prompt
 * text and did not exist; `kind: 'query'` was read by the index budget and
 * written by nothing but the test suite, so the budget sat at its floor on
 * every project for the life of the feature.
 *
 * The detectors in tests/hooks are what stop a NEW one arriving. They cannot
 * tell you a capability is alive, because "alive" is not a property of the
 * source text -- it is a property of a real log on a real machine after a real
 * session. That is what this prints. A zero here is not a failure; it is the
 * only evidence that would have caught any of the above.
 *
 * Run: npm run wiki:census [graph-dir]
 */

import { readFileSync, existsSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const dir =
  process.argv[2] ||
  process.env.TOKEN_OPTIMIZER_WIKI_DIR ||
  join(process.cwd(), '.token-optimizer', 'wiki');

/**
 * Counts matches in a log, or reports that the log is absent.
 *
 * ABSENT AND EMPTY ARE DIFFERENT and both are reported as such. A missing
 * metrics.jsonl means the hooks have never run here; a present one with no
 * `query` events means they ran and that capability did not. Collapsing those
 * into a single 0 would throw away the distinction the reader needs most.
 */
const MAX = 32 * 1024 * 1024;

function count(file, pattern) {
  const path = join(dir, file);
  if (!existsSync(path)) return null;
  try {
    const { size } = statSync(path);
    if (size <= MAX) {
      return { truncated: false, n: (readFileSync(path, 'utf8').match(pattern) || []).length };
    }

    // SEEK TO THE TAIL RATHER THAN DECODE THE WHOLE FILE. The first version
    // read the file with `readFileSync(path, 'utf8')` and then took
    // `.slice(-MAX)`, which bounds what is KEPT and nothing else -- the whole
    // log is loaded and decoded to UTF-8 first, so a 64 MiB firehose costs 64
    // MiB of string before a single byte is discarded. `MAX` has to bound the
    // read to bound the memory. metrics.mjs's own reader already does it this
    // way, for the same reason.
    const fd = openSync(path, 'r');
    try {
      const buffer = Buffer.allocUnsafe(MAX);
      const read = readSync(fd, buffer, 0, MAX, size - MAX);
      // A multi-byte character may be cut in half at the seek point; the
      // patterns here are ASCII, so a replacement character at the very start
      // costs nothing, and the alternative is scanning for a boundary.
      const text = buffer.subarray(0, read).toString('utf8');
      return { truncated: true, n: (text.match(pattern) || []).length };
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
}

const ROWS = [
  ['graph.jsonl', 'findings in graph', /"kind":"finding"/g, 'nothing has been learned here yet'],
  ['graph.jsonl', 'file nodes', /"kind":"file"/g, 'structural capture has never run'],
  ['graph.jsonl', 'symbol nodes', /"kind":"symbol"/g, 'symbol indexing has never run'],
  ['graph.jsonl', 'contradicts edges', /"edge":"contradicts"/g, 'no disputed belief has ever been recorded'],
  ['graph.jsonl', 'answers edges', /"edge":"answers"/g, 'no finding has ever been attributed to a question'],
  ['graph.jsonl', 'calls edges', /"edge":"calls"/g, 'symbol call graph never built'],
  ['metrics.jsonl', 'index events', /"kind":"index"/g, 'the session index has never been offered'],
  ['metrics.jsonl', 'query events', /"kind":"query"/g, 'the model has never queried the graph -- indexBudget stays at its floor'],
  ['metrics.jsonl', 'inject events', /"kind":"inject"/g, 'nothing has ever been injected'],
  ['metrics.jsonl', 'substitute events', /"kind":"substitute"/g, 'no read has ever been substituted'],
  ['evidence.jsonl', 'tool outcomes', /"kind":"tool-outcome"/g, 'no injection has ever been joined to a result'],
  ['evidence.jsonl', 'retrieval decisions', /"kind":"retrieval-decision"/g, 'the budget has never turned anything away'],
];

const missing = new Set();
const lines = [];
for (const [file, label, pattern, why] of ROWS) {
  const result = count(file, pattern);
  if (result === null) {
    missing.add(file);
    lines.push(`  ${'-'.padStart(7)}  ${label}  <-- no ${file}`);
    continue;
  }
  const flag = result.n === 0 ? `  <-- DEAD: ${why}` : '';
  const mark = result.truncated ? ' (tail only)' : '';
  lines.push(`  ${String(result.n).padStart(7)}  ${label}${mark}${flag}`);
}

console.log(`\nwiki census -- ${dir}\n`);
console.log(lines.join('\n'));

if (missing.size) {
  console.log(
    `\n${[...missing].join(', ')} not present. ` +
      'Either the hooks have never run against this project, or the graph lives elsewhere -- ' +
      'pass a directory as the first argument, or set TOKEN_OPTIMIZER_WIKI_DIR.'
  );
}

console.log(
  '\nA zero on any row means that capability is declared and not running.\n' +
    'This is the only evidence that would have caught the wiring defects #204 closed:\n' +
    'every one of them passed CI.\n'
);

// EXIT 0 ALWAYS. This reports, it does not judge. A fresh clone has zeroes
// everywhere and that is correct -- #204 accepts cold start deliberately, so a
// non-zero exit would make an honest empty graph look like a broken one, and
// wiring it into CI would then measure the runner's filesystem rather than the
// product. The tests in tests/hooks are the gate; this is the instrument.
const shared = process.env.TOKEN_OPTIMIZER_SHARED_DIR || join(homedir(), '.token-optimizer', 'wiki');
if (shared !== dir && existsSync(shared)) {
  console.log(`The per-machine shared graph is separate: run \`npm run wiki:census ${shared}\` for it.\n`);
}
