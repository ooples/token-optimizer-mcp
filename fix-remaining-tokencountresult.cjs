#!/usr/bin/env node
/**
 * Fix remaining TokenCountResult assignments that need .tokens property
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Get list of files with TS2322 TokenCountResult errors
console.log('Finding files with TokenCountResult type assignment errors...\n');

try {
  const buildOutput = execSync(
    'npm run build 2>&1',
    { encoding: 'utf-8', cwd: process.cwd(), maxBuffer: 10 * 1024 * 1024 }
  );

  const lines = buildOutput.split('\n');
  const tokenCountErrors = lines
    .filter(line => line.includes("error TS2322") && line.includes("TokenCountResult"))
    .map(line => {
      const match = line.match(/^(.+\.ts)\((\d+),(\d+)\):/);
      if (match) {
        return {
          file: match[1],
          line: parseInt(match[2]),
          col: parseInt(match[3])
        };
      }
      return null;
    })
    .filter(Boolean);

  const fileMap = {};
  tokenCountErrors.forEach(error => {
    if (!fileMap[error.file]) {
      fileMap[error.file] = [];
    }
    fileMap[error.file].push(error.line);
  });

  console.log(`Found ${tokenCountErrors.length} TokenCountResult type errors in ${Object.keys(fileMap).length} files\n`);

  let totalFixed = 0;

  for (const [file, lines] of Object.entries(fileMap)) {
    const fullPath = path.join(process.cwd(), file);
    let content = fs.readFileSync(fullPath, 'utf-8');
    const original = content;
    const contentLines = content.split('\n');

    console.log(`\nProcessing: ${file}`);
    console.log(`  Lines with errors: ${lines.join(', ')}`);

    let fixCount = 0;

    // Fix each line
    lines.forEach(lineNum => {
      const lineIndex = lineNum - 1;
      const line = contentLines[lineIndex];

      // Pattern 1: const tokens = this.tokenCounter.count(...)
      // Should be: const tokens = this.tokenCounter.count(...).tokens
      if (line.match(/=\s*this\.tokenCounter\.count\([^)]+\);?\s*$/)) {
        contentLines[lineIndex] = line.replace(/count\(([^)]+)\);?\s*$/, 'count($1).tokens;');
        fixCount++;
      }
      // Pattern 2: const tokens = tokenCounter.count(...)
      else if (line.match(/=\s*tokenCounter\.count\([^)]+\);?\s*$/)) {
        contentLines[lineIndex] = line.replace(/count\(([^)]+)\);?\s*$/, 'count($1).tokens;');
        fixCount++;
      }
      // Pattern 3: const tokens = await countTokens(...)
      else if (line.match(/=\s*await\s+countTokens\([^)]+\);?\s*$/)) {
        contentLines[lineIndex] = line.replace(/countTokens\(([^)]+)\);?\s*$/, '(await countTokens($1)).tokens;');
        fixCount++;
      }
      // Pattern 4: property: this.tokenCounter.count(...)
      else if (line.match(/:\s*this\.tokenCounter\.count\([^)]+\),?\s*$/)) {
        contentLines[lineIndex] = line.replace(/count\(([^)]+)\),?\s*$/, 'count($1).tokens,');
        fixCount++;
      }
    });

    if (fixCount > 0) {
      content = contentLines.join('\n');
      fs.writeFileSync(fullPath, content, 'utf-8');
      console.log(`  ✓ Fixed ${fixCount} lines`);
      totalFixed += fixCount;
    } else {
      console.log(`  - No automatic fixes applied (manual review needed)`);
    }
  }

  console.log(`\n✓ Total: Fixed ${totalFixed} TokenCountResult assignments`);
  console.log('\nNext: Run npm run build to verify');

} catch (error) {
  if (error.stdout) {
    // npm run build returns non-zero exit code, but we still get output
    console.log('Parsing build errors (build failed as expected)...\n');
  } else {
    console.error('Error:', error.message);
    process.exit(1);
  }
}
