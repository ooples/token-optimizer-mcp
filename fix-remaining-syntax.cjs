#!/usr/bin/env node
/**
 * Fix remaining syntax errors from corrupted previous fixes
 */

const fs = require('fs');
const path = require('path');

function fixFile(filePath) {
  const fullPath = path.join(process.cwd(), filePath);
  let content = fs.readFileSync(fullPath, 'utf-8');
  const original = content;

  console.log(`\nProcessing: ${filePath}`);

  // Fix 1: Corrupted globalMetricsCollector.record() calls
  // Pattern: operation: 'smart-env' /* compressedSize */);
  content = content.replace(
    /(globalMetricsCollector\.record\(\{[^}]*operation:\s*'[^']+'\s*)\/\*\s*compressedSize\s*\*\/\);/g,
    (match, prefix) => {
      console.log(`  Fixed globalMetricsCollector.record() call`);
      return `${prefix},
      duration: Date.now() - startTime,
      success: true,
      cacheHit: false,
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      savedTokens: 0,
      metadata: {}
    });`;
    }
  );

  // Fix 2: Corrupted this.persistAlerts() calls
  // Pattern: this.persistAlerts( /* originalSize */, options.cacheTTL || 21600 /* compressedSize */);
  content = content.replace(
    /this\.persistAlerts\(\s*\/\*\s*originalSize\s*\*\/\s*,\s*([^\/]+)\/\*\s*compressedSize\s*\*\/\);/g,
    (match, param) => {
      console.log(`  Fixed this.persistAlerts() call`);
      return `this.persistAlerts(${param.trim()});`;
    }
  );

  // Fix 3: Corrupted crypto.createHash with Date.now().digest()
  // Pattern: crypto.createHash("md5").update('report-list', `${Date.now().digest("hex")}`}`)
  // Should be: crypto.createHash("md5").update(`report-list-${Date.now()}`).digest("hex")
  content = content.replace(
    /crypto\.createHash\("md5"\)\.update\('([^']+)',\s*`\$\{Date\.now\(\)\.digest\("hex"\)`\}`\)/g,
    (match, prefix) => {
      console.log(`  Fixed crypto.createHash with Date.now()`);
      return `crypto.createHash("md5").update(\`${prefix}-\${Date.now()}\`).digest("hex")`;
    }
  );

  // Only write if changes were made
  if (content !== original) {
    fs.writeFileSync(fullPath, content, 'utf-8');
    console.log(`  ✓ Fixed and saved`);
    return true;
  } else {
    console.log(`  - No changes needed`);
    return false;
  }
}

// Process files with known errors
const files = [
  'src/tools/configuration/smart-env.ts',
  'src/tools/dashboard-monitoring/alert-manager.ts',
  'src/tools/dashboard-monitoring/report-generator.ts'
];

let fixedCount = 0;
for (const file of files) {
  try {
    if (fixFile(file)) {
      fixedCount++;
    }
  } catch (error) {
    console.error(`  ✗ Error: ${error.message}`);
  }
}

console.log(`\n✓ Fixed ${fixedCount} out of ${files.length} files`);
console.log(`\nNext: Run 'npm run build' to verify all errors resolved`);
