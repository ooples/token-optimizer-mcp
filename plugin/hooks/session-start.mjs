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

import { mode, MODE_OFF } from './lib/policy.mjs';
import { policyText } from './lib/adapter.mjs';

if (mode() === MODE_OFF) process.exit(0);

// THE TEXT ITSELF LIVES IN THE SHARED CORE. It used to be duplicated here,
// which is exactly the drift the adapter was built to end: an addition to the
// shared policy -- the project briefing, for instance -- reached the other five
// clients and silently skipped Claude Code, the one client most users are on.
// Claude Code keeps its own entry point because its PreToolUse router does more
// than the shared one; the standing notice is not a place it needs to differ.
process.stdout.write(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'SessionStart',
    additionalContext: policyText(true),
  },
}));
