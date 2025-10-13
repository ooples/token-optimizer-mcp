// Quick script to verify actual token count vs PowerShell estimation
import { encoding_for_model } from 'tiktoken';
import fs from 'fs';
import path from 'path';

async function verifyTokenCounts() {
  const encoder = encoding_for_model('gpt-4');

  // Files to verify (from wrapper report)
  const files = [
    {
      path: 'C:\\Users\\yolan\\source\\repos\\ooples\\CrowdTrainer\\CLAUDE.md',
      estimated: 1812
    },
    {
      path: 'C:\\Users\\yolan\\source\\repos\\token-analysis-temp\\CLAUDE.md',
      estimated: 1444
    },
    {
      path: 'C:\\Users\\yolan\\CLAUDE.md',
      estimated: 2220
    }
  ];

  console.log('Token Count Verification Report');
  console.log('================================\n');

  let totalEstimated = 0;
  let totalActual = 0;

  for (const file of files) {
    if (fs.existsSync(file.path)) {
      const content = fs.readFileSync(file.path, 'utf-8');
      const tokens = encoder.encode(content);
      const actualCount = tokens.length;
      const lineCount = content.split('\n').length;
      const estimatedFromLines = lineCount * 4;
      const error = ((actualCount - file.estimated) / actualCount * 100).toFixed(1);

      console.log(`File: ${path.basename(file.path)}`);
      console.log(`  Lines: ${lineCount}`);
      console.log(`  Estimated (wrapper): ${file.estimated} tokens`);
      console.log(`  Estimated (lines×4): ${estimatedFromLines} tokens`);
      console.log(`  Actual (tiktoken): ${actualCount} tokens`);
      console.log(`  Error: ${error}% ${actualCount > file.estimated ? 'UNDER' : 'OVER'}estimated`);
      console.log('');

      totalEstimated += file.estimated;
      totalActual += actualCount;
    } else {
      console.log(`File: ${path.basename(file.path)}`);
      console.log(`  ERROR: File not found at ${file.path}\n`);
    }
  }

  const totalError = ((totalActual - totalEstimated) / totalActual * 100).toFixed(1);
  console.log('Summary:');
  console.log('========');
  console.log(`Total Estimated: ${totalEstimated} tokens`);
  console.log(`Total Actual: ${totalActual} tokens`);
  console.log(`Total Error: ${totalError}% ${totalActual > totalEstimated ? 'UNDER' : 'OVER'}estimated`);
  console.log(`Missing Tokens: ${totalActual - totalEstimated}`);

  encoder.free();
}

verifyTokenCounts().catch(console.error);
