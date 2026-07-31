/**
 * Which test runner does this project use, and how do you get a report out of
 * it?
 *
 * smart_test only ever spoke Jest. It appended Jest's flags to `npm test`,
 * parsed Jest's `--json`, and on any other project failed with
 *
 *     Failed to parse Jest output: Expected property name or '}' in JSON at
 *     position 4
 *
 * -- a parser's disappointment, offered to a user whose project simply uses
 * something else. A tool named smart_test should run the tests the project
 * actually has.
 *
 * Each framework here is described by three things: how to recognise it, which
 * flags make it emit a machine-readable report, and how to turn that report
 * into the one shape the rest of the tool understands.
 */

export type FrameworkId = 'jest' | 'vitest' | 'mocha' | 'node' | 'ava' | 'unknown';

export interface NormalisedTestResult {
  numTotalTests: number;
  numPassedTests: number;
  numFailedTests: number;
  numPendingTests: number;
  testResults: Array<{
    name: string;
    status: 'passed' | 'failed' | 'pending' | 'skipped';
    duration: number;
    failureMessage?: string;
    /**
     * Jest and Vitest report a FILE per entry with the individual tests nested
     * here. The flat runners have no such level, and their entries carry
     * failureMessage directly -- consumers must handle both.
     */
    assertionResults?: Array<{
      title: string;
      status: 'passed' | 'failed' | 'pending';
      failureMessages: string[];
    }>;
  }>;
}

export interface FrameworkAdapter {
  id: FrameworkId;
  /** Human name, for messages. */
  label: string;
  /** Flags that make this runner emit something parseable. */
  reportArgs: (options: { coverage?: boolean }) => string[];
  /**
   * Flags that must reach the runner through NODE_OPTIONS rather than argv.
   *
   * `node --test` parses its own options only BEFORE `--test`; anything after
   * is taken as a file glob. Since smart_test appends to the project's own
   * `npm test` script, a trailing `--test-reporter=tap` is silently swallowed
   * -- measured on Node 24, which then reported in its default `spec` format
   * while we looked for TAP. NODE_OPTIONS is the seam that actually works.
   */
  nodeOptions?: (options: { pattern?: string }) => string[];
  /** Turns its output into the shape everything downstream expects. */
  parse: (stdout: string, stderr: string) => NormalisedTestResult | null;
}

/* ------------------------------------------------------------- parsers --- */

/** Jest and Vitest both emit the same JSON summary shape. */
function parseJestLike(stdout: string): NormalisedTestResult | null {
  const match = stdout.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const raw = JSON.parse(match[0]) as {
      numTotalTests?: number;
      numPassedTests?: number;
      numFailedTests?: number;
      numPendingTests?: number;
      testResults?: Array<{
        name?: string;
        status?: string;
        endTime?: number;
        startTime?: number;
        message?: string;
        assertionResults?: Array<{ title?: string; fullName?: string; status?: string; failureMessages?: string[] }>;
      }>;
    };
    if (typeof raw.numTotalTests !== 'number') return null;
    return {
      numTotalTests: raw.numTotalTests ?? 0,
      numPassedTests: raw.numPassedTests ?? 0,
      numFailedTests: raw.numFailedTests ?? 0,
      numPendingTests: raw.numPendingTests ?? 0,
      testResults: (raw.testResults ?? []).map((t) => ({
        name: t.name ?? 'test',
        status: (t.status as NormalisedTestResult['testResults'][number]['status']) ?? 'passed',
        duration: Math.max(0, (t.endTime ?? 0) - (t.startTime ?? 0)),
        failureMessage: t.message,
        // Kept, not flattened: this is where the individual test NAMES live,
        // and a failure report that cannot name the test that failed is not
        // worth printing.
        assertionResults: t.assertionResults?.map((a) => ({
          title: a.fullName || a.title || 'test',
          status: (a.status as 'passed' | 'failed' | 'pending') ?? 'passed',
          failureMessages: a.failureMessages ?? [],
        })),
      })),
    };
  } catch {
    return null;
  }
}

/** Mocha's `--reporter json` puts the counts under `stats`. */
function parseMocha(stdout: string): NormalisedTestResult | null {
  const match = stdout.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const raw = JSON.parse(match[0]) as {
      stats?: { tests?: number; passes?: number; failures?: number; pending?: number };
      failures?: Array<{ fullTitle?: string; err?: { message?: string; stack?: string }; duration?: number }>;
      passes?: Array<{ fullTitle?: string; duration?: number }>;
    };
    if (!raw.stats) return null;
    return {
      numTotalTests: raw.stats.tests ?? 0,
      numPassedTests: raw.stats.passes ?? 0,
      numFailedTests: raw.stats.failures ?? 0,
      numPendingTests: raw.stats.pending ?? 0,
      testResults: [
        ...(raw.passes ?? []).map((t) => ({
          name: t.fullTitle ?? 'test',
          status: 'passed' as const,
          duration: t.duration ?? 0,
        })),
        ...(raw.failures ?? []).map((t) => ({
          name: t.fullTitle ?? 'test',
          status: 'failed' as const,
          duration: t.duration ?? 0,
          // The stack is where the file and line live; the message alone says
          // what went wrong but never where.
          failureMessage: t.err?.stack || t.err?.message,
        })),
      ],
    };
  } catch {
    return null;
  }
}

/**
 * Reads the YAML diagnostic block TAP attaches to a result.
 *
 * The useful part is a MULTI-LINE scalar (`error: |-` followed by indented
 * body), so the raw block cannot simply be line-filtered -- doing that dropped
 * "Expected values to be strictly equal: 1 !== 2" and kept the bookkeeping
 * around it. This pulls the message, the assertion facts, and the source
 * location, and renders them the way a stack trace reads.
 */
function readTapDiagnostic(block: string[]): { message?: string; duration: number } {
  if (!block.length) return { duration: 0 };

  const scalar = (key: string): string | null => {
    const at = block.findIndex((l) => new RegExp(`^\\s*${key}:\\s*\\|-?\\s*$`).test(l));
    if (at === -1) return null;
    const indent = (block[at].match(/^\s*/) ?? [''])[0].length;
    const body: string[] = [];
    for (let i = at + 1; i < block.length; i++) {
      const lead = (block[i].match(/^\s*/) ?? [''])[0].length;
      if (block[i].trim() && lead <= indent) break;
      body.push(block[i].slice(indent + 2));
    }
    return body.join('\n').trimEnd();
  };

  const inline = (key: string): string | null => {
    const m = block.join('\n').match(new RegExp(`^\\s*${key}:\\s*(.+)$`, 'm'));
    return m ? m[1].trim().replace(/^'(.*)'$/, '$1') : null;
  };

  const parts: string[] = [];
  const error = scalar('error') ?? inline('error');
  if (error) parts.push(error);

  const name = inline('name');
  const expected = inline('expected');
  const actual = inline('actual');
  const operator = inline('operator');
  if (expected !== null && actual !== null) {
    parts.push(
      `${name ?? 'AssertionError'}: expected ${expected}, actual ${actual}` +
      (operator ? ` (${operator})` : '')
    );
  }

  // Render the location as a stack frame so the same extractor that reads
  // Jest's stacks finds it, rather than needing a TAP-shaped special case.
  const location = inline('location');
  if (location) parts.push(`    at ${location.replace(/\\\\/g, '\\')}`);

  const stack = scalar('stack');
  if (stack) {
    parts.push(...stack.split('\n').slice(0, 4).map((l) => `    at ${l.trim()}`));
  }

  return {
    message: parts.length ? parts.join('\n').slice(0, 1200) : undefined,
    duration: Number(inline('duration_ms') ?? 0),
  };
}

/**
 * TAP, which `node --test` and AVA both speak.
 *
 * Counts come from the plan lines when present (`# pass 3`), and otherwise from
 * the `ok` / `not ok` lines themselves, so a runner that omits the summary is
 * still reported correctly rather than as zero tests.
 */
function parseTap(stdout: string): NormalisedTestResult | null {
  const lines = stdout.split('\n');
  const looksLikeTap = lines.some((l) => /^\s*(ok|not ok)\b/.test(l) || /^\s*TAP version/.test(l));
  if (!looksLikeTap) return null;

  const results: NormalisedTestResult['testResults'] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s*(ok|not ok)\s+\d+\s*-?\s*(.*)$/);
    if (!m) continue;
    const name = (m[2] || 'test').replace(/\s*#\s*(SKIP|TODO).*$/i, '').trim();
    const skipped = /#\s*(SKIP|TODO)/i.test(m[2] || '');
    const failed = m[1] === 'not ok';

    // TAP puts the reason in a YAML block right after the failing line
    // (`---` ... `...`). It holds the assertion detail, the source location and
    // the stack -- the whole answer to "why did this fail", which the counts
    // alone never give.
    let block: string[] = [];
    if (lines[i + 1]?.trim() === '---') {
      let j = i + 2;
      while (j < lines.length && lines[j].trim() !== '...') { block.push(lines[j]); j++; }
    }
    const diag = readTapDiagnostic(block);

    results.push({
      name: name || 'test',
      status: skipped ? 'skipped' : failed ? 'failed' : 'passed',
      duration: diag.duration,
      failureMessage: failed ? diag.message : undefined,
    });
  }

  const summary = (key: string): number | null => {
    const m = stdout.match(new RegExp(`^#\\s*${key}\\s+(\\d+)`, 'm'));
    return m ? Number(m[1]) : null;
  };

  const passed = summary('pass') ?? results.filter((r) => r.status === 'passed').length;
  const failed = summary('fail') ?? results.filter((r) => r.status === 'failed').length;
  const skipped = summary('skipped') ?? results.filter((r) => r.status === 'skipped').length;
  const total = summary('tests') ?? results.length;

  if (total === 0 && results.length === 0) return null;

  return {
    numTotalTests: total,
    numPassedTests: passed,
    numFailedTests: failed,
    numPendingTests: skipped,
    testResults: results,
  };
}

/**
 * Node's own `spec` reporter -- its default whenever stdout is not a TTY, which
 * is always the case here.
 *
 * TAP is requested via NODE_OPTIONS and is preferred, but a project that pins
 * its own reporter in the test script overrides that, and then this is the only
 * thing on stdout. Reading it is the difference between a report and an error.
 *
 *     v two plus two (0.79ms)          <- U+2714 / U+2716 mark each test
 *     x this one fails (1.20ms)
 *     i tests 3                        <- U+2139 marks each summary line
 *     i pass 2
 */
function parseNodeSpec(stdout: string): NormalisedTestResult | null {
  const PASS = '✔';
  const FAIL = '✖';
  const INFO = 'ℹ';
  const SKIP = '︎';

  if (!stdout.includes(INFO) && !stdout.includes(PASS) && !stdout.includes(FAIL)) {
    return null;
  }

  const summary = (key: string): number | null => {
    const m = stdout.match(new RegExp(`${INFO}\\s*${key}\\s+(\\d+)`));
    return m ? Number(m[1]) : null;
  };

  const total = summary('tests');
  if (total === null) return null;

  const rawLines = stdout.split('\n');
  const isMark = (l: string) => {
    const c = l.trim()[0];
    return c === PASS || c === FAIL || c === SKIP;
  };

  const results: NormalisedTestResult['testResults'] = [];
  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i].trim();
    const mark = line[0];
    if (mark !== PASS && mark !== FAIL && mark !== SKIP) continue;
    const name = line.slice(1).replace(/\s*\([\d.]+m?s\)\s*$/, '').trim();
    if (!name) continue;

    // The error follows a failing line, indented, until the next test mark.
    let detail: string | undefined;
    if (mark === FAIL) {
      const block: string[] = [];
      let j = i + 1;
      while (j < rawLines.length && !isMark(rawLines[j]) && !rawLines[j].trim().startsWith(INFO)) {
        block.push(rawLines[j]);
        j++;
      }
      detail = block.join('\n').trim().slice(0, 1200) || undefined;
    }

    results.push({
      name,
      status: mark === PASS ? 'passed' : mark === FAIL ? 'failed' : 'skipped',
      duration: Number(line.match(/\(([\d.]+)ms\)\s*$/)?.[1] ?? 0),
      failureMessage: detail,
    });
  }

  return {
    numTotalTests: total,
    numPassedTests: summary('pass') ?? 0,
    numFailedTests: summary('fail') ?? 0,
    numPendingTests: (summary('skipped') ?? 0) + (summary('todo') ?? 0),
    testResults: results,
  };
}

/* ------------------------------------------------------------ adapters --- */

export const ADAPTERS: Record<Exclude<FrameworkId, 'unknown'>, FrameworkAdapter> = {
  jest: {
    id: 'jest',
    label: 'Jest',
    reportArgs: ({ coverage }) => [
      '--json',
      '--no-colors',
      ...(coverage ? ['--coverage', '--coverageReporters=json-summary'] : []),
    ],
    parse: (stdout) => parseJestLike(stdout),
  },
  vitest: {
    id: 'vitest',
    label: 'Vitest',
    reportArgs: ({ coverage }) => [
      '--run',
      '--reporter=json',
      // json-summary is what writes coverage/coverage-summary.json, the one
      // file every runner's coverage totals can be read from.
      ...(coverage ? ['--coverage', '--coverage.reporter=json-summary'] : []),
    ],
    parse: (stdout) => parseJestLike(stdout),
  },
  mocha: {
    id: 'mocha',
    label: 'Mocha',
    reportArgs: () => ['--reporter', 'json'],
    parse: (stdout) => parseMocha(stdout),
  },
  node: {
    id: 'node',
    label: 'the Node test runner',
    // Nothing on argv: node --test takes trailing args as file globs, so a
    // reporter flag there is not merely ignored, it becomes a phantom path.
    reportArgs: () => [],
    nodeOptions: ({ pattern }) => [
      '--test-reporter=tap',
      ...(pattern ? [`--test-name-pattern=${pattern}`] : []),
    ],
    // TAP when NODE_OPTIONS took effect, spec when the project pinned its own.
    parse: (stdout) => parseTap(stdout) ?? parseNodeSpec(stdout),
  },
  ava: {
    id: 'ava',
    label: 'AVA',
    reportArgs: () => ['--tap'],
    parse: (stdout) => parseTap(stdout),
  },
};

/**
 * Works out which runner a project uses, from its manifest.
 *
 * The test SCRIPT is the strongest signal -- it is what `npm test` will
 * actually execute -- with the dependency list as the fallback.
 */
export function detectFramework(pkg: {
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}): FrameworkId {
  const script = pkg.scripts?.test ?? '';

  if (/\bvitest\b/.test(script)) return 'vitest';
  if (/\bjest\b/.test(script)) return 'jest';
  if (/\bmocha\b/.test(script)) return 'mocha';
  if (/\bava\b/.test(script)) return 'ava';
  if (/node\s+(--test|--experimental-test-runner)/.test(script)) return 'node';

  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  if (deps.vitest) return 'vitest';
  if (deps.jest) return 'jest';
  if (deps.mocha) return 'mocha';
  if (deps.ava) return 'ava';

  return 'unknown';
}

/**
 * Parses output without knowing the framework.
 *
 * Used when detection was inconclusive: rather than refusing, try each shape
 * and accept whichever one actually fits. A report that parses is a report,
 * whoever produced it.
 */
export function parseAnyKnownFormat(stdout: string): { result: NormalisedTestResult; framework: FrameworkId } | null {
  const jestLike = parseJestLike(stdout);
  if (jestLike) return { result: jestLike, framework: 'jest' };
  const mocha = parseMocha(stdout);
  if (mocha) return { result: mocha, framework: 'mocha' };
  const tap = parseTap(stdout);
  if (tap) return { result: tap, framework: 'node' };
  const spec = parseNodeSpec(stdout);
  if (spec) return { result: spec, framework: 'node' };
  return null;
}
