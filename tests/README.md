# Token Optimizer MCP - Test Suite

Comprehensive test infrastructure for the Token Optimizer MCP server, achieving 80%+ code coverage.

## Test Structure

```
tests/
├── unit/                       # Unit tests for core components
│   ├── cache-engine.test.ts
│   ├── token-counter.test.ts
│   ├── compression-engine.test.ts
│   ├── metrics.test.ts
│   ├── cache-validation.test.ts
│   └── null-safety.test.ts
├── integration/                # Integration tests
│   └── claude-desktop-harness.test.ts
├── benchmarks/                 # Performance benchmarks
│   ├── performance.bench.ts
│   └── results.json
└── README.md                   # This file
```

## Running Tests

### All Tests
```bash
npm test
```

### Unit Tests Only
```bash
npm run test:unit
```

### Integration Tests Only
```bash
npm run test:integration
```

### Benchmarks Only
```bash
npm run test:benchmark
```

### Coverage Report
```bash
npm run test:coverage
```

### Watch Mode (for development)
```bash
npm run test:watch
```

### CI Mode
```bash
npm run test:ci
```

## Test Coverage Targets

The project maintains strict coverage thresholds:

- **Branches**: 80%
- **Functions**: 80%
- **Lines**: 80%
- **Statements**: 80%

Current coverage is tracked in the `coverage/` directory after running `npm run test:coverage`.

## Unit Tests

### CacheEngine Tests (`cache-engine.test.ts`)
Tests for the core caching system:
- Basic operations (get, set, delete, clear)
- Cache statistics and metrics
- LRU eviction
- Hit/miss tracking
- Memory and disk cache interaction
- Database persistence

### TokenCounter Tests (`token-counter.test.ts`)
Tests for token counting functionality:
- Basic token counting
- Batch counting
- Token estimation
- Savings calculation
- Token limit checking and truncation
- Character-to-token ratio calculation

### CompressionEngine Tests (`compression-engine.test.ts`)
Tests for compression functionality:
- Compression and decompression
- Compression ratios and statistics
- Base64 encoding/decoding
- Batch compression
- Compression quality levels
- Compression recommendations

### MetricsCollector Tests (`metrics.test.ts`)
Tests for metrics collection:
- Metric recording
- Cache statistics calculation
- Operation breakdown
- Performance percentiles
- Time-based filtering
- Event emission

### Cache Validation Tests (`cache-validation.test.ts`)
Specialized tests for caching validation:
- Cache hit/miss ratio validation
- Compression ratio verification (95%+ target)
- Cache persistence across sessions
- Cache invalidation logic
- Different cache storage backends

### Null Safety Tests (`null-safety.test.ts`)
Tests for null/undefined handling:
- Nullish coalescing (??)
- Optional chaining (?.)
- Default values
- Runtime null reference safety

## Integration Tests

### Claude Desktop Harness (`claude-desktop-harness.test.ts`)
End-to-end integration tests:
- MCP server connection
- Configuration generation
- Server startup and tool registration
- All tool categories execution
- Full optimization workflow

## Benchmarks

### Performance Benchmarks (`performance.bench.ts`)
Performance and regression tests:
- Token counting benchmarks
- Compression benchmarks
- Cache operation benchmarks
- Metrics collection benchmarks
- End-to-end workflow benchmarks
- Memory usage tracking
- Regression detection

Benchmark results are saved to `tests/benchmarks/results.json` after running.

## Writing New Tests

### Test File Naming Convention
- Unit tests: `*.test.ts`
- Integration tests: `*.test.ts` (in `integration/` folder)
- Benchmarks: `*.bench.ts` (in `benchmarks/` folder)

### Example Test Structure

```typescript
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { YourClass } from '../../src/path/to/class.js';

describe('YourClass', () => {
  let instance: YourClass;

  beforeEach(() => {
    instance = new YourClass();
  });

  afterEach(() => {
    // Clean up
  });

  describe('Feature Name', () => {
    it('should do something specific', () => {
      const result = instance.method();
      expect(result).toBe(expectedValue);
    });
  });
});
```

## Test Setup Requirements

### Prerequisites
- Node.js >= 18.0.0
- npm >= 9.0.0

### Installation
```bash
npm install
```

### Build Project
```bash
npm run build
```

## Continuous Integration

The test suite is configured for CI environments:
- Uses `--ci` flag for CI-optimized runs
- Generates coverage reports in LCOV format
- Limits workers to 2 for resource efficiency
- Fails on threshold violations

## Performance Standards

All tests should complete within these time limits:
- Unit tests: < 5 minutes total
- Integration tests: < 2 minutes total
- Benchmarks: < 3 minutes total

Individual test timeouts are configured in `jest.config.js`.

## Debugging Tests

### Running a Single Test File
```bash
npm test -- tests/unit/cache-engine.test.ts
```

### Running Tests Matching a Pattern
```bash
npm test -- --testNamePattern="should compress"
```

### Verbose Output
```bash
npm test -- --verbose
```

## Coverage Report

After running `npm run test:coverage`, view the HTML report:
```
coverage/lcov-report/index.html
```

## Benchmark Results

Benchmark results include:
- Average duration
- Min/max duration
- Percentiles (p50, p90, p95, p99)
- Throughput (operations/second)
- Memory usage

Results are saved to `tests/benchmarks/results.json` and can be compared across runs to detect regressions.

## Test Data

Test data is stored in temporary directories:
- Cache database: `os.tmpdir()/token-optimizer-test/`
- Temporary files are cleaned up after each test

## Known Issues

None currently. If you encounter issues:
1. Ensure all dependencies are installed: `npm install`
2. Rebuild the project: `npm run build`
3. Clear Jest cache: `npx jest --clearCache`

## Contributing

When adding new tests:
1. Follow the existing test structure
2. Maintain 80%+ coverage
3. Ensure tests are deterministic
4. Clean up resources in `afterEach`
5. Document complex test scenarios

## Contact

For questions or issues with the test suite, please open an issue on GitHub:
https://github.com/ooples/token-optimizer-mcp/issues
