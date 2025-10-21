#!/usr/bin/env node
/**
 * Comprehensive fix: Remove ALL incorrect .success property checks from TokenCountResult
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Get ALL files with .success on token count results
console.log('Finding all files with TokenCountResult .success usage...\n');
const grepOutput = execSync(
  'grep -r "CountResult\\.success" src/tools --include="*.ts"',
  { encoding: 'utf-8', cwd: process.cwd() }
).trim();

const files = [...new Set(grepOutput.split('\n').map(line => {
  const match = line.match(/^([^:]+):/);
  return match ? match[1] : null;
}).filter(Boolean))];

console.log(`Found ${files.length} files with TokenCountResult .success usage:\n`);
files.forEach(f => console.log(`  - ${f}`));

let totalFixed = 0;

for (const file of files) {
  const fullPath = path.join(process.cwd(), file);
  let content = fs.readFileSync(fullPath, 'utf-8');
  const original = content;

  console.log(`\nProcessing: ${file}`);

  // Pattern: Remove .success ternary for ANY variable ending with CountResult
  // Examples:
  //   tokenCountResult.success ? tokenCountResult.tokens : 0
  //   originalTokenCountResult.success ? originalTokenCountResult.tokens : 0
  //   summaryTokenCountResult.success ? summaryTokenCountResult.tokens : 0

  const regex = /(\w+CountResult)\.success\s*\?\s*\1\.tokens\s*:\s*0/g;
  const matches = content.match(regex);

  if (matches) {
    console.log(`  Found ${matches.length} patterns to fix`);
    content = content.replace(regex, '$1.tokens');
    totalFixed += matches.length;
  }

  if (content !== original) {
    fs.writeFileSync(fullPath, content, 'utf-8');
    console.log(`  ✓ Fixed and saved`);
  } else {
    console.log(`  - No changes needed`);
  }
}

console.log(`\n✓ Total: Removed ${totalFixed} incorrect .success checks from ${files.length} files`);
console.log('\nNext: Run npm run build to verify');
