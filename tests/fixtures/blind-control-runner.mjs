/**
 * Blind-control runner, second attempt. The first was invalid twice over and
 * both faults are worth naming, because either alone produces confident numbers
 * from nothing.
 *
 * 1. THE PROMPT NEVER ARRIVED. spawnSync with shell:true re-parsed the
 *    multi-line prompt, and the model received the single word "Answer". Both
 *    arms then failed to mention the avoid-keywords, so the scorer read 4 of 6
 *    as "control walked into the trap" and 0 of 4 as "treated avoided it" -- a
 *    complete, plausible, entirely fictional result. Now passed as one argv
 *    element with shell:false.
 *
 * 2. THE BLIND DIRECTORY WAS NOT BLIND. Global UserPromptSubmit hooks fired
 *    there and injected unrelated project context; the model said so in its
 *    reply. Now run with --settings pointing at a hooks-free settings file.
 *
 * Both fixes are verified before the run, not assumed: a probe asserts the model
 * echoes a token that only exists in the prompt, and that its answer contains no
 * trace of the injected project context.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const ARMS = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const OUT = process.argv[3];
const SETTINGS = process.argv[4];
const CWD = 'C:/Temp/blindtrial';

function ask(prompt) {
  const r = spawnSync(
    'claude',
    ['-p', prompt, '--max-turns', '1', '--settings', SETTINGS],
    {
      cwd: CWD,
      encoding: 'utf8',
      env: { ...process.env, TOKEN_OPTIMIZER_MODE: 'off' },
      timeout: 300_000,
      shell: false,
      windowsHide: true,
    }
  );
  if (r.error) throw r.error;
  return (r.stdout || '').replace(/Shell cwd was reset.*$/gm, '').trim();
}

// ---- PRE-FLIGHT. A run that cannot deliver its own prompt must not produce
// numbers, so this fails loudly instead. ----
const canary = ask(
  'Reply with exactly the word PROMPT-ARRIVED-7Q4 and nothing else.'
);
if (!/PROMPT-ARRIVED-7Q4/.test(canary)) {
  console.error('PRE-FLIGHT FAILED: prompt did not reach the model.');
  console.error(JSON.stringify(canary).slice(0, 400));
  process.exit(1);
}
if (/HRE|patent|PIPELINE CHECK|token-optimizer/i.test(canary)) {
  console.error('PRE-FLIGHT FAILED: hook-injected context is still present.');
  console.error(JSON.stringify(canary).slice(0, 400));
  process.exit(1);
}
console.error('pre-flight OK: prompt arrives, no injected project context');

const results = [];
for (const arm of ARMS) {
  const guard =
    'Answer from your own knowledge in under 100 words. Do not use any tools. Do not read any files.\n\n';
  const injected = arm.injected.replace(/\s*\(Not what you wanted.*$/s, '').trim();

  process.stderr.write(`  ${arm.id} control...`);
  const control = ask(guard + arm.task);
  process.stderr.write(' treated...');
  const treated = ask(guard + injected + '\n\n' + arm.task);
  process.stderr.write(' done\n');

  results.push({ id: arm.id, origin: arm.origin, control, treated });
}

writeFileSync(OUT, JSON.stringify(results, null, 2));
console.log(`wrote ${results.length} trial pairs`);
