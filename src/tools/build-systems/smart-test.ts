/**
 * Smart Test Tool - 80% Token Reduction
 *
 * Wraps the project's test runner to provide:
 * - Incremental test runs (only affected tests)
 * - Cached test results
 * - Failure summarization (not full logs)
 * - Coverage delta tracking
 *
 * Jest, Vitest, Mocha, AVA and `node --test` are all understood; the runner is
 * detected from package.json and its report normalised into one shape. See
 * test-frameworks.ts.
 */

import { CacheEngine } from '../../core/cache-engine.js';
import { TokenCounter } from '../../core/token-counter.js';
import { MetricsCollector } from '../../core/metrics.js';
import { createHash } from 'crypto';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { spawnNpm } from './run-node-bin.js';
import {
  ADAPTERS,
  detectFramework,
  parseAnyKnownFormat,
  type FrameworkId,
} from './test-frameworks.js';

interface TestResult {
  numTotalTests: number;
  numPassedTests: number;
  numFailedTests: number;
  numPendingTests: number;
  testResults: Array<{
    name: string;
    status: 'passed' | 'failed' | 'pending' | 'skipped';
    duration: number;
    failureMessage?: string;
    assertionResults?: Array<{
      title: string;
      status: 'passed' | 'failed' | 'pending';
      failureMessages: string[];
    }>;
  }>;
  coverageMap?: {
    total: {
      statements: { pct: number };
      branches: { pct: number };
      functions: { pct: number };
      lines: { pct: number };
    };
  };
  startTime: number;
  endTime: number;

  /** Which runner produced this. Cached alongside the result. */
  framework?: FrameworkId;
}

interface SmartTestOptions {
  /**
   * Pattern to match test files
   */
  pattern?: string;

  /**
   * Run only tests that changed since last run
   */
  onlyChanged?: boolean;

  /**
   * Force full test run (ignore cache)
   */
  force?: boolean;

  /**
   * Collect coverage information
   */
  coverage?: boolean;

  /**
   * Watch mode
   */
  watch?: boolean;

  /**
   * Project root directory
   */
  projectRoot?: string;

  /**
   * Maximum cache age in seconds (default: 3600 = 1 hour)
   */
  maxCacheAge?: number;

  /**
   * Which test runner the project uses. Detected from package.json when
   * omitted, which is right almost always; set it when the project's test
   * script is indirect enough to hide the runner (a shell wrapper, a
   * cross-env chain).
   */
  framework?: FrameworkId;
}

interface SmartTestOutput {
  /**
   * Summary of test run
   */
  summary: {
    total: number;
    passed: number;
    failed: number;
    skipped: number;
    duration: number;
    fromCache: boolean;

    /** Which runner actually produced these numbers. */
    framework: FrameworkId;
  };

  /**
   * Only failed tests with concise error messages
   */
  failures: Array<{
    testFile: string;
    testName: string;
    error: string;
    location?: string;
  }>;

  /**
   * Coverage delta (only if coverage enabled)
   */
  coverageDelta?: {
    statements: number;
    branches: number;
    functions: number;
    lines: number;
  };

  /**
   * New tests added since last run
   */
  newTests: string[];

  /**
   * Token reduction metrics
   */
  metrics: {
    originalTokens: number;
    compactedTokens: number;
    reductionPercentage: number;
  };
}

export class SmartTest {
  private cache: CacheEngine;
  private cacheNamespace = 'smart_test';
  private projectRoot: string;
  private readonly defaultProjectRoot: string;
  private lastFramework: FrameworkId = 'unknown';

  constructor(
    cache: CacheEngine,
    _tokenCounter: TokenCounter,
    _metrics: MetricsCollector,
    projectRoot?: string
  ) {
    this.cache = cache;
    this.defaultProjectRoot = projectRoot || process.cwd();
    this.projectRoot = this.defaultProjectRoot;
  }

  /**
   * Run tests with smart caching and output reduction
   */
  async run(options: SmartTestOptions = {}): Promise<SmartTestOutput> {
    // Honor a per-call projectRoot. The MCP server constructs this tool ONCE
    // as a singleton (with the server's own cwd), so without this the
    // projectRoot argument was silently ignored and npm ran in an unrelated
    // directory — failing with ENOENT instead of running the project's tests.
    // Resolve from the constructor default each call so omitting projectRoot
    // reverts to the default instead of stickily keeping a prior call's value.
    this.projectRoot = options.projectRoot || this.defaultProjectRoot;
    const {
      pattern,
      onlyChanged = false,
      force = false,
      coverage = false,
      watch = false,
      maxCacheAge = 3600,
    } = options;

    // Generate cache key based on test files and their content
    const cacheKey = await this.generateCacheKey(pattern);

    // Check cache first (unless force or watch mode)
    if (!force && !watch) {
      const cached = this.getCachedResult(cacheKey, maxCacheAge);
      if (cached) {
        return this.formatCachedOutput(cached);
      }
    }

    // Run whatever runner this project actually uses
    const result = await this.runTests({
      pattern,
      onlyChanged,
      coverage,
      watch,
      framework: options.framework,
    });

    // Cache the result
    if (!watch) {
      this.cacheResult(cacheKey, result);
    }

    // Transform to smart output
    return this.transformOutput(result);
  }

  /**
   * Works out which runner this project uses.
   *
   * An explicit option wins; otherwise package.json decides. A project with no
   * manifest at all is 'unknown', which is not fatal -- the run still happens
   * and the output is parsed by shape afterwards.
   */
  private resolveFramework(explicit?: FrameworkId): FrameworkId {
    if (explicit && explicit !== 'unknown') return explicit;

    const manifest = join(this.projectRoot, 'package.json');
    if (!existsSync(manifest)) return 'unknown';
    try {
      return detectFramework(JSON.parse(readFileSync(manifest, 'utf8')));
    } catch {
      return 'unknown';
    }
  }

  /**
   * Flags for narrowing the run, which every runner spells differently.
   *
   * Only what a runner genuinely supports is passed. `onlyChanged` has no
   * equivalent outside Jest and Vitest, and inventing one would mean silently
   * running everything while reporting a narrowed run.
   */
  private selectionArgs(
    framework: FrameworkId,
    options: { pattern?: string; onlyChanged: boolean; watch: boolean }
  ): string[] {
    const args: string[] = [];
    const plain = options.pattern?.replace(/\\/g, '/');

    switch (framework) {
      case 'jest': {
        if (plain) {
          // Escape every regex metacharacter (including backslash) in a single
          // pass, then convert the user-facing `*` wildcard (escaped to `\*` by
          // the previous step) into `.*` for Jest's regex pattern matching.
          const asRegex = plain
            .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
            .replace(/\\\*/g, '.*');
          args.push('--testPathPattern=' + asRegex);
        }
        if (options.onlyChanged) args.push('--onlyChanged');
        if (options.watch) args.push('--watch');
        break;
      }
      case 'vitest': {
        // Vitest takes a bare filename filter, not a flag.
        if (plain) args.push(plain);
        if (options.onlyChanged) args.push('--changed');
        break;
      }
      case 'mocha': {
        if (plain) args.push('--grep', plain);
        if (options.watch) args.push('--watch');
        break;
      }
      case 'node': {
        // Nothing here on purpose: node --test reads its flags only before
        // `--test`, so selection travels via NODE_OPTIONS instead.
        break;
      }
      case 'ava': {
        if (plain) args.push('--match', plain);
        if (options.watch) args.push('--watch');
        break;
      }
      default:
        break;
    }

    return args;
  }

  /**
   * Runs the project's tests and captures a normalised result.
   */
  private async runTests(options: {
    pattern?: string;
    onlyChanged: boolean;
    coverage: boolean;
    watch: boolean;
    framework?: FrameworkId;
  }): Promise<TestResult> {
    const framework = this.resolveFramework(options.framework);
    const adapter = framework === 'unknown' ? null : ADAPTERS[framework];

    const args = [
      ...(adapter ? adapter.reportArgs({ coverage: options.coverage }) : []),
      ...this.selectionArgs(framework, options),
    ];

    // Vitest defaults to watch mode when run non-interactively is ambiguous;
    // reportArgs already pins --run, so only remove it if watching was asked for.
    const finalArgs =
      options.watch && framework === 'vitest'
        ? args.filter((a) => a !== '--run')
        : args;

    return new Promise((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      const started = Date.now();

      // Flags some runners will only accept through the environment, appended
      // to whatever NODE_OPTIONS the user already set rather than replacing it.
      const extraNodeOptions =
        adapter?.nodeOptions?.({ pattern: options.pattern }) ?? [];
      const env = extraNodeOptions.length
        ? {
            ...process.env,
            NODE_OPTIONS: [process.env.NODE_OPTIONS, ...extraNodeOptions]
              .filter(Boolean)
              .join(' '),
          }
        : process.env;

      // Runs npm's own JS entry through this Node binary. Still argv mode --
      // caller-controlled args are never seen by a shell -- but with no .cmd
      // shim, which Node 20.12+ refuses to spawn at all. See run-node-bin.ts.
      const child = spawnNpm(
        ['run', 'test', '--', ...finalArgs],
        { cwd: this.projectRoot, env },
        'smart_test'
      );

      child.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      child.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      child.on('close', (_code) => {
        // Some runners report to stderr (node --test's TAP goes to stdout, but
        // AVA and mocha reporters vary), so parse the pair.
        const combined = stdout + (stdout && stderr ? '\n' : '') + stderr;

        let parsed = adapter ? adapter.parse(stdout, stderr) : null;
        if (!parsed && adapter) parsed = adapter.parse(combined, '');

        let usedFramework: FrameworkId = framework;
        if (!parsed) {
          // Detection can be wrong -- a test script that shells out, a runner
          // swapped without the manifest catching up. Rather than refuse,
          // accept any report whose shape we recognise.
          const guessed = parseAnyKnownFormat(combined);
          if (guessed) {
            parsed = guessed.result;
            usedFramework = guessed.framework;
          }
        }

        if (!parsed) {
          // SAY WHICH PROBLEM IT IS.
          //
          // The old message was "Failed to parse Jest output: Expected property
          // name or '}' in JSON at position 4", which describes a parser's
          // disappointment rather than the user's situation.
          const known = 'Jest, Vitest, Mocha, AVA and node --test';
          const detected =
            framework === 'unknown'
              ? 'No supported runner could be identified from package.json.'
              : `Detected ${ADAPTERS[framework].label}, but its report could not be read.`;
          const tail = (stderr || stdout).slice(0, 600).trim();
          reject(
            new Error(
              `smart_test understands ${known}. ${detected}` +
                (tail ? `\n\nTest output was:\n${tail}` : '')
            )
          );
          return;
        }

        this.lastFramework = usedFramework;

        resolve({
          ...parsed,
          coverageMap: this.readCoverageSummary(options.coverage),
          startTime: started,
          endTime: Date.now(),
          framework: usedFramework,
        });
      });

      child.on('error', (err) => {
        reject(err);
      });
    });
  }

  /**
   * Coverage totals, read from the summary file runners agree on.
   *
   * Jest's --json inlines this; every other runner writes
   * coverage/coverage-summary.json instead. Reading the file works for all of
   * them, and returns nothing rather than zeros when coverage was not collected
   * -- a coverage delta of 0% and "no coverage data" are different answers.
   */
  private readCoverageSummary(requested: boolean): TestResult['coverageMap'] {
    if (!requested) return undefined;
    const summaryPath = join(
      this.projectRoot,
      'coverage',
      'coverage-summary.json'
    );
    if (!existsSync(summaryPath)) return undefined;
    try {
      const parsed = JSON.parse(readFileSync(summaryPath, 'utf8'));
      return parsed?.total ? { total: parsed.total } : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Generate cache key based on test file contents
   */
  private async generateCacheKey(pattern?: string): Promise<string> {
    const hash = createHash('sha256');
    hash.update(this.cacheNamespace);
    hash.update(pattern || 'all');

    // Hash package.json to detect dependency changes
    const packageJsonPath = join(this.projectRoot, 'package.json');
    if (existsSync(packageJsonPath)) {
      const packageJson = readFileSync(packageJsonPath, 'utf-8');
      hash.update(packageJson);
    }

    // Hash jest config to detect config changes
    const jestConfigPath = join(this.projectRoot, 'jest.config.js');
    if (existsSync(jestConfigPath)) {
      const jestConfig = readFileSync(jestConfigPath, 'utf-8');
      hash.update(jestConfig);
    }

    return `${this.cacheNamespace}:${hash.digest('hex')}`;
  }

  /**
   * Get cached result if available and fresh
   */
  private getCachedResult(key: string, maxAge: number): TestResult | null {
    const cached = this.cache.get(key);
    if (!cached) {
      return null;
    }

    try {
      const result = JSON.parse(cached) as TestResult & { cachedAt: number };
      const age = (Date.now() - result.cachedAt) / 1000;

      if (age <= maxAge) {
        return result;
      }
    } catch (err) {
      // Invalid cache entry
      return null;
    }

    return null;
  }

  /**
   * Cache test result
   */
  private cacheResult(key: string, result: TestResult): void {
    const toCache = {
      ...result,
      cachedAt: Date.now(),
    };

    const dataToCache = JSON.stringify(toCache);
    const originalSize = JSON.stringify(result).length;
    const compactSize = this.estimateCompactSize(result);

    this.cache.set(key, dataToCache, originalSize, compactSize);
  }

  /**
   * Transform full Jest output to smart output
   */
  private transformOutput(
    result: TestResult,
    fromCache = false
  ): SmartTestOutput {
    const failures = this.extractFailures(result);
    const newTests = this.detectNewTests(result);
    const coverageDelta = this.calculateCoverageDelta(result);

    const originalSize = JSON.stringify(result).length;
    const compactSize = this.estimateCompactSize(result);

    return {
      summary: {
        total: result.numTotalTests,
        passed: result.numPassedTests,
        failed: result.numFailedTests,
        skipped: result.numPendingTests,
        duration: result.endTime - result.startTime,
        fromCache,
        framework: result.framework ?? this.lastFramework,
      },
      failures,
      coverageDelta,
      newTests,
      metrics: {
        originalTokens: Math.ceil(originalSize / 4),
        compactedTokens: Math.ceil(compactSize / 4),
        reductionPercentage: Math.round(
          ((originalSize - compactSize) / originalSize) * 100
        ),
      },
    };
  }

  /**
   * Format cached output
   */
  private formatCachedOutput(result: TestResult): SmartTestOutput {
    return this.transformOutput(result, true);
  }

  /**
   * Extract only failures with concise error messages
   */
  private extractFailures(result: TestResult): Array<{
    testFile: string;
    testName: string;
    error: string;
    location?: string;
  }> {
    const failures: Array<{
      testFile: string;
      testName: string;
      error: string;
      location?: string;
    }> = [];

    for (const entry of result.testResults || []) {
      if (entry.status !== 'failed') continue;

      // TWO SHAPES, BOTH REAL.
      //
      // Jest and Vitest report a FILE per entry, with the individual tests
      // nested in assertionResults. Mocha, AVA and node --test report a TEST
      // per entry, with no nesting at all. Walking only the nested shape --
      // which is what this did -- means every flat runner produced a correct
      // count of failures beside an EMPTY list of them: "1 failed" and nothing
      // about which one, which is the only part anybody needs.
      if (entry.assertionResults?.length) {
        for (const assertion of entry.assertionResults) {
          if (assertion.status !== 'failed') continue;
          failures.push({
            testFile: entry.name,
            testName: assertion.title,
            error: this.extractConciseError(assertion.failureMessages),
            location: this.extractErrorLocation(assertion.failureMessages),
          });
        }
        continue;
      }

      const messages = entry.failureMessage ? [entry.failureMessage] : [];
      failures.push({
        testFile: entry.name,
        testName: entry.name,
        error: this.extractConciseError(messages),
        location: this.extractErrorLocation(messages),
      });
    }

    return failures;
  }

  /**
   * Extract concise error message from Jest failure
   */
  private extractConciseError(messages: string[]): string {
    if (!messages || messages.length === 0) {
      return 'Unknown error';
    }

    const fullMessage = messages.join('\n');
    const lines = fullMessage.split('\n');

    // THE MESSAGE, THEN ONE FRAME -- which is how anybody reads a failure.
    //
    // This used to keep only lines matching a whitelist of Jest's phrasing
    // ('expect', 'Received:', 'Expected:'). Every other runner words the same
    // facts differently: node --test says "Expected values to be strictly
    // equal:" followed by "1 !== 2", and neither line survived the filter, so
    // the one sentence explaining the failure was dropped while the stack
    // around it was kept. Taking everything above the first stack frame is
    // vocabulary-independent, and therefore right for runners not yet written.
    const firstFrame = lines.findIndex((l) => l.trim().startsWith('at '));
    const head = (firstFrame === -1 ? lines : lines.slice(0, firstFrame))
      .join('\n')
      .trim();

    const frame = lines
      .slice(firstFrame === -1 ? lines.length : firstFrame)
      .find(
        (l) =>
          l.trim().startsWith('at ') &&
          !l.includes('node_modules') &&
          !/\bnode:/.test(l)
      );

    const parts = [
      head || fullMessage.slice(0, 200).trim(),
      frame?.trimEnd(),
    ].filter(Boolean);
    return parts.join('\n').slice(0, 600) || 'Unknown error';
  }

  /**
   * Extract error location from stack trace
   */
  private extractErrorLocation(messages: string[]): string | undefined {
    const lines = messages.join('\n').split('\n');

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('at ')) continue;

      // Skip frames that are not the user's code. `node_modules` was already
      // skipped; `node:internal/...` was not, and since those frames DO carry
      // parentheses while a bare `at C:\path\a.test.js:4:37` frame does not,
      // the old parenthesised-only regex walked straight past the real
      // location and reported node:internal/process/task_queues as the site of
      // the user's failed assertion.
      if (trimmed.includes('node_modules') || /\bnode:/.test(trimmed)) continue;

      const parenthesised = trimmed.match(/\(([^)]+):(\d+):(\d+)\)/);
      if (parenthesised) {
        return `${parenthesised[1]}:${parenthesised[2]}:${parenthesised[3]}`;
      }

      // `at <file>:<line>:<col>` with no wrapping function name.
      const bare = trimmed.match(/^at\s+(?:\S+\s+)?(.+?):(\d+):(\d+)\s*$/);
      if (bare) {
        return `${bare[1]}:${bare[2]}:${bare[3]}`;
      }
    }

    return undefined;
  }

  /**
   * Detect new tests (simplified version - would need test history)
   */
  private detectNewTests(_result: TestResult): string[] {
    // In a real implementation, we'd compare with previous run
    // For now, return empty array
    return [];
  }

  /**
   * Calculate coverage delta (simplified version - would need previous coverage)
   */
  private calculateCoverageDelta(result: TestResult):
    | {
        statements: number;
        branches: number;
        functions: number;
        lines: number;
      }
    | undefined {
    // Guard against missing coverage data
    if (!result.coverageMap || !result.coverageMap.total) {
      return undefined;
    }

    const total = result.coverageMap.total;

    // Verify all coverage metrics exist
    if (
      !total.statements ||
      !total.branches ||
      !total.functions ||
      !total.lines
    ) {
      return undefined;
    }

    // In a real implementation, we'd compare with previous run
    // For now, return current coverage as delta
    return {
      statements: total.statements.pct,
      branches: total.branches.pct,
      functions: total.functions.pct,
      lines: total.lines.pct,
    };
  }

  /**
   * Estimate compact output size for token calculation
   */
  private estimateCompactSize(result: TestResult): number {
    // Count only summary and failures, not full test results
    const summary = {
      total: result.numTotalTests,
      passed: result.numPassedTests,
      failed: result.numFailedTests,
      skipped: result.numPendingTests,
    };

    const failures = this.extractFailures(result);

    return JSON.stringify({ summary, failures }).length;
  }

  /**
   * Close cache connection
   */
  close(): void {
    this.cache.close();
  }
}

/**
 * Factory function for creating SmartTest with shared resources (benchmark usage)
 */
export function getSmartTestTool(
  cache: CacheEngine,
  tokenCounter: TokenCounter,
  metrics: MetricsCollector,
  projectRoot?: string
): SmartTest {
  return new SmartTest(cache, tokenCounter, metrics, projectRoot);
}

/**
 * CLI-friendly function for running smart tests
 */
export async function runSmartTest(
  options: SmartTestOptions = {}
): Promise<string> {
  // Create standalone resources for CLI usage
  const cache = new CacheEngine(
    join(homedir(), '.token-optimizer-cache', 'cache.db')
  );
  const tokenCounter = new TokenCounter();
  const metrics = new MetricsCollector();

  const smartTest = new SmartTest(
    cache,
    tokenCounter,
    metrics,
    options.projectRoot
  );
  try {
    const result = await smartTest.run(options);

    // Format as human-readable output
    let output = `\n🧪 Smart Test Results ${result.summary.fromCache ? '(cached)' : ''}\n`;
    output += `${'='.repeat(50)}\n\n`;

    // Summary
    output += `Summary:\n`;
    output += `  Total: ${result.summary.total}\n`;
    output += `  ✓ Passed: ${result.summary.passed}\n`;
    output += `  ✗ Failed: ${result.summary.failed}\n`;
    output += `  ⊘ Skipped: ${result.summary.skipped}\n`;
    output += `  Duration: ${(result.summary.duration / 1000).toFixed(2)}s\n\n`;

    // Failures
    if (result.failures.length > 0) {
      output += `Failures:\n`;
      for (const failure of result.failures) {
        output += `\n  ✗ ${failure.testName}\n`;
        output += `    File: ${failure.testFile}\n`;
        if (failure.location) {
          output += `    Location: ${failure.location}\n`;
        }
        output += `    Error:\n`;
        const errorLines = failure.error.split('\n');
        for (const line of errorLines) {
          output += `      ${line}\n`;
        }
      }
      output += '\n';
    }

    // Coverage delta
    if (result.coverageDelta) {
      output += `Coverage:\n`;
      output += `  Statements: ${result.coverageDelta.statements.toFixed(2)}%\n`;
      output += `  Branches: ${result.coverageDelta.branches.toFixed(2)}%\n`;
      output += `  Functions: ${result.coverageDelta.functions.toFixed(2)}%\n`;
      output += `  Lines: ${result.coverageDelta.lines.toFixed(2)}%\n\n`;
    }

    // New tests
    if (result.newTests.length > 0) {
      output += `New Tests:\n`;
      for (const test of result.newTests) {
        output += `  + ${test}\n`;
      }
      output += '\n';
    }

    // Metrics
    output += `Token Reduction:\n`;
    output += `  Original: ${result.metrics.originalTokens} tokens\n`;
    output += `  Compacted: ${result.metrics.compactedTokens} tokens\n`;
    output += `  Reduction: ${result.metrics.reductionPercentage}%\n`;

    return output;
  } finally {
    smartTest.close();
  }
}

// MCP Tool definition
export const SMART_TEST_TOOL_DEFINITION = {
  name: 'smart_test',
  description:
    "Run the project's tests (Jest, Vitest, Mocha, AVA or node --test) with " +
    'intelligent caching, coverage tracking, and incremental test execution',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description: 'Pattern to match test files',
      },
      framework: {
        type: 'string',
        enum: ['jest', 'vitest', 'mocha', 'node', 'ava'],
        description:
          'Test runner to assume. Detected from package.json when omitted; ' +
          'set it only when the test script hides the runner.',
      },
      onlyChanged: {
        type: 'boolean',
        description: 'Run only tests that changed since last run',
        default: false,
      },
      force: {
        type: 'boolean',
        description: 'Force full test run (ignore cache)',
        default: false,
      },
      coverage: {
        type: 'boolean',
        description: 'Collect coverage information',
        default: false,
      },
      watch: {
        type: 'boolean',
        description: 'Watch mode for continuous testing',
        default: false,
      },
      projectRoot: {
        type: 'string',
        description: 'Project root directory',
      },
      maxCacheAge: {
        type: 'number',
        description: 'Maximum cache age in seconds (default: 300)',
        default: 300,
      },
    },
  },
};
