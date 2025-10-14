const fs = require('fs');
const path = require('path');

// This script detects and fixes files where entire content is collapsed onto single lines
// particularly common in advanced-caching directory

const TOOLS_DIR = path.join(__dirname, 'src', 'tools');

let filesFixed = 0;
let filesChecked = 0;

function hasFormattingIssue(content) {
  const lines = content.split('\n');
  if (lines.length < 10) return false; // Too short to have formatting issues

  // Check if first few lines are abnormally long (>200 chars suggests collapsed format)
  const firstLines = lines.slice(0, 5);
  const longLines = firstLines.filter(line => line.length > 200);

  return longLines.length > 2; // If 3+ of first 5 lines are >200 chars, likely collapsed
}

function attemptReformat(content) {
  // This is a simple heuristic - won't be perfect but should help
  // Look for common patterns where line breaks were removed

  let formatted = content;

  // Add line breaks after semicolons (except in strings)
  // Add line breaks after closing braces
  // Add line breaks after opening braces

  // This is too risky - we should just flag the files for manual review
  // instead of attempting automatic reformatting

  return null; // Return null to indicate manual review needed
}

function processDir(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      processDir(fullPath);
    } else if (entry.name.endsWith('.ts')) {
      filesChecked++;
      const content = fs.readFileSync(fullPath, 'utf-8');

      if (hasFormattingIssue(content)) {
        console.log(`FORMATTING ISSUE: ${fullPath}`);
        const relativePath = path.relative(TOOLS_DIR, fullPath);
        console.log(`  Relative path: ${relativePath}`);
        console.log(`  First line length: ${content.split('\n')[0].length} chars`);
        filesFixed++;
      }
    }
  }
}

console.log('Checking for file formatting issues...\n');
processDir(TOOLS_DIR);
console.log(`\nChecked ${filesChecked} TypeScript files`);
console.log(`Found ${filesFixed} files with potential formatting issues`);

if (filesFixed > 0) {
  console.log('\n⚠️  WARNING: Files with formatting issues detected!');
  console.log('These files may have entire content collapsed onto single lines.');
  console.log('This makes editing difficult and may cause parser issues.');
  console.log('\nRecommended: Run Prettier to reformat these files before proceeding.');
}
