/** Diagnose every recorded cost loss without changing the original study. */
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { compressResponses } from '../../dist/proxy/responses.js';
import { compressJsonFragments } from '../../dist/compress/json-fragments.js';

const study = resolve(process.argv[2]);
const destination = resolve(process.argv[3]);
const read = async (path) => JSON.parse(await readFile(path, 'utf8'));
const analysis = await read(join(study, 'analysis.json'));
const execution = await read(join(study, 'execution.json'));
const plan = await read(join(study, 'plan.json'));
const rates = plan.scenario.usdPerMillion;
function expand(text) {
  return text.replace(
    /\[JSON fragment records; missing records remain unknown\. Join template parts, replacing numeric slots with (?:raw JSON lexemes|verbatim text fragments) from each row\. Template: (\[[^\n]+\])\]\n([\s\S]*?)\[\/JSON fragment records\]\n/g,
    (_all, encoded, rows) => {
      const template = JSON.parse(encoded);
      return rows
        .trim()
        .split('\n')
        .map((row) => {
          const values = JSON.parse(row);
          return template
            .map((part) => (typeof part === 'number' ? values[part] : part))
            .join('');
        })
        .join('');
    }
  );
}
const report = [];
for (const pair of analysis.pairs) {
  const { proxy: p, headroom: h } = pair.arms;
  if (p.estimatedUsd <= h.estimatedUsd) continue;
  const raw = execution.pairs.find((row) => row.id === pair.id).raw;
  const results = await read(join(study, 'cases', pair.id, 'results.json'));
  const old = results.find((row) => row.arm === 'proxy');
  const records = (
    await readFile(join(raw, `${old.task}-1-proxy`, 'requests.jsonl'), 'utf8')
  )
    .trim()
    .split('\n')
    .map(JSON.parse)
    .filter((row) => row.body.startsWith('{'));
  const stable = new Map(),
    fragments = new Set();
  let replayBytes = 0,
    stableChecks = 0,
    fragmentBefore = 0,
    fragmentAfter = 0;
  const inspect = (value, depth = 0) => {
    if (depth > 5) return;
    if (typeof value === 'string') {
      if (value.length < 1000) return;
      const out = compressJsonFragments(value);
      if (out.text !== value && !fragments.has(value)) {
        assert.equal(expand(out.text), value);
        fragments.add(value);
        fragmentBefore += value.length;
        fragmentAfter += out.text.length;
      }
      let nested;
      try { nested = JSON.parse(value); } catch { return; }
      inspect(nested, depth + 1);
    } else if (Array.isArray(value))
      value.forEach((v) => inspect(v, depth + 1));
    else if (value && typeof value === 'object')
      Object.values(value).forEach((v) => inspect(v, depth + 1));
  };
  for (const record of records) {
    const request = JSON.parse(record.body);
    // Stable deterministic recovery location; this replay makes no provider calls.
    const out = compressResponses(
      Buffer.from(record.body),
      request,
      () => 'C:/replay/recovery.txt'
    );
    replayBytes += out.body.length;
    const next = JSON.parse(out.body);
    assert.equal(next.prompt_cache_key, request.prompt_cache_key);
    request.input.forEach((item, i) => {
      const key = JSON.stringify(item),
        encoded = JSON.stringify(next.input[i]);
      if (stable.has(key)) {
        assert.equal(encoded, stable.get(key));
        stableChecks++;
      }
      stable.set(key, encoded);
      if (item.output) inspect(item.output);
    });
  }
  report.push({
    id: pair.id,
    family: pair.family,
    seed: old.seed,
    observed: pair.arms,
    costDifferenceUsd: p.estimatedUsd - h.estimatedUsd,
    inputVolumeDifferenceUsd: ((p.input - h.input) * rates.uncached) / 1e6,
    cacheDiscountDifferenceUsd:
      (-(p.cached - h.cached) * (rates.uncached - rates.cached)) / 1e6,
    outputDifferenceUsd: ((p.output - h.output) * rates.output) / 1e6,
    originalAfterBytes: old.afterBytes,
    replayBytes,
    stableChecks,
    exactFragments: fragments.size,
    fragmentBefore,
    fragmentAfter,
  });
}
await mkdir(destination, { recursive: true });
await writeFile(
  join(destination, 'loss-audit.json'),
  JSON.stringify(
    {
      scope:
        'All original cost losses. Cost components are arithmetic attribution, not a causal claim about cache misses. Replay uses current code with fixed recovery paths; byte counts are not provider token usage.',
      study,
      scenario: plan.scenario,
      cases: report,
    },
    null,
    2
  ) + '\n',
  { flag: 'wx' }
);
console.log(
  JSON.stringify(
    report.map(
      ({
        id,
        costDifferenceUsd,
        cacheDiscountDifferenceUsd,
        originalAfterBytes,
        replayBytes,
        exactFragments,
        fragmentBefore,
        fragmentAfter,
        stableChecks,
      }) => ({
        id,
        costDifferenceUsd,
        cacheDiscountDifferenceUsd,
        originalAfterBytes,
        replayBytes,
        exactFragments,
        fragmentBefore,
        fragmentAfter,
        stableChecks,
      })
    ),
    null,
    2
  )
);
