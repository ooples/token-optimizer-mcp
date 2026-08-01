export default {
  preset: 'ts-jest/presets/default-esm',
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
  testMatch: ['**/__tests__/**/*.test.ts', '**/*.test.ts', '**/*.test.mjs', '**/*.bench.ts'],
  testPathIgnorePatterns: ['/node_modules/', '/dist/'],
  // Points file backups at a temp directory for every worker, so no test can
  // write into the developer's real ~/.token-optimizer/backups. See the file
  // for why this is not left to individual tests to remember.
  setupFiles: ['<rootDir>/tests/setup-isolated-home.cjs'],
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.d.ts',
    '!src/**/*.test.ts',
  ],
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
