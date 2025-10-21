#!/usr/bin/env node
/**
 * Targeted fix for TokenCountResult type errors using compiler output
 * Only fixes lines that TypeScript reports as having TS2322 type errors
 *
 * Strategy:
 * 1. Run npm run build and capture output
 * 2. Parse error lines to find specific file:line:column locations
 * 3. Read each file and fix ONLY the reported lines
 * 4. Add .tokens property access where count() result is assigned to number type
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

async function fixTokenCountErrors() {
  console.log('Running TypeScript compiler to identify TokenCountResult type errors...\n');

  let buildOutput;
  try {
    buildOutput = execSync('npm run build 2>&1', {
      encoding: 'utf-8',
      cwd: process.cwd(),
      maxBuffer: 10 * 1024 * 1024
    });
  } catch (error) {
    // Build will fail with errors, but we get output
    buildOutput = error.stdout || error.stderr || '';
  }

  // Parse for TS2322 errors related to TokenCountResult assignments
  const lines = buildOutput.split('\n');
  const tokenCountErrors = [];

  for (const line of lines) {
    // Pattern: src/tools/file.ts(123,45): error TS2322: Type 'TokenCountResult' is not assignable to type 'number'
    const match = line.match(/^(.+\.ts)\((\d+),(\d+)\):\s*error TS2322.*TokenCountResult.*number/);
    if (match) {
      tokenCountErrors.push({
        file: match[1],
        line: parseInt(match[2]),
        col: parseInt(match[3])
      });
    }
  }

  console.log(`Found ${tokenCountErrors.length} TokenCountResult → number type errors\n`);

  if (tokenCountErrors.length === 0) {
    console.log('No TokenCountResult type errors found. Exiting.');
    return;
  }

  // Group errors by file
  const fileMap = {};
  for (const error of tokenCountErrors) {
    if (!fileMap[error.file]) {
      fileMap[error.file] = [];
    }
    fileMap[error.file].push(error.line);
  }

  let totalFixed = 0;
  let filesModified = 0;

  for (const [file, errorLines] of Object.entries(fileMap)) {
    const fullPath = path.join(process.cwd(), file);

    if (!fs.existsSync(fullPath)) {
      console.log(`⚠ Skipping ${file}: File not found`);
      continue;
    }

    let content = fs.readFileSync(fullPath, 'utf-8');
    const original = content;
    const contentLines = content.split('\n');

    console.log(`\nProcessing: ${file}`);
    console.log(`  Lines with errors: ${errorLines.join(', ')}`);

    let fileFixed = 0;

    // Fix each error line
    for (const lineNum of errorLines) {
      const lineIndex = lineNum - 1;
      if (lineIndex < 0 || lineIndex >= contentLines.length) {
        console.log(`  ⚠ Line ${lineNum} out of range, skipping`);
        continue;
      }

      const line = contentLines[lineIndex];
      let fixed = false;

      // Pattern 1: const tokens = this.tokenCounter.count(...)
      if (line.match(/=\s*this\.tokenCounter\.count\([^)]+\)\s*;?\s*$/)) {
        if (!line.includes('.tokens')) {
          contentLines[lineIndex] = line.replace(/count\(([^)]+)\)\s*;?\s*$/, 'count($1).tokens;');
          fileFixed++;
          fixed = true;
        }
      }
      // Pattern 2: const tokens = tokenCounter.count(...)
      else if (line.match(/=\s*tokenCounter\.count\([^)]+\)\s*;?\s*$/)) {
        if (!line.includes('.tokens')) {
          contentLines[lineIndex] = line.replace(/count\(([^)]+)\)\s*;?\s*$/, 'count($1).tokens;');
          fileFixed++;
          fixed = true;
        }
      }
      // Pattern 3: const tokens = await countTokens(...)
      else if (line.match(/=\s*await\s+countTokens\([^)]+\)\s*;?\s*$/)) {
        if (!line.includes('.tokens')) {
          contentLines[lineIndex] = line.replace(/countTokens\(([^)]+)\)\s*;?\s*$/, '(await countTokens($1)).tokens;');
          fileFixed++;
          fixed = true;
        }
      }
      // Pattern 4: property: this.tokenCounter.count(...),
      else if (line.match(/:\s*this\.tokenCounter\.count\([^)]+\)\s*,?\s*$/)) {
        if (!line.includes('.tokens')) {
          contentLines[lineIndex] = line.replace(/count\(([^)]+)\)\s*,?\s*$/, 'count($1).tokens,');
          fileFixed++;
          fixed = true;
        }
      }
      // Pattern 5: return this.tokenCounter.count(...)
      else if (line.match(/return\s+this\.tokenCounter\.count\([^)]+\)\s*;?\s*$/)) {
        if (!line.includes('.tokens')) {
          contentLines[lineIndex] = line.replace(/count\(([^)]+)\)\s*;?\s*$/, 'count($1).tokens;');
          fileFixed++;
          fixed = true;
        }
      }

      if (!fixed) {
        console.log(`  ⚠ Line ${lineNum} doesn't match known patterns, may need manual fix:`);
        console.log(`    ${line.trim()}`);
      }
    }

    if (fileFixed > 0) {
      content = contentLines.join('\n');
      fs.writeFileSync(fullPath, content, 'utf-8');
      console.log(`  ✓ Fixed ${fileFixed} lines`);
      filesModified++;
      totalFixed += fileFixed;
    } else {
      console.log(`  - No automatic fixes applied (may need manual review)`);
    }
  }

  console.log(`\n✓ Total: Fixed ${totalFixed} TokenCountResult assignments in ${filesModified} files`);
  console.log('\nNext: Run npm run build to verify error count decreased');
}

fixTokenCountErrors().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
