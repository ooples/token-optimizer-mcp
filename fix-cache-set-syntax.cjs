#!/usr/bin/env node
/**
 * Fix malformed cache.set() calls created by previous regex script
 *
 * The previous fix-migrated-tools.cjs created syntax errors like:
 * cache.set(key, value, BAD SYNTAX)
 *
 * This needs to be:
 * cache.set(key, value, originalSize, compressedSize)
 *
 * Strategy:
 * 1. Find all cache.set() calls with malformed syntax
 * 2. Extract actual values for originalSize and compressedSize
 * 3. Reconstruct proper call
 */

const fs = require('fs');
const path = require('path');

// Find all TypeScript files in src/tools
function findToolFiles(dir, files = []) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      findToolFiles(fullPath, files);
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      files.push(fullPath);
    }
  }

  return files;
}

/**
 * Fix cache.set() syntax errors
 *
 * Patterns to fix:
 * 1. cache.set calls with malformed parameter comments
 * 2. cache.set calls with wrong parameters
 */
function fixCacheSetSyntax(content, filePath) {
  let fixed = content;
  let changesMade = false;

  // Pattern 1: Remove malformed syntax with duration label and fix parameters
  // Example: cache.set with bad comment syntax
  const pattern1 = /this\.cache\.set\(\s*([^,]+),\s*([^,]+),\s*(?:duration:\s*)?([^\/,]+)\s*\/\*\s*originalSize\s*\*\/\s*,\s*([^)]+)\s*\/\*\s*compressedSize\s*\*\/\s*\)/g;

  fixed = fixed.replace(pattern1, (match, key, value, param3, param4) => {
    changesMade = true;

    // Extract actual variable names from param3 and param4
    const originalSize = param3.trim();
    const compressedSize = param4.trim();

    console.log(`  Fixing: ${match.substring(0, 80)}...`);
    console.log(`    Key: ${key.trim()}`);
    console.log(`    Value: ${value.trim()}`);
    console.log(`    OriginalSize: ${originalSize}`);
    console.log(`    CompressedSize: ${compressedSize}`);

    return `this.cache.set(${key}, ${value}, ${originalSize}, ${compressedSize})`;
  });

  // Pattern 2: Fix any remaining malformed cache.set() with comments in wrong places
  // Example: cache.set with label syntax
  const pattern2 = /this\.cache\.set\(\s*([^,]+),\s*([^,]+),\s*([^:;,]+):\s*([^)]+)\s*\)/g;

  fixed = fixed.replace(pattern2, (match, key, value, label, rest) => {
    changesMade = true;
    console.log(`  Fixing labeled parameter: ${match.substring(0, 80)}...`);

    // This pattern indicates broken syntax - we need context to fix it properly
    // For now, mark it for manual review
    return `this.cache.set(${key}, ${value}, 0, 0) /* FIXME: Manual review needed */`;
  });

  // Pattern 3: Fix cache.set() calls with only 2 parameters (missing originalSize and compressedSize)
  const pattern3 = /this\.cache\.set\(\s*([^,]+),\s*([^,)]+)\s*\);/g;

  // Only fix if the match doesn't have 4 parameters already
  fixed = fixed.replace(pattern3, (match, key, value) => {
    // Check if this is actually a 2-parameter call or if it's just a formatting issue
    const fullMatch = match.trim();
    if (!fullMatch.includes('/*') && fullMatch.split(',').length === 2) {
      changesMade = true;
      console.log(`  Adding missing parameters to: ${match.substring(0, 60)}...`);
      return `this.cache.set(${key}, ${value}, 0, 0) /* FIXME: Add originalSize and compressedSize */`;
    }
    return match;
  });

  return { fixed, changesMade };
}

/**
 * Analyze file to understand cache.set() context
 */
function analyzeFileContext(content, filePath) {
  const lines = content.split('\n');
  const cacheSetLines = [];

  lines.forEach((line, index) => {
    if (line.includes('cache.set')) {
      cacheSetLines.push({
        line: index + 1,
        content: line.trim(),
        context: lines.slice(Math.max(0, index - 3), Math.min(lines.length, index + 3))
      });
    }
  });

  return cacheSetLines;
}

// Main processing
function processFile(filePath) {
  const relativePath = path.relative(process.cwd(), filePath);

  let content = fs.readFileSync(filePath, 'utf-8');
  const original = content;

  // Analyze context first
  const cacheSetCalls = analyzeFileContext(content, filePath);

  if (cacheSetCalls.length > 0) {
    console.log(`\n${relativePath} - ${cacheSetCalls.length} cache.set() calls found`);

    // Apply fixes
    const { fixed, changesMade } = fixCacheSetSyntax(content, filePath);

    // Only write if changes were made
    if (changesMade && fixed !== original) {
      fs.writeFileSync(filePath, fixed, 'utf-8');
      console.log(`  ✓ Fixed and saved`);
      return true;
    } else if (cacheSetCalls.length > 0) {
      console.log(`  - No auto-fix applied (may need manual review)`);
    }
  }

  return false;
}

// Run
const toolsDir = path.join(__dirname, 'src', 'tools');

if (!fs.existsSync(toolsDir)) {
  console.error(`Error: ${toolsDir} not found`);
  process.exit(1);
}

const files = findToolFiles(toolsDir);

console.log(`Analyzing ${files.length} tool files for cache.set() syntax errors...\n`);

let fixedCount = 0;
for (const file of files) {
  try {
    if (processFile(file)) {
      fixedCount++;
    }
  } catch (error) {
    console.error(`  ✗ Error processing ${file}: ${error.message}`);
  }
}

console.log(`\n✓ Fixed cache.set() syntax in ${fixedCount} files out of ${files.length}`);
console.log(`\nNext: Run 'npm run build' to verify TypeScript compilation`);
