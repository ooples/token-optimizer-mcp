#!/usr/bin/env node

/**
 * Migration script to refactor all tools to use centralized cache-helper.ts
 *
 * This script automates the refactoring of 75 tool files to use the new
 * cacheSet() and cacheGet() utilities instead of direct cache.set() calls.
 *
 * Changes made:
 * 1. Add import for cacheSet and cacheGet
 * 2. Remove compress/decompress imports if only used for caching
 * 3. Replace cache.set() calls with cacheSet()
 * 4. Replace cache.get() + decompress with cacheGet()
 * 5. Update variable declarations to use CacheGetResult
 */

import fs from 'fs';
import path from 'path';
import { glob } from 'glob';

// Tool directories to process
const TOOL_DIRS = [
  'src/tools/advanced-caching',
  'src/tools/api-database',
  'src/tools/build-systems',
  'src/tools/code-analysis',
  'src/tools/configuration',
  'src/tools/dashboard-monitoring',
  'src/tools/file-operations',
  'src/tools/intelligence',
  'src/tools/output-formatting',
  'src/tools/system-operations',
];

/**
 * Check if file needs migration
 */
function needsMigration(content) {
  // Check for compress/decompress imports used with cache
  const hasCompression = content.includes("from '../shared/compression-utils'") ||
                        content.includes("from '../../shared/compression-utils'");

  // Check for cache.set() calls
  const hasCacheSet = content.includes('.cache.set(') || content.includes('this.cache.set(');

  // Check for decompress usage with cache
  const hasDecompress = content.includes('decompress(') && content.includes('.cache.get(');

  return hasCompression && (hasCacheSet || hasDecompress);
}

/**
 * Migrate a single file
 */
function migrateFile(filePath) {
  console.log(`Migrating: ${filePath}`);

  let content = fs.readFileSync(filePath, 'utf-8');
  let modified = false;

  // Step 1: Add cache-helper import if not present
  if (!content.includes("from '../../utils/cache-helper'") &&
      !content.includes("from '../utils/cache-helper'")) {

    // Determine correct import path based on tool depth
    const depth = filePath.split(path.sep).filter(p => p === 'tools').length;
    const importPath = depth === 1 ? '../utils/cache-helper' : '../../utils/cache-helper';

    // Find the compression-utils import and add cache-helper before it
    const compressionImport = content.match(/import.*from ['"]\.\.\/.*compression-utils['"]/);
    if (compressionImport) {
      const importLine = `import { cacheSet, cacheGet } from '${importPath}';\n`;
      content = content.replace(compressionImport[0], importLine + compressionImport[0]);
      modified = true;
    }
  }

  // Step 2: Replace cache.set() calls
  // Pattern: cache.set(key, compressed.toString(), tokensSaved, ttl)
  // Replace with: cacheSet(cache, key, content)
  const cacheSetPattern = /(this\.cache|cache)\.set\(\s*([^,]+),\s*result\.compressed\.toString\(['"]base64['"]\),\s*result\.originalSize,\s*result\.compressedSize\s*\)/g;
  if (cacheSetPattern.test(content)) {
    content = content.replace(cacheSetPattern, (match, cacheVar, key) => {
      return `cacheSet(${cacheVar}, ${key}, rawContent)`;
    });
    modified = true;
  }

  // Old buggy pattern: cache.set(key, compressed.toString(), ...)
  const oldCacheSetPattern = /(this\.cache|cache)\.set\(\s*([^,]+),\s*\w+\.toString\(\),\s*[^,]+,\s*[^)]+\)/g;
  if (oldCacheSetPattern.test(content)) {
    content = content.replace(oldCacheSetPattern, (match, cacheVar, key) => {
      return `cacheSet(${cacheVar}, ${key}, rawContent)`;
    });
    modified = true;
  }

  // Step 3: Replace cache.get() + decompress pattern
  // Pattern: const cached = cache.get(key); decompress(Buffer.from(cached, 'base64'), 'gzip')
  const cacheGetPattern = /const\s+(\w+)\s*=\s*(this\.cache|cache)\.get\(([^)]+)\);/g;
  let matches = [...content.matchAll(cacheGetPattern)];

  for (const match of matches) {
    const varName = match[1];
    const cacheVar = match[2];
    const key = match[3];

    // Check if followed by decompress
    const decompressCheck = new RegExp(`decompress\\(\\s*Buffer\\.from\\(${varName}`);
    if (decompressCheck.test(content)) {
      // Replace with cacheGet
      const newLine = `const ${varName} = cacheGet(${cacheVar}, ${key});`;
      content = content.replace(match[0], newLine);

      // Replace decompress usage with .content access
      const decompressPattern = new RegExp(`decompress\\(\\s*Buffer\\.from\\(${varName},\\s*['"]base64['"]\\),\\s*['"]gzip['"]\\)\\.toString\\(\\)`, 'g');
      content = content.replace(decompressPattern, `${varName}.content`);

      modified = true;
    }
  }

  // Step 4: Remove compress/decompress imports if no longer needed
  const hasCompress = content.includes('compress(') && !content.includes('cacheSet(');
  const hasDecompress = content.includes('decompress(') && !content.includes('.content');

  if (!hasCompress && !hasDecompress) {
    // Remove the entire compression-utils import
    content = content.replace(/import\s*{[^}]*}\s*from\s*['"][^'"]*compression-utils['"]\s*;\s*/g, '');
    modified = true;
  } else if (!hasCompress || !hasDecompress) {
    // Remove only unused import
    if (!hasCompress) {
      content = content.replace(/,?\s*compress\s*,?/, '');
    }
    if (!hasDecompress) {
      content = content.replace(/,?\s*decompress\s*,?/, '');
    }
    modified = true;
  }

  // Step 5: Fix unused ttl variable warnings
  content = content.replace(/const\s+{\s*ttl\s*=/g, 'const { ttl: _ttl =');

  if (modified) {
    fs.writeFileSync(filePath, content, 'utf-8');
    console.log(`  ✓ Migrated successfully`);
    return true;
  } else {
    console.log(`  - No changes needed`);
    return false;
  }
}

/**
 * Main migration process
 */
async function main() {
  console.log('Starting cache-helper migration...\n');

  let totalFiles = 0;
  let migratedFiles = 0;
  let skippedFiles = 0;

  for (const dir of TOOL_DIRS) {
    console.log(`\nProcessing directory: ${dir}`);

    const pattern = path.join(dir, '**', '*.ts').replace(/\\/g, '/');
    const files = await glob(pattern, {
      cwd: process.cwd(),
      absolute: true
    });

    for (const file of files) {
      // Skip non-smart tools and test files
      if (file.includes('.test.') || file.includes('.spec.')) {
        continue;
      }

      totalFiles++;
      const content = fs.readFileSync(file, 'utf-8');

      if (needsMigration(content)) {
        const success = migrateFile(file);
        if (success) {
          migratedFiles++;
        } else {
          skippedFiles++;
        }
      } else {
        console.log(`Skipping: ${file} (no migration needed)`);
        skippedFiles++;
      }
    }
  }

  console.log('\n' + '='.repeat(50));
  console.log('Migration Summary:');
  console.log(`  Total files processed: ${totalFiles}`);
  console.log(`  Files migrated: ${migratedFiles}`);
  console.log(`  Files skipped: ${skippedFiles}`);
  console.log('='.repeat(50));

  if (migratedFiles > 0) {
    console.log('\nNext steps:');
    console.log('1. Run: npm run build');
    console.log('2. Fix any remaining TypeScript errors');
    console.log('3. Run: npm test');
    console.log('4. Commit changes');
  }
}

main().catch(console.error);
