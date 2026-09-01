/**
 * The battery.
 *
 * THE ADVERSARIAL SET IS NOT DECORATION. This benchmark is written by the
 * authors of one of the tools it measures, so the only thing standing between
 * it and "the vendor picked tasks that suit them" is a set of families where
 * our own approach cannot possibly help -- declared as such, run every time,
 * and reported first.
 *
 * A cache, an index and a knowledge graph all pay off by REUSE. So the
 * adversarial families are the ones with nothing to reuse:
 *
 *   single-shot   one question, one answer, no second look at anything
 *   novel-repo    a codebase seen for the first time, used once
 *   generation    output invented rather than located, so no index helps
 *
 * If our arm does not lose, or at best draw, on these, the correct conclusion
 * is that the task is not actually adversarial and needs replacing -- not that
 * we have discovered something.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/** Reads a workspace file, returning '' rather than throwing on absence. */
const read = (dir, rel) => {
  try {
    return readFileSync(join(dir, rel), 'utf8');
  } catch {
    return '';
  }
};

const write = (dir, rel, text) => {
  const path = join(dir, rel);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text);
};

/**
 * REUSE-FRIENDLY: a multi-file debug loop.
 *
 * The family we measure worst on, and the one an index should help most: the
 * agent must find where a symbol lives, across several modules, more than once.
 */
export const debugPipeline = {
  id: 'debug-pipeline-py',
  family: 'debug',
  adversarial: false,
  tracks: ['cold', 'warm'],
  prompt:
    'The test suite fails. Find and fix the bug so that `python -m pytest -q` passes. ' +
    'Do not weaken, skip, or delete any test.',
  setup(dir) {
    write(dir, 'pipeline/parse.py', [
      'def parse_line(raw):',
      '    parts = raw.split(",")',
      '    return {"id": parts[0], "value": parts[1]}',
      '',
    ].join('\n'));
    // The bug: strips the wrong side, so trailing whitespace survives.
    write(dir, 'pipeline/clean.py', [
      'def normalise(record):',
      '    record["value"] = record["value"].lstrip()',
      '    return record',
      '',
    ].join('\n'));
    write(dir, 'tests/test_pipeline.py', [
      'from pipeline.parse import parse_line',
      'from pipeline.clean import normalise',
      '',
      'def test_round_trip():',
      '    assert normalise(parse_line("a,  b  "))["value"] == "b"',
      '',
    ].join('\n'));
  },
  checks: [
    {
      name: 'bug is actually fixed',
      weight: 3,
      run: (dir) => /\.strip\(\)/.test(read(dir, 'pipeline/clean.py')),
    },
    {
      // WEIGHTED HEAVILY AND DELIBERATELY. The cheapest way to make a suite
      // pass is to delete the test, and an agent under token pressure is more
      // likely to try it. If that earned full marks the benchmark would reward
      // the behaviour it exists to detect.
      name: 'test still asserts the original behaviour',
      weight: 3,
      run: (dir) => /normalise\(parse_line\("a,\s+b\s+"\)\)\["value"\] == "b"/.test(
        read(dir, 'tests/test_pipeline.py')
      ),
    },
    {
      name: 'parser left intact',
      weight: 1,
      run: (dir) => /def parse_line/.test(read(dir, 'pipeline/parse.py')),
    },
  ],
};

/**
 * ADVERSARIAL: single-shot factual extraction.
 *
 * One file, read once, answered once. There is no second lookup for an index to
 * save and no prior session for a graph to remember, so any per-session setup
 * cost our product pays is pure loss here. That is exactly why it is in the set.
 */
export const singleShotExtract = {
  id: 'single-shot-extract',
  family: 'single-shot',
  adversarial: true,
  tracks: ['cold', 'warm'],
  prompt:
    'Read config/service.toml and write the value of the `timeout_ms` key, and nothing else, ' +
    'into ANSWER.txt at the repository root.',
  setup(dir) {
    write(dir, 'config/service.toml', [
      '[server]',
      'host = "0.0.0.0"',
      'port = 8080',
      'timeout_ms = 4500',
      'retries = 3',
      '',
    ].join('\n'));
  },
  checks: [
    { name: 'answer file exists', weight: 1, run: (dir) => existsSync(join(dir, 'ANSWER.txt')) },
    { name: 'answer is correct', weight: 3, run: (dir) => read(dir, 'ANSWER.txt').trim() === '4500' },
  ],
};

/**
 * ADVERSARIAL: pure generation.
 *
 * The output does not exist anywhere to be found, so nothing can be retrieved,
 * cached or indexed into place. Any mechanism that works by locating existing
 * code has nothing to contribute and only its overhead to charge.
 */
export const pureGeneration = {
  id: 'pure-generation',
  family: 'generation',
  adversarial: true,
  tracks: ['cold', 'warm'],
  prompt:
    'Create util/backoff.py containing a function `delays(attempts, base_ms)` that returns a list ' +
    'of exponential backoff delays in milliseconds, doubling from base_ms, capped at 30000.',
  setup(dir) {
    write(dir, 'README.md', '# scratch project\n');
  },
  checks: [
    { name: 'file created', weight: 1, run: (dir) => existsSync(join(dir, 'util/backoff.py')) },
    {
      name: 'function defined',
      weight: 1,
      run: (dir) => /def\s+delays\s*\(\s*attempts\s*,\s*base_ms\s*\)/.test(read(dir, 'util/backoff.py')),
    },
    {
      name: 'doubles and caps',
      weight: 2,
      run: (dir) => {
        const src = read(dir, 'util/backoff.py');
        return /30000/.test(src) && /(\*\s*2|<<\s*1|2\s*\*\*)/.test(src);
      },
    },
  ],
};

/**
 * REUSE-FRIENDLY: the same codebase, asked about repeatedly.
 *
 * The warm track's reason for existing. On the cold track this is one ordinary
 * comprehension task; run as part of a warm sequence it is the second and third
 * visit to a tree already indexed, which is the condition our product claims to
 * exploit and which the previous harness could not create.
 */
export const repeatComprehension = {
  id: 'repeat-comprehension',
  family: 'comprehension',
  adversarial: false,
  tracks: ['warm'],
  prompt:
    'Write to SYMBOLS.txt, one per line, the file path and line number where each of these is ' +
    'defined: parse_line, normalise. Use the form `name path:line`.',
  setup(dir) {
    debugPipeline.setup(dir);
  },
  checks: [
    { name: 'answer file exists', weight: 1, run: (dir) => existsSync(join(dir, 'SYMBOLS.txt')) },
    {
      name: 'parse_line located',
      weight: 2,
      run: (dir) => /parse_line\s+pipeline\/parse\.py:1\b/.test(read(dir, 'SYMBOLS.txt')),
    },
    {
      name: 'normalise located',
      weight: 2,
      run: (dir) => /normalise\s+pipeline\/clean\.py:1\b/.test(read(dir, 'SYMBOLS.txt')),
    },
  ],
};

export const TASKS = [debugPipeline, singleShotExtract, pureGeneration, repeatComprehension];

/** The declared adversarial subset, which the report renders first. */
export const ADVERSARIAL = TASKS.filter((t) => t.adversarial);

/** Tasks eligible for a track. Warm sequences run in the order given here. */
export const forTrack = (track) => TASKS.filter((t) => t.tracks.includes(track));
