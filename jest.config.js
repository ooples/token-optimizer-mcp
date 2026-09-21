export default {
  preset: 'ts-jest/presets/default-esm',
  // BOUNDED BECAUSE THIS SUITE SPAWNS PROCESSES, and the default does not know
  // that. Jest sizes its pool from CPU count -- fifteen workers on this machine
  // -- and dozens of these tests spawn a real hook binary, an MCP server or the
  // CLI, so the true concurrency is fifteen workers TIMES their children.
  //
  // Measured: a hook spawn costs 204-241ms standalone (bare `node -e ""` is 84ms,
  // so most of it is module loading, and it is the same with an empty graph as
  // with a 45MB one -- the hook is lazy, there is no data-size regression here).
  // Under fifteen-way oversubscription those same spawns blow a 5s budget: three
  // suites failed at the default, one or two at four workers, and the failing set
  // ROTATED between runs, which is the signature of contention rather than of a
  // defect in any one test. Each passes alone.
  //
  // Halving the pool is the correct fix rather than raising the timeouts: the
  // budgets are honest for the work being done, and it is the scheduling that
  // was wrong.
  maxWorkers: '50%',

  testEnvironment: 'node',
  extensionsToTreatAsEsm: ['.ts'],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        useESM: true,
      },
    ],
  },
  // .mjs is matched so the hook tests run: the hooks ship as plain ESM Node
  // files (no build step, because Claude Code executes them directly from the
  // installed plugin directory), and they must be covered by the same suite.
  testMatch: [
    '**/__tests__/**/*.test.ts',
    '**/*.test.ts',
    '**/*.test.mjs',
    '**/*.bench.ts',
  ],
  // Linked worktrees are independent checkouts, not nested test fixtures. If a
  // worktree lives under this checkout, discovering it would execute stale PR
  // tests a second time and contaminate the current branch's evidence.
  testPathIgnorePatterns: [
    '/node_modules/',
    '/dist/',
    '<rootDir>/worktrees/',
    // A competitor's checkout, kept for head-to-head measurement. It ships
    // its own TypeScript suites, and discovering them ran 31 foreign,
    // uniformly failing suites on every local `npm test` -- hiding ours
    // inside the noise. CI never saw it, because .codex/ is gitignored,
    // so the cost fell entirely on whoever read a local run.
    '<rootDir>/.codex/',
  ],
  // Points file backups at a temp directory for every worker, so no test can
  // write into the developer's real ~/.token-optimizer/backups. See the file
  // for why this is not left to individual tests to remember.
  setupFiles: ['<rootDir>/tests/setup-isolated-home.cjs'],
  collectCoverageFrom: ['src/**/*.ts', '!src/**/*.d.ts', '!src/**/*.test.ts'],
  // Coverage thresholds disabled for initial release
  // Will be gradually increased as test coverage improves
  // coverageThreshold: {
  //   global: {
  //     branches: 80,
  //     functions: 80,
  //     lines: 80,
  //     statements: 80,
  //   },
  // },
};
