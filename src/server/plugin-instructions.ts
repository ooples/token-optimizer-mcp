// This reaches every conforming MCP client at initialization, including hosts
// that expose no native lifecycle hook. It is deliberately capability-aware:
// the model must route through optimizer schemas that tools/list actually
// exposes, while a reduced/failed profile keeps bounded native tools usable.
// DEFERRED IS NOT ABSENT. Claude Code defers MCP tools -- always for subagents,
// and for the main session when many tools are installed -- so their schemas are
// not in tools/list until loaded with ToolSearch. The previous wording made the
// tools conditional on "an exact optimizer schema is present in tools/list" and
// otherwise said to use native operations, so every subagent was told, by this
// server, to read files with cat and search them with grep. Measured across 42
// workflow subagents: 2,071 shell file reads, 9 Read calls, 0 smart_read calls.
//
// NOT UP FRONT, measured the other way on 2026-10-21. "Load them before your
// first file read" turned into a ToolSearch-only turn in nearly every worker,
// and each mid-session load changes what the client sends ahead of the
// conversation, so the call after it re-wrote the prompt cache: in a 10-worker
// run, 9 such turns and 137k cache-write tokens, for 1 smart_read and 3
// smart_grep calls. Claude Code's built-in Read, Grep and Bash output is now
// compacted by the hooks without any tool choice, so the load only pays when a
// large read or broad search is actually at hand -- and then once, for all of
// them together.
const SERVER_INSTRUCTIONS =
  'Token optimization is mandatory routing policy, not a preference: use ' +
  'smart_read for large or repeated files, smart_grep for content search, ' +
  'smart_glob for file discovery, smart_edit for large edits, optimize_session ' +
  'when context is tight, and wiki_write for durable non-obvious conclusions. ' +
  'If these tools are listed as deferred (their schemas not yet loaded, as in ' +
  'subagents), load them with ToolSearch -- one keyword search such as ' +
  'ToolSearch("smart_read smart_grep smart_glob") finds them whatever prefix ' +
  'this install gives them -- the first time a large read or a broad search ' +
  'comes up, not up front: every mid-session load re-writes the prompt cache, ' +
  'and a short task may never need one. Never call or redirect to an unlisted ' +
  'schema; use a bounded native operation (a line range, a count, a filtered ' +
  'search) only when the required optimizer tool is neither listed nor deferred.';

// A CLAUDE CODE PLUGIN INSTALL IS TOLD THE OPPOSITE ABOUT LOADING. There, this
// package's hooks already compact built-in Read, Grep and Bash output with no
// tool choice, so loading a deferred smart tool for an ordinary read or search
// buys nothing and still re-writes the prompt cache. Measured on the 2026-10-23
// multi-agent benchmarks: 0.25-0.6 ToolSearch loads per run under the wording
// above, each followed by a cache re-write. The subagent briefing says the same
// (hooks-core/policy.mjs). CLAUDE_PLUGIN_ROOT is set by Claude Code's plugin
// runtime and by nothing else, and a plugin install always ships the hooks;
// each stdio server process serves one client, so the choice is made once.
export const PLUGIN_INSTRUCTIONS =
  "This install's hooks already compact the output of the built-in Read, Grep " +
  'and Bash tools, so use the built-in tools for ordinary reads and searches. ' +
  'Do not load these tools with ToolSearch just to read or search: every ' +
  'mid-session load re-writes the prompt cache. Load one only for what the ' +
  'built-in tools cannot do -- smart_edit for a large multi-site edit, ' +
  'optimize_session when context is tight, wiki_write for a durable non-obvious ' +
  'conclusion -- or when a hook refuses a built-in call and names one of these ' +
  'tools instead (enforce mode does this for large reads); then load it and ' +
  'use it. Never call or redirect to an unlisted schema.';

export function instructionsFor(env: NodeJS.ProcessEnv = process.env): string {
  return String(env.CLAUDE_PLUGIN_ROOT ?? '').trim()
    ? PLUGIN_INSTRUCTIONS
    : SERVER_INSTRUCTIONS;
}
