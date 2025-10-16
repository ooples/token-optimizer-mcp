#!/usr/bin/env node

/**
 * Fix string→Record errors in generateCacheKey calls
 * Pattern: JSON.stringify({...}) → {...}
 */

const fs = require('fs');
const path = require('path');

// Files with string→Record errors
const files = [
  'src/tools/advanced-caching/cache-analytics.ts',
  'src/tools/advanced-caching/cache-compression.ts',
  'src/tools/advanced-caching/cache-optimizer.ts',
  'src/tools/advanced-caching/cache-partition.ts',
  'src/tools/api-database/smart-schema.ts',
  'src/tools/dashboard-monitoring/health-monitor.ts',
  'src/tools/dashboard-monitoring/monitoring-integration.ts',
  'src/tools/dashboard-monitoring/performance-tracker.ts',
  'src/tools/intelligence/auto-remediation.ts',
  'src/tools/intelligence/intelligent-assistant.ts',
  'src/tools/intelligence/natural-language-query.ts',
  'src/tools/intelligence/pattern-recognition.ts',
  'src/tools/intelligence/predictive-analytics.ts',
  'src/tools/intelligence/recommendation-engine.ts',
  'src/tools/intelligence/smart-summarization.ts',
  'src/tools/output-formatting/smart-diff.ts',
  'src/tools/output-formatting/smart-format.ts',
  'src/tools/output-formatting/smart-log.ts',
  'src/tools/output-formatting/smart-pretty.ts',
  'src/tools/output-formatting/smart-stream.ts',
  'src/tools/system-operations/smart-cleanup.ts',
  'src/tools/system-operations/smart-cron.ts'
];

let totalFixed = 0;

files.forEach(file => {
  const filePath = path.join(process.cwd(), file);

  if (!fs.existsSync(filePath)) {
    console.log(`⚠️  Skip: ${file} (not found)`);
    return;
  }

  let content = fs.readFileSync(filePath, 'utf8');
  const originalContent = content;

  // Fix pattern: generateCacheKey('namespace', JSON.stringify({...}))
  // Replace with: generateCacheKey('namespace', {...})

  // Match: JSON.stringify(\n      {\n        ...\n      }\n    )
  // Or: JSON.stringify({ ... })
  const regex = /generateCacheKey\(\s*(['"][^'"]+['"])\s*,\s*JSON\.stringify\((\{[\s\S]*?\})\)\s*\)/g;

  let matches = 0;
  content = content.replace(regex, (match, namespace, object) => {
    matches++;
    return `generateCacheKey(${namespace}, ${object})`;
  });

  if (matches > 0) {
    fs.writeFileSync(filePath, content, 'utf8');
    console.log(`✓ Fixed ${matches} occurrences in ${file}`);
    totalFixed += matches;
  } else {
    console.log(`• No changes in ${file}`);
  }
});

console.log(`\n✨ Total fixed: ${totalFixed} occurrences across ${files.length} files`);
