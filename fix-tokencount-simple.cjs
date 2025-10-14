#!/usr/bin/env node
/**
 * Simple fix: Add .tokens to all tokenCounter.count() and countTokens() calls
 * that are assigned to number variables
 */

const fs = require('fs');
const path = require('path');
const { glob } = require('glob');

async function fixFiles() {
  // Find all .ts files in src/tools
  const files = await glob('src/tools/**/*.ts', { cwd: process.cwd() });

  console.log(`Found ${files.length} TypeScript files\n`);

  let totalFixed = 0;
  let filesModified = 0;

  for (const file of files) {
    const fullPath = path.join(process.cwd(), file);
    let content = fs.readFileSync(fullPath, 'utf-8');
    const original = content;
    let fileFixed = 0;

    // Pattern 1: const x = this.tokenCounter.count(...)
    // Add .tokens if not already there
    content = content.replace(
      /(\bconst\s+\w+\s*=\s*this\.tokenCounter\.count\([^)]+\))(?!\.tokens)/g,
      (match) => {
        if (!match.endsWith('.tokens')) {
          fileFixed++;
          return match + '.tokens';
        }
        return match;
      }
    );

    // Pattern 2: const x = tokenCounter.count(...)
    content = content.replace(
      /(\bconst\s+\w+\s*=\s*tokenCounter\.count\([^)]+\))(?!\.tokens)/g,
      (match) => {
        if (!match.endsWith('.tokens')) {
          fileFixed++;
          return match + '.tokens';
        }
        return match;
      }
    );

    // Pattern 3: const x = await countTokens(...)
    content = content.replace(
      /(\bconst\s+\w+\s*=\s*await\s+countTokens\([^)]+\))(?!\.tokens)/g,
      (match) => {
        if (!match.endsWith('.tokens')) {
          fileFixed++;
          return match + '.tokens';
        }
        return match;
      }
    );

    // Pattern 4: property: this.tokenCounter.count(...),
    content = content.replace(
      /(:\s*this\.tokenCounter\.count\([^)]+\))(?!\.tokens)(?=,|\s*\})/g,
      (match) => {
        fileFixed++;
        return match + '.tokens';
      }
    );

    // Pattern 5: property: tokenCounter.count(...),
    content = content.replace(
      /(:\s*tokenCounter\.count\([^)]+\))(?!\.tokens)(?=,|\s*\})/g,
      (match) => {
        fileFixed++;
        return match + '.tokens';
      }
    );

    if (content !== original) {
      fs.writeFileSync(fullPath, content, 'utf-8');
      console.log(`✓ ${file}: Fixed ${fileFixed} occurrences`);
      filesModified++;
      totalFixed += fileFixed;
    }
  }

  console.log(`\n✓ Total: Fixed ${totalFixed} occurrences in ${filesModified} files`);
  console.log('\nNext: Run npm run build to verify');
}

fixFiles().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
