import { expect, test } from '@jest/globals';
import { cachedOutput } from '../../../src/proxy/output-cache.js';
import { compressBlock } from '../../../src/compress/router.js';
import { DEFAULT_TUNING } from '../../../src/compress/options.js';

const text = JSON.stringify(
  Array.from({ length: 240 }, (_, id) => ({
    id,
    enabled: id !== 122,
    limit: 100,
  })),
  null,
  2
);

test('repeated output matches uncached compression and restores recovery content', () => {
  const files = new Map<string, string>();
  const spill = (content: string) => {
    files.set('/first.json', content);
    return '/first.json';
  };
  const expected = compressBlock(text, { spill });
  expect(cachedOutput(text, spill)).toEqual(expected);
  files.clear();
  expect(cachedOutput(text, spill)).toEqual(expected);
  expect(JSON.parse(files.get('/first.json')!)).toHaveLength(240);
});

test('proxy scopes and changed recovery paths never reuse another path', () => {
  let path = '/first.json';
  const spill = () => path;
  expect(cachedOutput(text, spill).text).toContain('/first.json');
  path = '/second.json';
  expect(cachedOutput(text, spill).text).toContain('/second.json');
  expect(cachedOutput(text, () => '/third.json').text).toContain('/third.json');
});

test('changed text and mutated tuning match fresh compression', () => {
  const spill = () => '/rows.json';
  const tuning = { ...DEFAULT_TUNING };
  cachedOutput(text, spill, tuning);
  tuning.keepRows += 4;
  expect(cachedOutput(text, spill, tuning)).toEqual(
    compressBlock(text, { spill, tuning })
  );
  const changed = text.replace('false', 'true');
  expect(cachedOutput(changed, spill, tuning)).toEqual(
    compressBlock(changed, { spill, tuning })
  );
});

test('recovery failure does not corrupt cache accounting or prevent retry', () => {
  let fail = false;
  const spill = () => {
    if (fail) throw Error('unavailable');
    return '/rows.json';
  };
  cachedOutput(text, spill);
  fail = true;
  expect(() => cachedOutput(text, spill)).toThrow('unavailable');
  fail = false;
  expect(cachedOutput(text, spill)).toEqual(compressBlock(text, { spill }));
});

test('a caller with no sink is cached too, and nothing it caches is fetchable', () => {
  // `undefined` is the product default, so the cache has to serve it. It has
  // no sink to re-check on a hit, which is why the hit path cannot simply call
  // one, and every zero-turn caller compresses identically, so they may share
  // entries.
  const expected = compressBlock(text, { tuning: DEFAULT_TUNING });
  expect(cachedOutput(text, undefined, DEFAULT_TUNING)).toEqual(expected);
  expect(cachedOutput(text, undefined, DEFAULT_TUNING)).toEqual(expected);
  expect(expected.lossless).toBe(true);
});
