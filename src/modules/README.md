# Optimization Module Plugin Architecture

This directory contains the plugin architecture for token optimization modules. The system is designed to be extensible, allowing you to create custom optimization plugins that can be chained together in a pipeline.

## Table of Contents

- [Overview](#overview)
- [Architecture](#architecture)
- [Creating Custom Modules](#creating-custom-modules)
- [Built-in Modules](#built-in-modules)
- [Pipeline Orchestration](#pipeline-orchestration)
- [Best Practices](#best-practices)
- [Examples](#examples)

## Overview

The optimization module system provides a flexible, composable architecture for text optimization. Each module is a self-contained plugin that:

- Implements the `IOptimizationModule` interface
- Takes text as input and returns optimized text with metrics
- Tracks its own token savings and metadata
- Can be combined with other modules in a pipeline

## Architecture

### Core Interface

All optimization modules implement the `IOptimizationModule` interface:

```typescript
interface IOptimizationModule {
  readonly name: string;
  apply(text: string): Promise<OptimizationResult>;
}
```

### Optimization Result

Each module returns a detailed `OptimizationResult`:

```typescript
interface OptimizationResult {
  text: string;                // Optimized text
  originalTokens: number;      // Token count before optimization
  optimizedTokens: number;     // Token count after optimization
  savings: number;             // Tokens saved (can be negative)
  moduleName: string;          // Module identifier
  metadata?: Record<string, unknown>; // Optional module-specific data
}
```

### Pipeline Orchestration

The `TokenOptimizer` class chains modules together:

```typescript
const optimizer = new TokenOptimizer([module1, module2, module3], tokenCounter);
const result = await optimizer.optimize(text);

// Result includes:
// - optimizedPrompt: final text
// - savings: total tokens saved
// - percentSaved: percentage reduction
// - moduleResults: per-module breakdown
// - executionTimeMs: performance metrics
```

## Creating Custom Modules

### Basic Template

Here's a template for creating a custom optimization module:

```typescript
import { IOptimizationModule, OptimizationResult } from './IOptimizationModule.js';
import { ITokenCounter } from '../interfaces/ITokenCounter.js';

/**
 * My custom optimization module.
 *
 * Brief description of what this module does and when to use it.
 *
 * @example
 * ```typescript
 * const tokenCounter = new TokenCounter();
 * const myModule = new MyCustomModule(tokenCounter, {
 *   option1: value1,
 *   option2: value2
 * });
 *
 * const result = await myModule.apply(text);
 * console.log(`Saved ${result.savings} tokens`);
 * ```
 */
export class MyCustomModule implements IOptimizationModule {
  readonly name = 'my-custom-module';

  constructor(
    private readonly tokenCounter: ITokenCounter,
    private readonly options?: {
      option1?: boolean;
      option2?: number;
    }
  ) {}

  async apply(text: string): Promise<OptimizationResult> {
    // 1. Count original tokens
    const originalTokenResult = await Promise.resolve(
      this.tokenCounter.count(text)
    );
    const originalTokens = originalTokenResult.tokens;

    // 2. Apply your optimization logic
    let optimized = text;
    const stats = {
      itemsProcessed: 0,
      itemsModified: 0,
    };

    // Your optimization logic here
    optimized = this.performOptimization(optimized, stats);

    // 3. Count optimized tokens
    const optimizedTokenResult = await Promise.resolve(
      this.tokenCounter.count(optimized)
    );
    const optimizedTokens = optimizedTokenResult.tokens;
    const savings = originalTokens - optimizedTokens;

    // 4. Return detailed result
    return {
      text: optimized,
      originalTokens,
      optimizedTokens,
      savings,
      moduleName: this.name,
      metadata: {
        itemsProcessed: stats.itemsProcessed,
        itemsModified: stats.itemsModified,
        // Add any module-specific metadata
      },
    };
  }

  private performOptimization(text: string, stats: any): string {
    // Your optimization logic goes here
    return text;
  }
}
```

### Step-by-Step Guide

1. **Define Your Module Class**
   - Implement `IOptimizationModule`
   - Choose a unique, descriptive name
   - Add JSDoc documentation

2. **Add Constructor Parameters**
   - Always accept `ITokenCounter` for measuring savings
   - Add optional configuration object for flexibility
   - Document all options with JSDoc

3. **Implement the `apply` Method**
   - Count tokens before optimization
   - Apply your optimization logic
   - Count tokens after optimization
   - Calculate savings
   - Return comprehensive result with metadata

4. **Track Statistics**
   - Count what you modify (items removed, changes made, etc.)
   - Include relevant metrics in metadata
   - Help users understand what the module did

5. **Handle Edge Cases**
   - Empty text
   - Very large text
   - Text that shouldn't be optimized
   - Preserve special content (code blocks, etc.)

6. **Write Tests**
   - Unit tests for your module
   - Integration tests with other modules
   - Performance tests for large inputs

## Built-in Modules

### CompressionModule

Compresses text using Brotli and base64 encoding for external caching.

```typescript
const compression = new CompressionModule(engine, tokenCounter, {
  quality: 11,        // Compression quality (0-11)
  mode: 'text',       // Optimization mode
  minSize: 1000       // Minimum text size to compress
});
```

**Use cases:**
- Caching large content externally
- Reducing storage size
- Archiving historical data

### WhitespaceOptimizationModule

Removes excessive whitespace while preserving structure.

```typescript
const whitespace = new WhitespaceOptimizationModule(tokenCounter, {
  preserveIndentation: false,      // Keep leading spaces
  maxConsecutiveNewlines: 2,       // Max newlines allowed
  preserveCodeBlocks: true         // Don't optimize code blocks
});
```

**Use cases:**
- Copy-pasted content with formatting issues
- Generated text with extra whitespace
- Code documentation with inconsistent spacing

### DeduplicationModule

Removes duplicate sentences and paragraphs.

```typescript
const dedup = new DeduplicationModule(tokenCounter, {
  caseSensitive: true,             // Case-sensitive comparison
  minSentenceLength: 5,            // Minimum length to dedupe
  preserveFirst: true,             // Keep first occurrence
  deduplicateParagraphs: false,    // Also dedupe paragraphs
  preserveCodeBlocks: true         // Don't dedupe code blocks
});
```

**Use cases:**
- Removing repeated boilerplate
- Cleaning up copy-paste artifacts
- Consolidating redundant information

## Pipeline Orchestration

### Creating a Pipeline

```typescript
import { TokenOptimizer } from '../services/TokenOptimizer.js';
import { TokenCounter } from '../core/token-counter.js';
import { CompressionEngine } from '../core/compression-engine.js';

// Create dependencies
const tokenCounter = new TokenCounter();
const compressionEngine = new CompressionEngine();

// Create modules
const whitespace = new WhitespaceOptimizationModule(tokenCounter);
const dedup = new DeduplicationModule(tokenCounter);
const compression = new CompressionModule(engine, tokenCounter);

// Create pipeline
const optimizer = new TokenOptimizer(
  [whitespace, dedup, compression],
  tokenCounter
);

// Optimize text
const result = await optimizer.optimize(largeText);
```

### Analyzing Results

```typescript
// Overall metrics
console.log(`Original: ${result.originalTokens} tokens`);
console.log(`Optimized: ${result.optimizedTokens} tokens`);
console.log(`Saved: ${result.savings} tokens (${result.percentSaved.toFixed(2)}%)`);
console.log(`Execution time: ${result.executionTimeMs}ms`);

// Per-module breakdown
console.log('\nModule breakdown:');
result.moduleResults.forEach(m => {
  console.log(`  ${m.moduleName}:`);
  console.log(`    In: ${m.tokensIn} tokens`);
  console.log(`    Out: ${m.tokensOut} tokens`);
  console.log(`    Saved: ${m.savings} tokens`);
  if (m.metadata) {
    console.log(`    Metadata:`, m.metadata);
  }
});
```

### Module Ordering

The order of modules in the pipeline matters:

```typescript
// Recommended order for most cases:
1. WhitespaceOptimizationModule   // Remove obvious waste first
2. DeduplicationModule            // Remove duplicates
3. CompressionModule              // Compress remaining content

// Why this order?
// - Whitespace removal makes deduplication more effective
// - Deduplication reduces content before compression
// - Compression is most effective on already-optimized text
```

## Best Practices

### Module Design

1. **Single Responsibility**
   - Each module should do one thing well
   - Don't try to combine multiple optimizations in one module

2. **Independence**
   - Modules should not depend on other modules
   - Modules should work correctly in any order

3. **Configuration**
   - Provide sensible defaults
   - Make important behaviors configurable
   - Document all options

4. **Performance**
   - Optimize for common cases
   - Handle large inputs efficiently
   - Consider memory usage

### Metadata

Include useful metadata in your results:

```typescript
return {
  // ... required fields ...
  metadata: {
    // Counts
    itemsProcessed: 100,
    itemsModified: 25,

    // Statistics
    averageReduction: 15.5,
    maxReduction: 50,

    // Configuration
    optionsUsed: { option1: true },

    // Warnings or notes
    warnings: ['Some items were skipped'],
  },
};
```

### Error Handling

```typescript
async apply(text: string): Promise<OptimizationResult> {
  try {
    // Your optimization logic
  } catch (error) {
    // On error, return original text with metadata
    const tokenResult = await Promise.resolve(
      this.tokenCounter.count(text)
    );

    return {
      text,
      originalTokens: tokenResult.tokens,
      optimizedTokens: tokenResult.tokens,
      savings: 0,
      moduleName: this.name,
      metadata: {
        error: error.message,
        failed: true,
      },
    };
  }
}
```

### Testing

Always test your modules:

```typescript
describe('MyCustomModule', () => {
  let module: MyCustomModule;
  let tokenCounter: MockTokenCounter;

  beforeEach(() => {
    tokenCounter = new MockTokenCounter();
    module = new MyCustomModule(tokenCounter);
  });

  it('should optimize text', async () => {
    const result = await module.apply('test text');
    expect(result.text).toBeTruthy();
    expect(result.savings).toBeGreaterThanOrEqual(0);
  });

  it('should handle empty text', async () => {
    const result = await module.apply('');
    expect(result.text).toBe('');
    expect(result.savings).toBe(0);
  });

  // Add more tests...
});
```

## Examples

### Example 1: URL Shortening Module

```typescript
export class URLShortenerModule implements IOptimizationModule {
  readonly name = 'url-shortener';

  constructor(
    private readonly tokenCounter: ITokenCounter,
    private readonly shortenerService: IURLShortener
  ) {}

  async apply(text: string): Promise<OptimizationResult> {
    const originalCount = await Promise.resolve(
      this.tokenCounter.count(text)
    );

    // Find URLs
    const urlRegex = /(https?:\/\/[^\s]+)/g;
    const urls = text.match(urlRegex) || [];
    let optimized = text;
    let urlsShortened = 0;

    // Shorten each URL
    for (const url of urls) {
      if (url.length > 30) {
        const short = await this.shortenerService.shorten(url);
        optimized = optimized.replace(url, short);
        urlsShortened++;
      }
    }

    const optimizedCount = await Promise.resolve(
      this.tokenCounter.count(optimized)
    );

    return {
      text: optimized,
      originalTokens: originalCount.tokens,
      optimizedTokens: optimizedCount.tokens,
      savings: originalCount.tokens - optimizedCount.tokens,
      moduleName: this.name,
      metadata: {
        urlsFound: urls.length,
        urlsShortened,
      },
    };
  }
}
```

### Example 2: Acronym Expander Module

```typescript
export class AcronymExpanderModule implements IOptimizationModule {
  readonly name = 'acronym-expander';

  constructor(
    private readonly tokenCounter: ITokenCounter,
    private readonly acronyms: Map<string, string>
  ) {}

  async apply(text: string): Promise<OptimizationResult> {
    const originalCount = await Promise.resolve(
      this.tokenCounter.count(text)
    );

    let optimized = text;
    let expanded = 0;

    // Expand each acronym
    for (const [acronym, expansion] of this.acronyms) {
      const regex = new RegExp(`\\b${acronym}\\b`, 'g');
      if (regex.test(optimized)) {
        optimized = optimized.replace(regex, expansion);
        expanded++;
      }
    }

    const optimizedCount = await Promise.resolve(
      this.tokenCounter.count(optimized)
    );

    return {
      text: optimized,
      originalTokens: originalCount.tokens,
      optimizedTokens: optimizedCount.tokens,
      savings: originalCount.tokens - optimizedCount.tokens,
      moduleName: this.name,
      metadata: {
        acronymsExpanded: expanded,
      },
    };
  }
}
```

## Contributing

When adding new modules to this directory:

1. Follow the template and patterns shown above
2. Add comprehensive JSDoc documentation
3. Include usage examples in comments
4. Write thorough unit tests
5. Add integration tests with other modules
6. Update this README with your module

## See Also

- [IOptimizationModule.ts](./IOptimizationModule.ts) - Interface definition
- [TokenOptimizer.ts](../services/TokenOptimizer.ts) - Pipeline orchestrator
- [Tests](../../tests/unit/) - Example tests for reference
