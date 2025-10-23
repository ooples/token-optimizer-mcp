#!/usr/bin/env node
/**
 * Fix ES Module Imports - Add .js extensions to relative imports
 *
 * This script adds .js extensions to all relative imports in TypeScript source files
 * to ensure proper ES module resolution in Node.js.
 *
 * Example:
 *   Before: import { foo } from '../bar';
 *   After:  import { foo } from '../bar.js';
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from 'fs';
import { join, extname } from 'path';

/**
 * Recursively find all TypeScript files in a directory
 */
function findTypeScriptFiles(dir, fileList = []) {
  const files = readdirSync(dir);

  for (const file of files) {
    const filePath = join(dir, file);
    const stat = statSync(filePath);

    if (stat.isDirectory()) {
      // Skip node_modules and dist
      if (file !== 'node_modules' && file !== 'dist') {
        findTypeScriptFiles(filePath, fileList);
      }
    } else if (extname(file) === '.ts' && !file.endsWith('.d.ts')) {
      fileList.push(filePath);
    }
  }

  return fileList;
}

/**
 * Fix imports in a single file
 */
function fixImportsInFile(filePath) {
  let content = readFileSync(filePath, 'utf-8');
  let modified = false;

  // Pattern to match relative imports without .js extension
  // Matches: from './foo' or from '../foo' or from '../../foo'
  // But not: from './foo.js' or from 'external-package'
  const importPattern = /from ['"](\.\.[\/\\](?:[^'"]+)|\.\/(?:[^'"]+))(?<!\.js)['"]/g;

  const newContent = content.replace(importPattern, (match, importPath) => {
    // Don't add .js if it already has an extension
    if (importPath.endsWith('.js') ||
        importPath.endsWith('.json') ||
        importPath.endsWith('.node')) {
      return match;
    }

    modified = true;
    return `from '${importPath}.js'`;
  });

  if (modified) {
    writeFileSync(filePath, newContent, 'utf-8');
    console.log(`✓ Fixed imports in: ${filePath}`);
    return 1;
  }

  return 0;
}

// Main execution
const srcDir = 'src';
console.log('Finding TypeScript files...');
const tsFiles = findTypeScriptFiles(srcDir);
console.log(`Found ${tsFiles.length} TypeScript files`);

console.log('\nFixing imports...');
let fixedCount = 0;

for (const file of tsFiles) {
  fixedCount += fixImportsInFile(file);
}

console.log(`\n✅ Fixed ${fixedCount} files`);
console.log('✅ All imports now have .js extensions for proper ES module resolution');
