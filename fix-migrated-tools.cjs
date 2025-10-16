#!/usr/bin/env node
/**
 * Fix API mismatches in migrated tools from hypercontext-mcp
 *
 * This script updates all migrated tools to use token-optimizer-mcp's current API:
 * 1. Fix TokenCounter.count() - use .tokens property from returned object
 * 2. Fix cache.set() - update to (key, value, originalSize, compressedSize)
 * 3. Fix cache.get() - handle string returns (not Buffer)
 * 4. Replace CacheEngine.generateKey() with generateCacheKey from hash-utils
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

// Fix 1: TokenCounter.count() returns object, not number
function fixTokenCounterUsage(content) {
  let fixed = content;

  // Pattern 1: const tokens = this.tokenCounter.count(content);
  // Should be: const tokens = this.tokenCounter.count(content).tokens;
  fixed = fixed.replace(
    /const\s+(\w*[Tt]okens?\w*)\s*=\s*this\.tokenCounter\.count\(([^)]+)\);/g,
    'const $1 = this.tokenCounter.count($2).tokens;'
  );

  // Pattern 2: tokenCounter.count() in expressions
  fixed = fixed.replace(
    /this\.tokenCounter\.count\(([^)]+)\)\s*([+\-*/<>=!])/g,
    'this.tokenCounter.count($1).tokens $2'
  );

  return fixed;
}

// Fix 2: cache.set() signature change
function fixCacheSetUsage(content) {
  let fixed = content;

  // OLD: cache.set(key, compressed.compressed, ttl, tokensSaved, fileHash)
  // NEW: cache.set(key, value, originalSize, compressedSize)

  // Most common pattern in migrated files
  fixed = fixed.replace(
    /this\.cache\.set\(\s*([^,]+),\s*([^,]+),\s*([^,]+),\s*([^,]+)(?:,\s*[^)]+)?\s*\);/g,
    (match, key, value, param3, param4) => {
      // The migrated tools often have: cache.set(key, compressed, ttl, tokensSaved)
      // We need: cache.set(key, compressed, originalSize, compressedSize)
      return `this.cache.set(${key}, ${value}, ${param4} /* originalSize */, ${param3} /* compressedSize */);`;
    }
  );

  return fixed;
}

// Fix 3: cache.get() returns string, not Buffer
function fixCacheGetUsage(content) {
  let fixed = content;

  // Remove .toString('utf-8') calls on cache.get() results
  fixed = fixed.replace(
    /this\.cache\.get\(([^)]+)\)\.toString\(\s*['"]utf-?8['"]\s*\)/g,
    'this.cache.get($1)'
  );

  fixed = fixed.replace(
    /this\.cache\.get\(([^)]+)\)\.toString\(\)/g,
    'this.cache.get($1)'
  );

  // Fix variable type comments
  fixed = fixed.replace(
    /\/\/ Returns Buffer/g,
    '// Returns string'
  );

  return fixed;
}

// Fix 4: CacheEngine.generateKey() -> generateCacheKey from hash-utils
function fixGenerateKeyUsage(content) {
  let fixed = content;

  // Only proceed if CacheEngine.generateKey is used
  if (!content.includes('CacheEngine.generateKey')) {
    return fixed;
  }

  // Add import if not present
  if (!content.includes('generateCacheKey')) {
    // Find existing hash-utils import
    const hashUtilsImportMatch = fixed.match(/import\s*\{([^}]+)\}\s*from\s+['"]([^'"]*hash-utils\.js)['"]\s*;/);

    if (hashUtilsImportMatch) {
      // Add generateCacheKey to existing import
      const imports = hashUtilsImportMatch[1];
      if (!imports.includes('generateCacheKey')) {
        fixed = fixed.replace(
          /import\s*\{([^}]+)\}\s*from\s+['"]([^'"]*hash-utils\.js)['"]\s*;/,
          (match, imports, modulePath) => {
            const importsList = imports.split(',').map(i => i.trim());
            importsList.push('generateCacheKey');
            return `import { ${importsList.join(', ')} } from '${modulePath}';`;
          }
        );
      }
    } else {
      // Add new import - find the last import statement
      const lastImportMatch = fixed.match(/import[^;]+;(?=\s*\n(?:import|$))/g);
      if (lastImportMatch) {
        const lastImport = lastImportMatch[lastImportMatch.length - 1];
        fixed = fixed.replace(
          lastImport,
          lastImport + "\nimport { generateCacheKey } from '../shared/hash-utils.js';"
        );
      }
    }
  }

  // Replace CacheEngine.generateKey with generateCacheKey
  fixed = fixed.replace(
    /CacheEngine\.generateKey\(/g,
    'generateCacheKey('
  );

  return fixed;
}

// Main processing
function processFile(filePath) {
  console.log(`Processing: ${path.relative(process.cwd(), filePath)}`);

  let content = fs.readFileSync(filePath, 'utf-8');
  const original = content;

  // Apply all fixes
  content = fixTokenCounterUsage(content);
  content = fixCacheSetUsage(content);
  content = fixCacheGetUsage(content);
  content = fixGenerateKeyUsage(content);

  // Only write if changes were made
  if (content !== original) {
    fs.writeFileSync(filePath, content, 'utf-8');
    console.log(`  ✓ Fixed`);
    return true;
  } else {
    console.log(`  - No changes needed`);
    return false;
  }
}

// Run
const toolsDir = path.join(__dirname, 'src', 'tools');

if (!fs.existsSync(toolsDir)) {
  console.error(`Error: ${toolsDir} not found`);
  process.exit(1);
}

const files = findToolFiles(toolsDir);

console.log(`Found ${files.length} tool files\n`);

let fixedCount = 0;
for (const file of files) {
  try {
    if (processFile(file)) {
      fixedCount++;
    }
  } catch (error) {
    console.error(`  ✗ Error: ${error.message}`);
  }
}

console.log(`\n✓ Fixed ${fixedCount} files out of ${files.length}`);
console.log(`\nNOTE: cache.set() parameters may need manual verification`);
