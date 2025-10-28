#!/usr/bin/env node
/**
 * Fix corrupted crypto.createHash() syntax from previous script
 */

const fs = require('fs');
const path = require('path');

const files = {
  'src/tools/advanced-caching/cache-replication.ts': [
    {
      line: 1002,
      find: /return `cache-\$\{crypto\.createHash\("md5"\)\.update\('replication', JSON\.stringify\(key\)\.digest\("hex"\)\}`\);/,
      replace: `return \`cache-\${crypto.createHash("md5").update(JSON.stringify(key)).digest("hex")}\`;`
    }
  ],
  'src/tools/api-database/smart-cache-api.ts': [
    {
      line: 641,
      pattern: 'createHash' // Will search for similar patterns
    }
  ],
  'src/tools/api-database/smart-orm.ts': [
    {
      line: 703,
      pattern: 'createHash'
    }
  ],
  'src/tools/api-database/smart-websocket.ts': [
    {
      line: 577,
      pattern: 'createHash'
    }
  ],
  'src/tools/dashboard-monitoring/custom-widget.ts': [
    {
      line: 971,
      pattern: 'createHash'
    }
  ],
  'src/tools/dashboard-monitoring/report-generator.ts': [
    {
      line: 585,
      pattern: 'createHash'
    }
  ]
};

function fixFileByPattern(filePath) {
  const fullPath = path.join(process.cwd(), filePath);
  let content = fs.readFileSync(fullPath, 'utf-8');
  const original = content;

  console.log(`\nProcessing: ${filePath}`);

  // Pattern 1: Fix crypto.createHash().update(..., ...).digest() with wrong syntax
  //   Wrong: .update('string', JSON.stringify(key).digest("hex")
  //   Right: .update(JSON.stringify(key)).digest("hex")
  content = content.replace(
    /(crypto\.createHash\([^)]+\)\.update)\('([^']+)',\s*(JSON\.stringify\([^)]+\))\.digest\(([^)]+)\)/g,
    (match, prefix, string1, jsonPart, digestPart) => {
      console.log(`  Fixed crypto.createHash().update() chain`);
      return `${prefix}(${jsonPart}).digest(${digestPart})`;
    }
  );

  // Pattern 2: Fix broken return statements with createHash
  //   Wrong: return `..${crypto.createHash...digest("hex")}`)  <-- extra paren and backtick
  //   Right: return `..${crypto.createHash...digest("hex")}`
  content = content.replace(
    /(return\s+`[^`]*\$\{crypto\.createHash[^}]+\})`\);/g,
    (match, returnPart) => {
      console.log(`  Fixed return statement with extra characters`);
      return `${returnPart}\`;`;
    }
  );

  // Only write if changes were made
  if (content !== original) {
    fs.writeFileSync(fullPath, content, 'utf-8');
    console.log(`  ✓ Fixed and saved`);
    return true;
  } else {
    console.log(`  - No changes needed (or pattern didn't match)`);
    return false;
  }
}

// Process all files
let fixedCount = 0;
for (const file of Object.keys(files)) {
  try {
    if (fixFileByPattern(file)) {
      fixedCount++;
    }
  } catch (error) {
    console.error(`  ✗ Error: ${error.message}`);
  }
}

console.log(`\n✓ Fixed ${fixedCount} out of ${Object.keys(files).length} files`);
console.log(`\nNext: Run 'npm run build' to verify`);
