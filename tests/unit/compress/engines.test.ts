import { describe, it, expect } from '@jest/globals';
import { compressJson, looksLikeJson } from '../../../src/compress/json.js';
import { compressLog, looksLikeLog } from '../../../src/compress/log.js';
import { compressCode, looksLikeCode, looksLikeDiff } from '../../../src/compress/code.js';
import { compressProse, looksLikeProse, score } from '../../../src/compress/prose.js';
import {
  compressSearchResults,
  looksLikeSearchResults,
} from '../../../src/compress/search.js';
import { count, inlineMarker, marker, span } from '../../../src/compress/annotate.js';
import { unchanged } from '../../../src/compress/types.js';

/**
 * The engines, one at a time.
 *
 * EVERY DEFECT THESE PIN WAS FOUND BY THE BENCHMARK, NOT BY REVIEW, and each
 * was silent -- an engine that declines returns the input unchanged, which is
 * indistinguishable from content that had nothing to remove. Six of them landed
 * that way. So the tests here are not only "does it compress": each engine also
 * has a PRESERVATION test asserting the thing that must survive, because a
 * compressor's real failure mode is a good ratio achieved by deleting the
 * answer.
 */

/** A spill that records what it was handed, so tests can assert recoverability. */
function recordingSpill() {
  const written: string[] = [];
  return {
    written,
    spill: (content: string, hint: string) => {
      written.push(content);
      return `.token-optimizer/spill/${written.length}-${hint}`;
    },
  };
}

describe('annotate', () => {
  it('pluralises so the marker does not read as a bug', () => {
    expect(count(1, 'duplicate line')).toBe('1 duplicate line');
    expect(count(2, 'duplicate line')).toBe('2 duplicate lines');
  });

  it('collapses a one-line span to a single number', () => {
    expect(span('src/x.ts', 7, 7)).toBe('src/x.ts:7');
    expect(span('src/x.ts', 7, 9)).toBe('src/x.ts:7-9');
  });

  it('states the recovery path when there is one, and omits it when there is not', () => {
    expect(marker({ removed: 'body, 4 lines', recoverAt: 'src/x.ts:1-4' })).toBe(
      '[... body, 4 lines -> src/x.ts:1-4]'
    );
    expect(inlineMarker('37 duplicate lines', null)).toBe('[... 37 duplicate lines]');
  });

  it('never emits an angle-bracket sigil, which reads as a protocol to satisfy', () => {
    const text = marker({ removed: 'body, 9 lines', recoverAt: 'a.ts:1-9' });
    expect(text.startsWith('[')).toBe(true);
    expect(text).not.toContain('<<');
  });
});

describe('json', () => {
  const rows = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      id: `doc_${i}`,
      score: 0.5,
      title: 'A result title that is reasonably long',
      metadata: { author: 'Someone', category: 'technical' },
    }));

  it('recognises objects and arrays, and nothing else', () => {
    expect(looksLikeJson('{"a":1}')).toBe(true);
    expect(looksLikeJson('[1,2]')).toBe(true);
    expect(looksLikeJson('not json at all')).toBe(false);
  });

  it('leaves malformed JSON completely alone', () => {
    // A half-parsed rewrite of broken JSON is a corruption dressed as an
    // optimisation, so the engine must decline rather than guess.
    const broken = '[{"a": 1,,,}]';
    expect(compressJson(broken).text).toBe(broken);
  });

  it('strips whitespace and nulls losslessly', () => {
    const text = JSON.stringify({ a: 1, b: null, c: { d: null, e: 2 } }, null, 2);
    const out = compressJson(text);
    expect(JSON.parse(out.text)).toEqual({ a: 1, c: { e: 2 } });
    expect(out.lossless).toBe(true);
  });

  it('elides a long repeating tail and says how much went', () => {
    const out = compressJson(JSON.stringify(rows(60)), recordingSpill());
    expect(out.text.length).toBeLessThan(2000);
    expect(out.text).toContain('more row');
    expect(out.elisions.some((e) => /repeating row/.test(e.removed))).toBe(true);
  });

  // PRESERVATION.
  it('keeps every row that departs from the shape, wherever it sits', () => {
    // The defect this exists for: head-and-elide measured 95.7% on this exact
    // payload and destroyed both planted records -- the two rows anybody would
    // have been searching for.
    const all = rows(60) as Array<Record<string, unknown>>;
    all[47] = { ...all[47], uuid: '9f1c2b3a-7d4e-4a1b-9c6f-abcdefabcdef', is_needle: true };
    all[23] = { ...all[23], error: 'Permission denied', status: 'failed' };

    const out = compressJson(JSON.stringify(all), recordingSpill());

    expect(out.text).toContain('9f1c2b3a-7d4e-4a1b-9c6f-abcdefabcdef');
    expect(out.text).toContain('Permission denied');
    // And it still compressed: preservation is not an excuse to give up.
    expect(out.text.length).toBeLessThan(JSON.stringify(all).length / 4);
  });

  it('keeps a row that is MISSING a common key, not only one with an extra', () => {
    // An incomplete record is as interesting as a special one.
    const all = rows(60) as Array<Record<string, unknown>>;
    const partial = { ...all[31] };
    delete partial.metadata;
    all[31] = partial;

    const out = compressJson(JSON.stringify(all), recordingSpill());
    expect(out.text).toContain('doc_31');
  });

  it('leaves the array whole when almost every row is exceptional', () => {
    // Nothing repeats, so there is no redundant tail and the marker would buy
    // nothing.
    const odd = Array.from({ length: 12 }, (_, i) => ({ [`k${i}`]: i }));
    const out = compressJson(JSON.stringify(odd));
    expect(out.text).not.toContain('[...');
    expect(out.lossless).toBe(true);
  });

  it('hands the whole array to the spill, so the elided rows are recoverable', () => {
    const rec = recordingSpill();
    compressJson(JSON.stringify(rows(60)), rec);
    expect(rec.written).toHaveLength(1);
    expect(JSON.parse(rec.written[0])).toHaveLength(60);
  });
});

describe('log', () => {
  const stamped = (i: number, text: string) =>
    `2026-09-09T18:${String(i % 60).padStart(2, '0')}:00Z ${text}`;

  it('recognises timestamped or levelled output', () => {
    const text = Array.from({ length: 10 }, (_, i) => stamped(i, 'INFO doing work')).join('\n');
    expect(looksLikeLog(text)).toBe(true);
    expect(looksLikeLog('just\ntwo lines')).toBe(false);
  });

  it('folds an adjacent run into one line and a count', () => {
    const text = Array.from({ length: 9 }, () => 'INFO compiled module successfully').join('\n');
    const out = compressLog(text);
    expect(out.text).toContain('8 more times');
    expect(out.lossless).toBe(true);
  });

  it('folds duplicates that are scattered, not only adjacent ones', () => {
    // A busy build log interleaves its repetition; consecutive-only folding
    // compressed such a log by 0%.
    const lines: string[] = [];
    for (let i = 0; i < 30; i += 1) {
      lines.push(stamped(i, 'WARN peer dependency mismatch'));
      lines.push(stamped(i, `DEBUG unique step ${i}`));
    }
    const out = compressLog(lines.join('\n'));
    expect(out.text).toContain('elsewhere');
    expect(out.text.length).toBeLessThan(lines.join('\n').length);
  });

  // PRESERVATION.
  it('never DISCARDS a load-bearing line, however often it repeats', () => {
    // Two identical AssertionErrors are two failures, and duplicate folding
    // would report one. Templating is a different operation: it states the
    // shape once and lists every value in order, so all eight remain
    // reconstructible. The invariant is that no occurrence is lost -- not that
    // the output keeps any particular line count, which is what this test
    // asserted at first and was wrong about.
    const lines = Array.from({ length: 8 }, (_, i) =>
      stamped(i, `ERROR AssertionError at src/mod${i}.ts: boom`)
    );
    const out = compressLog(lines.join('\n'));

    expect(out.text).toContain('AssertionError');
    const folded = /(\d+) occurrences/.exec(out.text);
    const standalone = out.text
      .split('\n')
      .filter((l) => l.includes('AssertionError') && !l.includes('occurrences')).length;
    expect((folded ? Number(folded[1]) : 0) + standalone).toBe(8);
    // Not a summary: the distinct values survive verbatim.
    expect(out.text).toContain('7');
    expect(out.lossless).toBe(true);
  });

  it('folds duplicates but never merges two DIFFERENT errors', () => {
    // Shapes differ once the words differ, so distinct failures stay distinct
    // even though both are load-bearing and both repeat.
    const lines = [
      ...Array.from({ length: 5 }, (_, i) => stamped(i, `ERROR timeout after ${i}s`)),
      ...Array.from({ length: 5 }, (_, i) => stamped(i, `ERROR permission denied for user${i}`)),
    ];
    const out = compressLog(lines.join('\n'));
    expect(out.text).toContain('timeout after');
    expect(out.text).toContain('permission denied for');
  });

  it('templates near-identical lines instead of discarding them', () => {
    // The digits sit inside identifiers, which is why a \b-anchored grouper
    // found 0 templates over 108 candidates.
    const lines = Array.from({ length: 12 }, (_, i) =>
      stamped(i, `ERROR AssertionError at src/mod${1000 + i}.ts:${200 + i}: expected ${i}`)
    );
    const out = compressLog(lines.join('\n'));
    expect(out.text.length).toBeLessThan(lines.join('\n').length);
    // Every distinct value is still present, so nothing was lost.
    expect(out.text).toContain('1011');
    expect(out.lossless).toBe(true);
  });

  it('returns the input untouched when there is genuinely nothing to fold', () => {
    // Lines sharing no shape: no duplicates, and nothing numeric to template.
    // `INFO step 0..9` does NOT qualify -- those differ only in digits and are
    // legitimately templatable, which is what this test was originally wrong
    // about in its own premise.
    const text = [
      '2026-09-09T18:00:00Z INFO starting the compiler',
      '2026-09-09T18:00:01Z DEBUG resolving imports',
      '2026-09-09T18:00:02Z WARN deprecated option in use',
      '2026-09-09T18:00:03Z INFO writing output bundle',
      '2026-09-09T18:00:04Z DEBUG cleaning temporary artefacts',
      '2026-09-09T18:00:05Z INFO done',
      '2026-09-09T18:00:06Z DEBUG releasing the worker pool',
      '2026-09-09T18:00:07Z INFO shutting down cleanly',
    ].join('\n');
    expect(compressLog(text).text).toBe(text);
  });
});

describe('code', () => {
  const ts = [
    "import { readFileSync } from 'node:fs';",
    '',
    'export function widen(input: string, limit: number): string {',
    '  const parts = input.split(/\\s+/);',
    '  const out: string[] = [];',
    '  for (const part of parts) {',
    '    if (out.join(" ").length > limit) break;',
    '    out.push(part);',
    '  }',
    '  return out.join(" ");',
    '}',
  ].join('\n');

  it('recognises code and refuses a diff', () => {
    expect(looksLikeCode(ts)).toBe(true);
    expect(looksLikeDiff('@@ -1,3 +1,4 @@\n-old\n+new')).toBe(true);
  });

  // PRESERVATION.
  it('never elides a diff, whose hunks are the entire content', () => {
    const diff = ['diff --git a/x.ts b/x.ts', '@@ -1,6 +1,6 @@', '-a', '-b', '-c', '+d', '+e', '+f'].join(
      '\n'
    );
    expect(compressCode(diff, { sourcePath: 'x.ts' }).text).toBe(diff);
  });

  // PRESERVATION.
  it('keeps signatures, imports and the declaration line', () => {
    const out = compressCode(ts, { sourcePath: 'src/w.ts' });
    expect(out.text).toContain("import { readFileSync } from 'node:fs';");
    expect(out.text).toContain('export function widen(input: string, limit: number): string {');
  });

  it('replaces the body with a marker naming the line range', () => {
    const out = compressCode(ts, { sourcePath: 'src/w.ts' });
    expect(out.text).toMatch(/\[\.\.\. body, \d+ lines -> src\/w\.ts:\d+-\d+\]/);
    expect(out.text.length).toBeLessThan(ts.length);
  });

  it('spills when there is no source path, rather than declining', () => {
    // Code arriving as a tool result has no path, and requiring one meant the
    // engine silently declined on exactly the content it exists for.
    const rec = recordingSpill();
    const out = compressCode(ts, rec);
    expect(out.text).toContain('[... body');
    expect(rec.written).toHaveLength(1);
  });

  it('leaves the body alone when it cannot be recovered at all', () => {
    // No path and no spill: an unrecoverable elision is not a trade we make.
    expect(compressCode(ts, {}).text).toBe(ts);
  });

  it('falls back to a generic walk when no parser succeeds', () => {
    // Babel throwing used to mean 0% compression; measured on real concatenated
    // sources it left 46,960 characters untouched.
    const unparseable = [
      'This is prose that precedes the code and breaks the parse. ###',
      'func Handle(w http.ResponseWriter, r *http.Request) {',
      '\tbody := readAll(r)',
      '\tif body == nil {',
      '\t\treturn',
      '\t}',
      '\twrite(w, body)',
      '}',
    ].join('\n');
    const out = compressCode(unparseable, { sourcePath: 'srv.go', language: 'go' });
    expect(out.text.length).toBeLessThan(unparseable.length);
  });

  it('emits one marker per hole, never a nested second', () => {
    const nested = [
      'export function outer(): void {',
      '  const table = {',
      '    a: 1,',
      '    b: 2,',
      '    c: 3,',
      '    d: 4,',
      '    e: 5,',
      '    f: 6,',
      '    g: 7,',
      '    h: 8,',
      '  };',
      '  use(table);',
      '  use(table);',
      '}',
    ].join('\n');
    const out = compressCode(nested, { sourcePath: 'n.ts' });
    expect(out.text.split('[... ').length - 1).toBe(1);
  });
});

describe('prose', () => {
  const sentences = [
    'The registry layer must never drop a record silently.',
    'It is worth noting that this is generally considered good practice.',
    'As we mentioned, the retry budget is 5 attempts.',
    'In other words, the system might possibly retry somewhat more often.',
    'The error surfaces at src/layer.ts:40 with exit code 1.',
    'Needless to say, callers should handle it.',
    'Of course, that is only one approach.',
    'Please note that the defaults are usually fine.',
  ].join(' ');

  it('recognises wordy lines as prose', () => {
    expect(looksLikeProse(sentences + '\n' + sentences)).toBe(true);
  });

  // PRESERVATION.
  it('ranks a sentence carrying an error above pure filler', () => {
    const critical = score('The error surfaces at src/layer.ts:40 with exit code 1.', 3, 8);
    const filler = score('It is worth noting that this is generally considered good practice.', 3, 8);
    expect(critical).toBeGreaterThan(filler);
  });

  it('keeps the load-bearing sentences and drops the boilerplate', () => {
    const out = compressProse(sentences, recordingSpill());
    expect(out.text).toContain('must never drop a record silently');
    expect(out.text).toContain('src/layer.ts:40');
    expect(out.text).not.toContain('Needless to say');
    expect(out.text).toContain('lower-signal sentence');
  });

  it('leaves a short passage alone, where scoring noise would dominate', () => {
    const short = 'One sentence. Two sentences. Three.';
    expect(compressProse(short).text).toBe(short);
  });
});

describe('search', () => {
  const hits = [
    'src/a.ts:10: export function alpha() {',
    'src/a.ts:11:   return 1;',
    'src/a.ts:12: }',
    'src/b.ts:20: export function beta() {',
    'src/b.ts:21:   return 2;',
    'src/b.ts:22: }',
  ].join('\n');

  it('recognises grep output', () => {
    expect(looksLikeSearchResults(hits)).toBe(true);
  });

  it('does not mistake a timestamped log line for a hit', () => {
    // `18:10:00Z INFO ...` parses as path 18, line 10 under a naive pattern,
    // which stole every log line from the log engine.
    const log = Array.from(
      { length: 10 },
      (_, i) => `2026-09-09T18:${String(i).padStart(2, '0')}:00Z INFO compiled`
    ).join('\n');
    expect(looksLikeSearchResults(log)).toBe(false);
  });

  it('states the path once per hunk instead of on every line', () => {
    const out = compressSearchResults(hits);
    expect(out.text).toContain('src/a.ts:10-12');
    expect(out.text.split('src/a.ts').length - 1).toBe(1);
    expect(out.lossless).toBe(true);
  });

  it('works on CRLF input, where a dot-star pattern matches nothing', () => {
    // `.` excludes CR in JavaScript, so `(.*)$` can never reach its anchor on a
    // CRLF file: 815 lines, 0 hits.
    const crlf = hits.split('\n').join('\r\n');
    expect(looksLikeSearchResults(crlf)).toBe(true);
    expect(compressSearchResults(crlf).text.length).toBeLessThan(crlf.length);
  });

  it('says nothing about matches when every line in the range matched', () => {
    // Listing all of them was 25% of the engine's own output. Pinned
    // positively: a lone `not.toContain` would pass against a function that
    // threw or returned nothing, which is the failure this test exists to rule
    // out.
    const out = compressSearchResults(hits);
    expect(out.text).toContain('src/a.ts:10-12\n');
    expect(out.text).not.toContain('matched 10,11,12');
  });

  // PRESERVATION.
  it('keeps every content line: the header replaces prefixes, not content', () => {
    const out = compressSearchResults(hits);
    for (const fragment of ['export function alpha()', 'return 1;', 'export function beta()']) {
      expect(out.text).toContain(fragment);
    }
  });
});

describe('types', () => {
  it('unchanged reports no elisions and full fidelity', () => {
    const result = unchanged('abc');
    expect(result).toEqual({ text: 'abc', elisions: [], lossless: true });
  });
});
