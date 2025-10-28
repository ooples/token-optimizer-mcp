#!/usr/bin/env node
/**
 * CORRECTIVE FIX: Remove incorrect .success property checks
 * AgentTeams 1-3 added .success checks that don't exist on TokenCountResult
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Get list of files with .success errors
console.log('Finding files with incorrect .success property usage...\n');
const grepOutput = execSync(
  'grep -r "tokenResult.success ?" src/tools --include="*.ts"',
  { encoding: 'utf-8', cwd: process.cwd() }
).trim();

const files = [...new Set(grepOutput.split('\n').map(line => {
  const match = line.match(/^([^:]+):/);
  return match ? match[1] : null;
}).filter(Boolean))];

console.log(`Found ${files.length} files with incorrect .success usage:\n`);
files.forEach(f => console.log(`  - ${f}`));

let totalFixed = 0;

for (const file of files) {
  const fullPath = path.join(process.cwd(), file);
  let content = fs.readFileSync(fullPath, 'utf-8');
  const original = content;

  // Pattern 1: Remove .success check in variable assignment
  // tokenResult.success ? tokenResult.tokens : 0  -->  tokenResult.tokens
  content = content.replace(
    /(\w+)\.success\s*\?\s*\1\.tokens\s*:\s*0/g,
    '$1.tokens'
  );

  // Pattern 2: Remove .success check in IIFE
  // tokenResult.success ? tokenResult.tokens : 0  -->  tokenResult.tokens
  content = content.replace(
    /(\w+Result)\.success\s*\?\s*\1\.tokens\s*:\s*0/g,
    '$1.tokens'
  );

  if (content !== original) {
    fs.writeFileSync(fullPath, content, 'utf-8');
    const changes = (original.match(/\.success\s*\?/g) || []).length;
    console.log(`\n✓ Fixed ${file}: removed ${changes} .success checks`);
    totalFixed += changes;
  }
}

console.log(`\n✓ Total: Removed ${totalFixed} incorrect .success checks from ${files.length} files`);
console.log('\nNext: Run npm run build to verify');
