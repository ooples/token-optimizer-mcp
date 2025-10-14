#!/usr/bin/env node
/**
 * Revert incorrect .tokens additions from fix-tokencount-simple.cjs
 * These were placed INSIDE count() calls instead of AFTER them
 *
 * Pattern to fix:
 *   count(X.tokens) -> count(X)
 *   count(JSON.stringify(data).tokens) -> count(JSON.stringify(data))
 */

const fs = require('fs');
const path = require('path');
const { glob } = require('glob');

async function revertFiles() {
  const files = await glob('src/tools/**/*.ts', { cwd: process.cwd() });

  console.log(`Found ${files.length} TypeScript files\n`);

  let totalReverted = 0;
  let filesModified = 0;

  for (const file of files) {
    const fullPath = path.join(process.cwd(), file);
    let content = fs.readFileSync(fullPath, 'utf-8');
    const original = content;
    let fileReverted = 0;

    // Pattern 1: Remove .tokens that appears INSIDE count() arguments
    // Examples:
    //   count(JSON.stringify(data).tokens) -> count(JSON.stringify(data))
    //   count(text.trim().tokens) -> count(text.trim())
    // The .tokens should be AFTER the count() call, not inside it
    const beforeCount = content;
    content = content.replace(
      /\.count\(([^()]*(?:\([^()]*\)[^()]*)*?)\.tokens\)/g,
      (match, inner) => {
        fileReverted++;
        return `.count(${inner})`;
      }
    );

    // Pattern 2: Same for countTokens()
    content = content.replace(
      /countTokens\(([^()]*(?:\([^()]*\)[^()]*)*?)\.tokens\)/g,
      (match, inner) => {
        fileReverted++;
        return `countTokens(${inner})`;
      }
    );

    if (content !== original) {
      fs.writeFileSync(fullPath, content, 'utf-8');
      console.log(`✓ ${file}: Reverted ${fileReverted} incorrect .tokens`);
      filesModified++;
      totalReverted += fileReverted;
    }
  }

  console.log(`\n✓ Total: Reverted ${totalReverted} incorrect .tokens in ${filesModified} files`);
  console.log('\nNext: Run npm run build to verify error count decreased');
}

revertFiles().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
