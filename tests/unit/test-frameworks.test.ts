import { describe, it, expect } from '@jest/globals';
import {
  ADAPTERS,
  detectFramework,
  parseAnyKnownFormat,
} from '../../src/tools/build-systems/test-frameworks.js';

/**
 * smart_test used to speak only Jest.
 *
 * Pointed at a project whose test script was anything else it produced
 * "Failed to parse Jest output: Expected property name or '}' in JSON at
 * position 4" -- a parser's disappointment offered to a user whose project
 * simply uses a different runner.
 *
 * The fixtures below are TRANSCRIPTS, captured from the actual runners on this
 * machine, not shapes invented to match the parser. That distinction is the
 * whole value of the file: a fixture written from the parser's assumptions
 * proves the parser agrees with itself. In particular, two of these encode
 * facts that were measured and contradicted what the code assumed:
 *
 *   - Node's default reporter when stdout is a pipe is `spec`, NOT TAP, and a
 *     trailing `--test-reporter=tap` is swallowed as a file glob. So the spec
 *     transcript must parse.
 *   - TAP's useful message is a multi-line YAML scalar (`error: |-`), so it
 *     cannot be recovered by filtering lines.
 */

/** node --test, NODE_OPTIONS=--test-reporter=tap, 2 pass 1 fail. */
const NODE_TAP = `TAP version 13
ok 1 - alpha passes
  ---
  duration_ms: 0.7948
  type: 'test'
  ...
ok 2 - beta passes
  ---
  duration_ms: 0.1721
  type: 'test'
  ...
not ok 3 - gamma fails
  ---
  duration_ms: 2.0908
  type: 'test'
  location: 'C:\\\\work\\\\test\\\\a.test.js:5:1'
  failureType: 'testCodeFailure'
  error: |-
    Expected values to be strictly equal:

    1 !== 2

  code: 'ERR_ASSERTION'
  name: 'AssertionError'
  expected: 2
  actual: 1
  operator: 'strictEqual'
  ...
1..3
# tests 3
# suites 0
# pass 2
# fail 1
# cancelled 0
# skipped 0
# todo 0
# duration_ms 183.5265
`;

/** node --test with no reporter override -- its default when piped. */
const NODE_SPEC = `
✔ alpha passes (0.7948ms)
✔ beta passes (0.1721ms)
✖ gamma fails (2.0908ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:

  1 !== 2

      at TestContext.<anonymous> (file:///C:/work/test/a.test.js:5:34)
ℹ tests 3
ℹ suites 0
ℹ pass 2
ℹ fail 1
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 166.1988
`;

/** mocha --reporter json. */
const MOCHA_JSON = JSON.stringify({
  stats: { suites: 0, tests: 3, passes: 2, pending: 0, failures: 1 },
  passes: [
    { fullTitle: 'alpha passes', duration: 1 },
    { fullTitle: 'beta passes', duration: 0 },
  ],
  failures: [
    {
      fullTitle: 'gamma fails',
      duration: 2,
      err: {
        message: 'Expected values to be strictly equal:\n\n1 !== 2\n',
        stack:
          'AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:\n\n1 !== 2\n' +
          '    at Context.<anonymous> (file:///C:/work/test/a.test.js:4:32)',
      },
    },
  ],
});

/** jest --json / vitest --reporter=json share this shape. */
const JEST_JSON = JSON.stringify({
  numTotalTests: 3,
  numPassedTests: 2,
  numFailedTests: 1,
  numPendingTests: 0,
  testResults: [
    {
      name: 'C:\\work\\test\\a.test.js',
      status: 'failed',
      startTime: 1000,
      endTime: 1250,
      assertionResults: [
        { title: 'alpha passes', fullName: 'alpha passes', status: 'passed', failureMessages: [] },
        { title: 'beta passes', fullName: 'beta passes', status: 'passed', failureMessages: [] },
        {
          title: 'gamma fails',
          fullName: 'gamma fails',
          status: 'failed',
          failureMessages: [
            'Error: expect(received).toBe(expected)\n\nExpected: 2\nReceived: 1\n' +
            '    at Object.<anonymous> (C:\\work\\test\\a.test.js:3:37)',
          ],
        },
      ],
    },
  ],
});

describe('test framework detection', () => {
  it('reads the runner off the test script, which is what npm test executes', () => {
    expect(detectFramework({ scripts: { test: 'jest --ci' } })).toBe('jest');
    expect(detectFramework({ scripts: { test: 'vitest run' } })).toBe('vitest');
    expect(detectFramework({ scripts: { test: 'mocha --recursive' } })).toBe('mocha');
    expect(detectFramework({ scripts: { test: 'ava' } })).toBe('ava');
    expect(detectFramework({ scripts: { test: 'node --test tests/' } })).toBe('node');
  });

  it('falls back to the dependency list when the script says nothing useful', () => {
    expect(detectFramework({ scripts: { test: 'run-s lint spec' }, devDependencies: { vitest: '^2' } }))
      .toBe('vitest');
    expect(detectFramework({ devDependencies: { mocha: '^10' } })).toBe('mocha');
  });

  it('prefers vitest over jest when a project has both installed', () => {
    // Projects mid-migration keep jest in devDependencies while the script
    // already runs vitest. The SCRIPT is what actually executes.
    expect(detectFramework({
      scripts: { test: 'vitest run' },
      devDependencies: { jest: '^29', vitest: '^2' },
    })).toBe('vitest');
  });

  it('says unknown rather than guessing jest', () => {
    expect(detectFramework({ scripts: { test: 'echo no tests' } })).toBe('unknown');
    expect(detectFramework({})).toBe('unknown');
  });
});

describe('report parsing, per runner', () => {
  it('reads TAP, including the counts and the failing test', () => {
    const r = ADAPTERS.node.parse(NODE_TAP, '')!;
    expect(r).not.toBeNull();
    expect(r.numTotalTests).toBe(3);
    expect(r.numPassedTests).toBe(2);
    expect(r.numFailedTests).toBe(1);

    const failed = r.testResults.filter((t) => t.status === 'failed');
    expect(failed).toHaveLength(1);
    expect(failed[0].name).toBe('gamma fails');
  });

  it('recovers the multi-line YAML message TAP hides the reason in', () => {
    // A line filter over the raw block drops exactly this, which is the only
    // part that explains the failure.
    const r = ADAPTERS.node.parse(NODE_TAP, '')!;
    const message = r.testResults.find((t) => t.status === 'failed')!.failureMessage!;
    expect(message).toContain('Expected values to be strictly equal');
    expect(message).toContain('1 !== 2');
    expect(message).toContain('a.test.js:5:1');
  });

  it("reads node's spec reporter, which is its DEFAULT when stdout is a pipe", () => {
    const r = ADAPTERS.node.parse(NODE_SPEC, '')!;
    expect(r).not.toBeNull();
    expect(r.numTotalTests).toBe(3);
    expect(r.numPassedTests).toBe(2);
    expect(r.numFailedTests).toBe(1);
    expect(r.testResults.find((t) => t.status === 'failed')!.name).toBe('gamma fails');
  });

  it('reads mocha json, keeping the stack so the location survives', () => {
    const r = ADAPTERS.mocha.parse(MOCHA_JSON, '')!;
    expect(r.numTotalTests).toBe(3);
    expect(r.numFailedTests).toBe(1);
    const failed = r.testResults.find((t) => t.status === 'failed')!;
    expect(failed.name).toBe('gamma fails');
    expect(failed.failureMessage).toContain('a.test.js:4:32');
  });

  it('reads jest json and KEEPS assertionResults, where the test names live', () => {
    // Flattening these away left "1 failed" beside an empty failure list.
    const r = ADAPTERS.jest.parse(JEST_JSON, '')!;
    expect(r.numTotalTests).toBe(3);
    const file = r.testResults[0];
    expect(file.assertionResults).toHaveLength(3);
    expect(file.assertionResults!.find((a) => a.status === 'failed')!.title).toBe('gamma fails');
  });

  it('reads vitest through the same jest-shaped parser', () => {
    const r = ADAPTERS.vitest.parse(JEST_JSON, '')!;
    expect(r.numTotalTests).toBe(3);
    expect(r.numFailedTests).toBe(1);
  });

  it('returns null instead of zeros when the output is not a report', () => {
    // Zeros would read as a green suite. Nothing is not the same as none.
    for (const adapter of Object.values(ADAPTERS)) {
      expect(adapter.parse('npm ERR! missing script: test', '')).toBeNull();
    }
  });
});

describe('parsing without knowing the runner', () => {
  it('accepts any report whose shape is recognised', () => {
    // Detection can be wrong -- a script that shells out, a runner swapped
    // without the manifest catching up. A report that parses is a report.
    expect(parseAnyKnownFormat(JEST_JSON)?.result.numTotalTests).toBe(3);
    expect(parseAnyKnownFormat(MOCHA_JSON)?.result.numTotalTests).toBe(3);
    expect(parseAnyKnownFormat(NODE_TAP)?.result.numTotalTests).toBe(3);
    expect(parseAnyKnownFormat(NODE_SPEC)?.result.numTotalTests).toBe(3);
  });

  it('gives up rather than inventing a result', () => {
    expect(parseAnyKnownFormat('sh: command not found')).toBeNull();
  });
});

describe('runner flags', () => {
  it("keeps node's flags OFF argv, because node --test reads trailing args as globs", () => {
    // Measured on Node 24: `npm test -- --test-reporter=tap` is silently
    // swallowed and the run reports in spec format instead.
    expect(ADAPTERS.node.reportArgs({})).toEqual([]);
    expect(ADAPTERS.node.nodeOptions!({})).toContain('--test-reporter=tap');
  });

  it('asks every runner that can for a machine-readable report', () => {
    expect(ADAPTERS.jest.reportArgs({})).toContain('--json');
    expect(ADAPTERS.vitest.reportArgs({})).toContain('--reporter=json');
    expect(ADAPTERS.mocha.reportArgs({})).toEqual(['--reporter', 'json']);
    expect(ADAPTERS.ava.reportArgs({})).toEqual(['--tap']);
  });

  it('pins vitest to a single run so it does not sit in watch mode forever', () => {
    expect(ADAPTERS.vitest.reportArgs({})).toContain('--run');
  });

  it('requests json-summary when coverage is asked for, since that writes the file read back', () => {
    expect(ADAPTERS.jest.reportArgs({ coverage: true }).join(' ')).toContain('json-summary');
    expect(ADAPTERS.vitest.reportArgs({ coverage: true }).join(' ')).toContain('json-summary');
  });
});
