#!/usr/bin/env node
/**
 * Fix underscore prefixes in import statements
 *
 * This script removes underscore prefixes from imported names in TypeScript files.
 * Example: import { _CacheEngine } from "..." → import { CacheEngine } from "..."
 *
 * Root cause: When files have broken imports with underscores, TypeScript can't parse
 * the file properly, causing cascade TS2305 "no exported member" errors.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Configuration
const SRC_DIR = path.join(__dirname, 'src', 'tools');
const DRY_RUN = false; // Set to true to see changes without modifying files

// Statistics
let filesProcessed = 0;
let filesModified = 0;
let importsFixed = 0;

/**
 * Fix underscore prefixes in import statements
 */
function fixImportUnderscores(content) {
  const lines = content.split('\n');
  let modified = false;
  let fixCount = 0;

  const fixedLines = lines.map(line => {
    // Only process import lines
    if (!line.trim().startsWith('import ')) {
      return line;
    }

    // Replace underscore prefixes in imported names
    // Pattern: _Name or _name (underscore followed by letter)
    const fixedLine = line.replace(/_([a-zA-Z][a-zA-Z0-9]*)/g, (match, name) => {
      fixCount++;
      return name;
    });

    if (fixedLine !== line) {
      modified = true;
    }

    return fixedLine;
  });

  return {
    content: fixedLines.join('\n'),
    modified,
    fixCount
  };
}

/**
 * Process a single TypeScript file
 */
function processFile(filePath) {
  filesProcessed++;

  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const result = fixImportUnderscores(content);

    if (result.modified) {
      filesModified++;
      importsFixed += result.fixCount;

      console.log(`✓ ${path.relative(process.cwd(), filePath)} - Fixed ${result.fixCount} imports`);

      if (!DRY_RUN) {
        fs.writeFileSync(filePath, result.content, 'utf-8');
      }
    }
  } catch (error) {
    console.error(`✗ Error processing ${filePath}: ${error.message}`);
  }
}

/**
 * Recursively find and process all .ts files
 */
function processDirectory(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      processDirectory(fullPath);
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      processFile(fullPath);
    }
  }
}

// Main execution
console.log('='.repeat(80));
console.log('FIX IMPORT UNDERSCORES');
console.log('='.repeat(80));
console.log(`Directory: ${SRC_DIR}`);
console.log(`Dry run: ${DRY_RUN ? 'YES (no changes will be made)' : 'NO (files will be modified)'}`);
console.log();

// Process all files
processDirectory(SRC_DIR);

// Print summary
console.log();
console.log('='.repeat(80));
console.log('SUMMARY');
console.log('='.repeat(80));
console.log(`Files processed: ${filesProcessed}`);
console.log(`Files modified: ${filesModified}`);
console.log(`Imports fixed: ${importsFixed}`);
console.log();

if (DRY_RUN) {
  console.log('⚠️  DRY RUN - No files were actually modified');
  console.log('   Set DRY_RUN = false in the script to apply changes');
} else {
  console.log('✅ Changes applied successfully');
  console.log();
  console.log('Next steps:');
  console.log('1. Run: npm run build 2>&1 | grep -c "error TS"');
  console.log('2. Verify error count reduced significantly');
  console.log('3. Assess remaining errors');
}
