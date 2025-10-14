#!/usr/bin/env node
/**
 * Fix TokenCountResult variable definitions
 * Add .tokens where variables like resultTokens, tokensSaved, tokensUsed are defined
 * from tokenCounter.count() calls
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

async function fixVariableDefinitions() {
  console.log('Finding TokenCountResult type errors...\n');

  let buildOutput;
  try {
    buildOutput = execSync('npm run build 2>&1', {
      encoding: 'utf-8',
      cwd: process.cwd(),
      maxBuffer: 10 * 1024 * 1024
    });
  } catch (error) {
    buildOutput = error.stdout || error.stderr || '';
  }

  // Parse for TS2322 errors
  const lines = buildOutput.split('\n');
  const tokenCountErrors = [];

  for (const line of lines) {
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
    console.log('No errors found. Exiting.');
    return;
  }

  // Group by file
  const fileMap = {};
  for (const error of tokenCountErrors) {
    if (!fileMap[error.file]) {
      fileMap[error.file] = new Set();
    }
    fileMap[error.file].add(error.line);
  }

  let totalFixed = 0;
  let filesModified = 0;

  for (const [file, errorLinesSet] of Object.entries(fileMap)) {
    const fullPath = path.join(process.cwd(), file);

    if (!fs.existsSync(fullPath)) {
      console.log(`⚠ Skipping ${file}: File not found`);
      continue;
    }

    let content = fs.readFileSync(fullPath, 'utf-8');
    const contentLines = content.split('\n');

    console.log(`\nProcessing: ${file}`);
    console.log(`  Error lines: ${Array.from(errorLinesSet).sort((a, b) => a - b).join(', ')}`);

    let fileFixed = 0;

    // For each error line, find the variable definition that feeds into it
    const errorLines = Array.from(errorLinesSet).sort((a, b) => a - b);

    // Scan backwards from error lines to find variable definitions
    const variablesToFix = new Set();

    for (const errorLine of errorLines) {
      const errorLineIndex = errorLine - 1;
      const line = contentLines[errorLineIndex];

      // Extract variable names from the error line
      // Pattern: tokenCount: resultTokens,
      // Pattern: tokensSaved,
      // Pattern: tokensUsed: tokenCount,
      const varMatches = line.match(/\b(resultTokens|tokensSaved|tokensUsed|originalTokens|graphTokens|diffTokens|finalTokens|compactTokens|summaryLength|digestLength|comparisonLength|insightsLength|highlightsLength|categoriesLength|tokenCount)\b/g);

      if (varMatches) {
        for (const varName of varMatches) {
          variablesToFix.add(varName);
        }
      }
    }

    console.log(`  Variables to fix: ${Array.from(variablesToFix).join(', ')}`);

    // Now find where these variables are defined and add .tokens
    for (let i = 0; i < contentLines.length; i++) {
      const line = contentLines[i];

      for (const varName of variablesToFix) {
        // Pattern 1: const resultTokens = this.tokenCounter.count(...)
        // Should be: const resultTokens = this.tokenCounter.count(...).tokens
        const pattern1 = new RegExp(`const\\s+${varName}\\s*=\\s*this\\.tokenCounter\\.count\\(([^;]+)\\);?\\s*$`);
        const pattern2 = new RegExp(`const\\s+${varName}\\s*=\\s*tokenCounter\\.count\\(([^;]+)\\);?\\s*$`);
        const pattern3 = new RegExp(`${varName}\\s*=\\s*this\\.tokenCounter\\.count\\(([^;]+)\\);?\\s*$`);
        const pattern4 = new RegExp(`${varName}\\s*=\\s*tokenCounter\\.count\\(([^;]+)\\);?\\s*$`);

        if ((pattern1.test(line) || pattern2.test(line) || pattern3.test(line) || pattern4.test(line)) &&
            !line.includes('.tokens')) {
          // Add .tokens before the semicolon
          contentLines[i] = line.replace(/count\(([^)]+)\)\s*;?\s*$/, 'count($1).tokens;');
          fileFixed++;
          console.log(`  ✓ Line ${i + 1}: Added .tokens to ${varName}`);
          break;
        }
      }
    }

    if (fileFixed > 0) {
      content = contentLines.join('\n');
      fs.writeFileSync(fullPath, content, 'utf-8');
      console.log(`  ✓ Fixed ${fileFixed} variable definitions`);
      filesModified++;
      totalFixed += fileFixed;
    }
  }

  console.log(`\n✓ Total: Fixed ${totalFixed} variable definitions in ${filesModified} files`);
  console.log('\nNext: Run npm run build to verify');
}

fixVariableDefinitions().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
