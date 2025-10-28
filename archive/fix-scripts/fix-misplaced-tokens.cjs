#!/usr/bin/env node
/**
 * Fix misplaced .tokens that ended up inside function calls
 * Pattern: .count(...).tokens) should be .count(...)).tokens
 */

const fs = require('fs');
const path = require('path');
const { glob } = require('glob');

async function fixFiles() {
  const files = await glob('src/tools/**/*.ts', { cwd: process.cwd() });

  let totalFixed = 0;
  let filesModified = 0;

  for (const file of files) {
    const fullPath = path.join(process.cwd(), file);
    let content = fs.readFileSync(fullPath, 'utf-8');
    const original = content;
    let fileFixed = 0;

    // Pattern: .count(JSON.stringify(...).tokens)
    // Should be: .count(JSON.stringify(...))).tokens
    content = content.replace(
      /\.count\(((?:JSON\.stringify|[^)]+))\)\.tokens\)/g,
      (match, inner) => {
        // Check if .tokens is misplaced inside the parens
        if (inner.includes('.tokens')) {
          fileFixed++;
          const fixed = inner.replace(/\.tokens$/, '');
          return `.count(${fixed})).tokens`;
        }
        return match;
      }
    );

    // Pattern 2: More general - any .count(...X.tokens) where X is not a closing paren
    content = content.replace(
      /\.count\(([^)]*?)\.tokens\)/g,
      (match, inner) => {
        fileFixed++;
        return `.count(${inner})).tokens`;
      }
    );

    if (content !== original) {
      fs.writeFileSync(fullPath, content, 'utf-8');
      console.log(`✓ ${file}: Fixed ${fileFixed} misplaced .tokens`);
      filesModified++;
      totalFixed += fileFixed;
    }
  }

  console.log(`\n✓ Total: Fixed ${totalFixed} misplaced .tokens in ${filesModified} files`);
}

fixFiles().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
