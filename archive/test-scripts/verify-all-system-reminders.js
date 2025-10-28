// Verify ALL system reminder tokens (CLAUDE.md + hooks)
import { encoding_for_model } from 'tiktoken';
import fs from 'fs';
import path from 'path';

async function verifyAllSystemReminders() {
  const encoder = encoding_for_model('gpt-4');

  // From wrapper report - hook .ps1 files with estimated counts
  const hookFiles = [
    { name: 'dispatcher.ps1', estimated: 852 },
    { name: 'session-token-tracker.ps1', estimated: 1380 },
    { name: 'daily-summary-generator.ps1', estimated: 676 },
    { name: 'token-optimizer-enforcer.ps1', estimated: 732 },
    { name: 'sequential-thinking-detector.ps1', estimated: 712 },
    { name: 'gemini-advisor.ps1', estimated: 644 },
    { name: 'install-production-hooks.ps1', estimated: 652 },
    { name: 'pr-validation.ps1', estimated: 636 },
    { name: 'gemini-router.ps1', estimated: 600 },
    { name: 'env-validator.ps1', estimated: 572 },
    { name: 'mcp-analytics-logger.ps1', estimated: 544 },
    { name: 'Start-TrackedSession.ps1', estimated: 496 },
    { name: 'memory-solution-detector.ps1', estimated: 496 },
    { name: 'prevent-secret-commits.ps1', estimated: 496 },
    { name: 'ssh-blocker.ps1', estimated: 296 },
    { name: 'ambiance-enforcer.ps1', estimated: 476 },
    { name: 'gemini-query-detector.ps1', estimated: 472 },
    { name: 'install-simple.ps1', estimated: 460 },
    { name: 'unified-logger.ps1', estimated: 400 },
    { name: 'git-mcp-enforcer.ps1', estimated: 380 },
    { name: 'cleanup-old-files.ps1', estimated: 352 },
    { name: 'file-validator.ps1', estimated: 324 },
    { name: 'github-mcp-enforcer.ps1', estimated: 304 },
    { name: 'commit-enhancer.ps1', estimated: 288 },
    { name: 'pre-compact-memory.ps1', estimated: 272 },
    { name: 'session-start-restore.ps1', estimated: 244 },
    { name: 'memory-manager.ps1', estimated: 204 },
    { name: 'json-parser.ps1', estimated: 168 },
    { name: 'log-hook-input.ps1', estimated: 140 },
    { name: 'logger.ps1', estimated: 108 },
    { name: 'test-hooks.ps1', estimated: 1036 },
    { name: 'verify-gemini-integration.ps1', estimated: 616 },
    { name: 'test-write-hook.ps1', estimated: 64 },
    { name: 'log-bash-command.ps1', estimated: 56 },
    { name: 'log-tool-name.ps1', estimated: 56 },
    { name: 'test-format4-powershell.ps1', estimated: 12 }
  ];

  const hookDir = 'C:\\Users\\yolan\\.claude-global\\hooks';

  console.log('System Reminder Token Verification');
  console.log('===================================\n');

  let totalEstimated = 5476; // CLAUDE.md files
  let totalActual = 11784; // CLAUDE.md files (from previous verification)

  console.log('CLAUDE.md Files (3 files):');
  console.log('  Estimated: 5,476 tokens');
  console.log('  Actual: 11,784 tokens');
  console.log('  Error: 53.5% UNDERestimated\n');

  console.log('Hook .ps1 Files (36 files):');

  let hookEstimated = 0;
  let hookActual = 0;
  let filesProcessed = 0;

  for (const hook of hookFiles) {
    const filePath = path.join(hookDir, hook.name);

    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, 'utf-8');
      const tokens = encoder.encode(content);
      const actualCount = tokens.length;

      hookEstimated += hook.estimated;
      hookActual += actualCount;
      filesProcessed++;

      const error = ((actualCount - hook.estimated) / actualCount * 100).toFixed(1);
      console.log(`  ${hook.name}: ${hook.estimated} est → ${actualCount} actual (${error}% error)`);
    }
  }

  console.log(`\n  Total Hook Estimated: ${hookEstimated.toLocaleString()} tokens`);
  console.log(`  Total Hook Actual: ${hookActual.toLocaleString()} tokens`);
  console.log(`  Hook Files Processed: ${filesProcessed}/36\n`);

  totalEstimated += hookEstimated;
  totalActual += hookActual;

  const totalError = ((totalActual - totalEstimated) / totalActual * 100).toFixed(1);
  const missingTokens = totalActual - totalEstimated;

  console.log('TOTAL SYSTEM REMINDERS:');
  console.log('=======================');
  console.log(`Wrapper Estimated: ${totalEstimated.toLocaleString()} tokens`);
  console.log(`Actual (tiktoken): ${totalActual.toLocaleString()} tokens`);
  console.log(`Missing Tokens: ${missingTokens.toLocaleString()} (${totalError}% underestimated)`);
  console.log(`\nCritical Impact: Every new session starts with ${missingTokens.toLocaleString()} more tokens than tracked!`);

  encoder.free();
}

verifyAllSystemReminders().catch(console.error);
