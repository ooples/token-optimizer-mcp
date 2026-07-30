#!/usr/bin/env node
/**
 * Claude Code SessionStart adapter -- states the optimization policy up front.
 *
 * WHY A HOOK AND NOT THE SKILL: skills are model-invoked. The token-optimization
 * skill only enters context once the model has already decided the topic is
 * relevant, which on a normal coding session is never -- the model is thinking
 * about the user's bug, not about its own token consumption. So the skill,
 * however well written, could not establish a default.
 *
 * A SessionStart hook is unconditional. Its additionalContext is present before
 * the first tool call of every session, so preferring optimized tooling is the
 * model's starting assumption rather than a correction issued after the
 * expensive call was already attempted.
 *
 * This pairs with the PreToolUse router: the router is the enforcement, this is
 * the notice. Without the notice the model learns the policy only by being
 * refused, which wastes a turn per tool family.
 */

import { mode, MODE_OFF, MODE_ADVISE, largeFileBytes } from './lib/policy.mjs';

const current = mode();
if (current === MODE_OFF) process.exit(0);

const kb = Math.round(largeFileBytes() / 1024);

const enforcement = current === MODE_ADVISE
  ? 'These are recommendations; the built-in tools remain available.'
  : `Built-in calls matching these cases are DENIED and must be reissued ` +
    `against the tool named in the refusal. A second attempt at the same ` +
    `target is always allowed, so you can never be stuck.`;

const policy = `# Token optimization is active

The token-optimizer MCP server is connected. Prefer its tools over the
built-ins in these cases -- they cut context usage 60-90% by caching, diffing
and bounding output:

- Reading a file larger than ~${kb} KB, or ANY file already read this session
  -> smart_read (returns only what changed since the last read)
- Searching file contents -> smart_grep ; finding files -> smart_glob
- Editing a file larger than ~${kb} KB -> smart_edit (returns a diff, not the file)
- Printing a large file via cat/head/tail/type/Get-Content -> smart_read
- Recursive shell searches (grep -r, rg) -> smart_grep

${enforcement}

When the context window gets tight, call optimize_session. To report savings,
call get_optimization_report. Small one-off reads are fine with the built-ins.`;

process.stdout.write(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'SessionStart',
    additionalContext: policy,
  },
}));
