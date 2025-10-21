#!/usr/bin/env node
/**
 * Fix corrupted method calls created by previous regex script
 *
 * Issues to fix:
 * 1. metrics.record() calls broken by inserted comments
 * 2. cache.set() calls with FIXME comments need proper parameters
 */

const fs = require('fs');
const path = require('path');

// Files with known issues
const problematicFiles = [
  'src/tools/advanced-caching/cache-compression.ts',
  'src/tools/advanced-caching/cache-replication.ts',
  'src/tools/api-database/smart-cache-api.ts',
  'src/tools/api-database/smart-orm.ts',
  'src/tools/api-database/smart-websocket.ts',
  'src/tools/configuration/smart-env.ts',
  'src/tools/dashboard-monitoring/alert-manager.ts',
  'src/tools/dashboard-monitoring/custom-widget.ts',
  'src/tools/dashboard-monitoring/report-generator.ts'
];

function fixFile(filePath) {
  const fullPath = path.join(process.cwd(), filePath);
  let content = fs.readFileSync(fullPath, 'utf-8');
  const original = content;

  console.log(`\nProcessing: ${filePath}`);

  // Fix 1: Corrupted metrics.record() calls
  // Pattern: operation: `...` /* compressedSize */);
  // Should be: operation: `...`, ...other params...});
  content = content.replace(
    /(operation:\s*`[^`]+`)\s*\/\*\s*compressedSize\s*\*\/\);/g,
    (match, operation) => {
      console.log(`  Fixed metrics.record() call`);
      return `${operation},
      duration: Date.now() - startTime,
      success: true,
      cacheHit: false,
      inputTokens: 0,
      outputTokens: result.metadata.tokensUsed,
      cachedTokens: 0,
      savedTokens: result.metadata.tokensSaved,
      metadata: result.metadata
    });`;
    }
  );

  // Fix 2: cache.set() with FIXME comments
  // Pattern: cache.set(key, value, 0, 0) /* FIXME: Manual review needed */;
  // Should be: cache.set(key, value, Buffer.byteLength(serialized), compressed.length);
  content = content.replace(
    /this\.cache\.set\(([^,]+),\s*([^,]+),\s*0,\s*0\)\s*\/\*\s*FIXME:[^*]+\*\/;/g,
    (match, key, value) => {
      console.log(`  Fixed cache.set() with FIXME`);
      // For the typical pattern in cache operations
      return `this.cache.set(${key}, ${value}, Buffer.byteLength(serialized), ${value}.length);`;
    }
  );

  // Fix 3: Handle remaining malformed cache.set patterns
  // Look for incomplete cache.set calls with strange syntax
  content = content.replace(
    /this\.cache\.set\(([^;]+)\s*\/\*[^*]+\*\/\s*\);/g,
    (match, params) => {
      console.log(`  Fixed malformed cache.set()`);
      // Try to extract proper parameters
      const parts = params.split(',').map(p => p.trim());
      if (parts.length >= 2) {
        return `this.cache.set(${parts[0]}, ${parts[1]}, 0, 0);`;
      }
      return match; // Can't fix, leave as is
    }
  );

  // Only write if changes were made
  if (content !== original) {
    fs.writeFileSync(fullPath, content, 'utf-8');
    console.log(`  ✓ Fixed and saved`);
    return true;
  } else {
    console.log(`  - No changes needed`);
    return false;
  }
}

// Process all problematic files
let fixedCount = 0;
for (const file of problematicFiles) {
  try {
    if (fixFile(file)) {
      fixedCount++;
    }
  } catch (error) {
    console.error(`  ✗ Error: ${error.message}`);
  }
}

console.log(`\n✓ Fixed ${fixedCount} out of ${problematicFiles.length} files`);
console.log(`\nNext: Run 'npm run build' to verify compilation`);
