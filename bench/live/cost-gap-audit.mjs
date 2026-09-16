/** Decompose an observed paired loss; replay independently of provider caching. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { compressResponses } from '../../dist/proxy/responses.js';
const [rawArg, task, repArg, output] = process.argv.slice(2);
const raw = resolve(rawArg),
  rep = Number(repArg);
const rows = JSON.parse(await readFile(join(raw, 'results.json'), 'utf8'));
const arms = Object.fromEntries(
  ['proxy', 'headroom'].map((arm) => [
    arm,
    rows.find((row) => row.arm === arm && row.task === task && row.rep === rep),
  ])
);
assert.ok(arms.proxy && arms.headroom);
const delta = (key) => arms.proxy.usage[key] - arms.headroom.usage[key];
const contributions = {
  inputAtUncachedRate: (delta('input') * 10) / 1e6,
  cacheDiscount: (-delta('cached') * 9) / 1e6,
  output: (delta('output') * 50) / 1e6,
};
const captures = (
  await readFile(join(raw, `${task}-${rep}-proxy`, 'requests.jsonl'), 'utf8')
)
  .trim()
  .split(/\r?\n/)
  .map(JSON.parse)
  .filter((row) => row.path.endsWith('/responses'));
assert.ok(captures.length > 0, 'No matching Responses captures');
const spill = () => '/diagnostic-only/original.txt';
const replays = [],
  tokenInputs = [];
let prefix;
for (const capture of captures) {
  const request = JSON.parse(capture.body),
    body = Buffer.from(capture.body);
  delete process.env.TOKEN_OPTIMIZER_PROXY_TOOL_CODE;
  const baseline = compressResponses(body, request, spill);
  process.env.TOKEN_OPTIMIZER_PROXY_TOOL_CODE = '1';
  const candidate = compressResponses(body, request, spill);
  const b = JSON.parse(baseline.body),
    c = JSON.parse(candidate.body);
  assert.equal(c.prompt_cache_key, request.prompt_cache_key);
  assert.deepEqual(c.input.slice(1), b.input.slice(1));
  if (prefix) assert.deepEqual(c.input[0], prefix);
  prefix = c.input[0];
  const appended = {
    ...request,
    input: [
      ...request.input,
      { type: 'message', role: 'user', content: 'independent next question' },
    ],
  };
  const later = JSON.parse(
    compressResponses(Buffer.from(JSON.stringify(appended)), appended, spill)
      .body
  );
  assert.deepEqual(later.input.slice(0, c.input.length), c.input);
  tokenInputs.push({
    baseline: JSON.stringify(b.input[0]),
    candidate: JSON.stringify(c.input[0]),
  });
  replays.push({
    baselineBytes: baseline.body.length,
    candidateBytes: candidate.body.length,
  });
}
const counted = spawnSync(
  'python',
  [
    '-c',
    'import json,sys,tiktoken; e=tiktoken.get_encoding("o200k_base"); print(json.dumps([{k:len(e.encode(v)) for k,v in row.items()} for row in json.load(sys.stdin)]))',
  ],
  { input: JSON.stringify(tokenInputs), encoding: 'utf8', windowsHide: true }
);
assert.equal(counted.status, 0, counted.stderr);
const report = {
  scope:
    'Observed rate-card arithmetic, not causal cache attribution. Local tokenizer replay is not billed provider usage.',
  raw,
  task,
  rep,
  seed: arms.proxy.seed,
  usage: Object.fromEntries(
    Object.entries(arms).map(([arm, row]) => [arm, row.usage])
  ),
  contributions,
  estimatedUsdGap: Object.values(contributions).reduce((a, b) => a + b, 0),
  cacheKeysPreserved: true,
  historicalItemsStable: true,
  replays,
  additionalToolsTokenEstimate: {
    encoding: 'o200k_base',
    requests: JSON.parse(counted.stdout),
  },
};
await writeFile(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify(report, null, 2));
