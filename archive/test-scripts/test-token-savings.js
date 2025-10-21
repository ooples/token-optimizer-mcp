#!/usr/bin/env node

/**
 * Real-world test to verify token optimization is working correctly
 * This test will measure actual token savings from compression and caching
 */

import { CacheEngine } from './dist/core/cache-engine.js';
import { TokenCounter } from './dist/core/token-counter.js';
import { CompressionEngine } from './dist/core/compression-engine.js';

const SAMPLE_TEXTS = {
  small: 'Hello World! This is a small test text.',
  medium: `
    This is a medium-sized text that should demonstrate token optimization.
    Token Optimizer MCP is a Model Context Protocol server that reduces token usage
    through intelligent caching and compression. The server provides tools to compress
    text, cache results, and analyze token usage - helping you optimize context window utilization.
  `.trim(),
  large: `
    # Token Optimizer MCP - Comprehensive Documentation

    ## Overview
    Token Optimizer MCP is a Model Context Protocol (MCP) server that reduces token usage
    through intelligent caching and compression. The server provides tools to compress text,
    cache results, and analyze token usage - helping you optimize context window utilization.

    ## Key Features
    - **Token-Efficient Compression**: Brotli compression to reduce token count
    - **Persistent Caching**: SQLite-based cache that persists across sessions
    - **Accurate Token Counting**: Uses tiktoken for precise token measurements
    - **Compression Analysis**: Analyze text to determine if compression will help
    - **Zero External Dependencies**: Completely offline operation
    - **Production Ready**: Built with TypeScript for reliability

    ## Technology Stack
    - **Runtime**: Node.js 20+
    - **Language**: TypeScript
    - **Database**: SQLite (better-sqlite3)
    - **Token Counting**: tiktoken
    - **Compression**: Brotli (built-in)
    - **Caching**: LRU Cache
    - **Protocol**: MCP SDK (@modelcontextprotocol/sdk)

    ## Performance
    - **Compression Ratio**: Typically 2-4x size reduction
    - **Token Savings**: 50-70% token reduction on average
    - **Cache Hit Rate**: >80% in typical usage
    - **Overhead**: <10ms for cache operations
    - **Compression Speed**: ~1ms per KB of text
  `.trim(),
  repetitive: Array(100).fill('This is repetitive content. ').join(''),
  code: `
    export class TokenOptimizer {
      constructor(private cache: CacheEngine, private tokenCounter: TokenCounter) {}

      async optimize(text: string): Promise<OptimizationResult> {
        const originalTokens = await this.tokenCounter.count(text);
        const compressed = await this.compress(text);
        const compressedTokens = await this.tokenCounter.count(compressed);

        return {
          originalTokens,
          compressedTokens,
          savings: originalTokens - compressedTokens,
          percentSaved: ((originalTokens - compressedTokens) / originalTokens) * 100
        };
      }
    }
  `.trim()
};

async function testTokenOptimization() {
  console.log('\n🧪 Token Optimization Real-World Test\n');
  console.log('=' .repeat(80));

  // Initialize components
  const cache = new CacheEngine('./.test-cache/cache.db');
  const tokenCounter = new TokenCounter();
  const compression = new CompressionEngine();

  const results = [];

  for (const [name, text] of Object.entries(SAMPLE_TEXTS)) {
    console.log(`\n📝 Testing: ${name.toUpperCase()}`);
    console.log('-'.repeat(80));

    // 1. Count original tokens
    const originalResult = tokenCounter.count(text);
    const originalTokens = originalResult.tokens;
    const originalSize = text.length;

    // 2. Compress the text
    const compressedResult = compression.compressToBase64(text);
    const compressed = compressedResult.compressed;
    const compressedSize = compressedResult.compressedSize;

    // 3. Count compressed tokens (base64 encoded compressed data is a string)
    const compressedTokens = tokenCounter.count(compressed).tokens;

    // 4. Calculate savings
    const tokenSavings = originalTokens - compressedTokens;
    const percentSaved = ((tokenSavings / originalTokens) * 100).toFixed(2);
    const compressionRatio = (originalSize / compressedSize).toFixed(2);

    // 5. Test caching
    const cacheKey = `test-${name}-${Date.now()}`;
    cache.set(cacheKey, compressed, originalSize, compressedSize);
    const cached = cache.get(cacheKey);
    const cacheHit = cached !== null;

    const result = {
      name,
      originalTokens,
      compressedTokens,
      tokenSavings,
      percentSaved: parseFloat(percentSaved),
      originalSize,
      compressedSize,
      compressionRatio: parseFloat(compressionRatio),
      cacheHit
    };

    results.push(result);

    // Display results
    console.log(`  Original Text Size:    ${originalSize.toLocaleString()} bytes`);
    console.log(`  Compressed Size:       ${compressedSize.toLocaleString()} bytes`);
    console.log(`  Compression Ratio:     ${compressionRatio}x`);
    console.log(`  `);
    console.log(`  Original Tokens:       ${originalTokens.toLocaleString()}`);
    console.log(`  Compressed Tokens:     ${compressedTokens.toLocaleString()}`);
    console.log(`  Tokens Saved:          ${tokenSavings.toLocaleString()} (${percentSaved}%)`);
    console.log(`  Cache Hit:             ${cacheHit ? '✅ YES' : '❌ NO'}`);

    // Verify token savings
    if (tokenSavings > 0) {
      console.log(`  Status:                ✅ WORKING - Token reduction achieved!`);
    } else if (tokenSavings === 0) {
      console.log(`  Status:                ⚠️  WARNING - No token reduction (text too small)`);
    } else {
      console.log(`  Status:                ❌ FAILED - Compression increased tokens!`);
    }

    // Clean up
    cache.delete(cacheKey);
  }

  // Summary
  console.log('\n' + '='.repeat(80));
  console.log('\n📊 SUMMARY\n');

  const totalOriginalTokens = results.reduce((sum, r) => sum + r.originalTokens, 0);
  const totalCompressedTokens = results.reduce((sum, r) => sum + r.compressedTokens, 0);
  const totalSavings = totalOriginalTokens - totalCompressedTokens;
  const avgPercentSaved = (results.reduce((sum, r) => sum + r.percentSaved, 0) / results.length).toFixed(2);
  const avgCompressionRatio = (results.reduce((sum, r) => sum + r.compressionRatio, 0) / results.length).toFixed(2);
  const allCacheHits = results.every(r => r.cacheHit);

  console.log(`  Total Tests:           ${results.length}`);
  console.log(`  Total Original Tokens: ${totalOriginalTokens.toLocaleString()}`);
  console.log(`  Total Compressed:      ${totalCompressedTokens.toLocaleString()}`);
  console.log(`  Total Tokens Saved:    ${totalSavings.toLocaleString()}`);
  console.log(`  Average % Saved:       ${avgPercentSaved}%`);
  console.log(`  Average Compression:   ${avgCompressionRatio}x`);
  console.log(`  Cache Functionality:   ${allCacheHits ? '✅ Working' : '❌ Failed'}`);

  // Final verdict
  console.log('\n' + '='.repeat(80));

  if (totalSavings > 0 && allCacheHits) {
    console.log('\n✅ SUCCESS: Token optimization is working correctly!');
    console.log(`   - Achieved ${avgPercentSaved}% average token reduction`);
    console.log(`   - Cache operations working properly`);
    console.log(`   - Compression ratio: ${avgCompressionRatio}x`);
  } else if (totalSavings > 0 && !allCacheHits) {
    console.log('\n⚠️  PARTIAL SUCCESS: Token reduction working, but cache issues detected');
  } else {
    console.log('\n❌ FAILURE: Token optimization is not working as expected!');
  }

  console.log('\n');

  // Cleanup
  cache.close();

  // Exit with appropriate code
  process.exit(totalSavings > 0 && allCacheHits ? 0 : 1);
}

// Run the test
testTokenOptimization().catch((error) => {
  console.error('\n❌ Test failed with error:', error);
  process.exit(1);
});
