import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

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
// (src/hooks-core/policy.mjs). CLAUDE_PLUGIN_ROOT is set by Claude Code's plugin
// runtime and by nothing else, and a plugin install always ships the hooks;
// each stdio server process serves one client, so the choice is made once.
//
// SHORTER, 2026-11-07. Measured in the SWE-bench pilot: this text plus the
// SessionStart policy were part of ~1,400 tokens of fixed plugin context that
// made the plugin arm 1.23x control on short tasks. Same three instructions,
// half the words; the code-mode catalog advice below never applied to Claude
// Code, so a plugin install no longer carries it.
export const PLUGIN_INSTRUCTIONS =
  "Built-in Read, Grep and Bash output is already compacted by this install's " +
  'hooks; use those for ordinary reads and searches. Load one of these tools ' +
  'with ToolSearch only for what they cannot do -- smart_edit for a large ' +
  'multi-site edit, optimize_session when context is tight, wiki_write for a ' +
  'durable non-obvious finding -- or when a hook names one; each load re-writes ' +
  'the prompt cache. Never call an unlisted schema.';

/** Code-mode hosts list every server's catalog through one tool. */
const CODE_MODE_DISCOVERY =
  ' Discover only the schema for the tool you need. In code-mode hosts with ' +
  'ALL_TOOLS, filter by the exact tool-name suffix (for example __smart_read) ' +
  'and print that entry only. To discover names, list names without descriptions ' +
  'first. Broad catalog dumps can exhaust the context budget.';

/**
 * THE SHORT TEXT IS FOR ANY CLAUDE CODE SESSION OUR HOOKS RUN IN, not only a
 * plugin install. CLAUDE_PLUGIN_ROOT alone missed the script install
 * (install-cli -> wire-hooks), which wires the same hooks into settings.json
 * and registers the server by hand: those sessions got the long text, told the
 * model smart_* routing was mandatory, and paid for the ToolSearch loads it
 * asked for. Measured on THOL #565, whose arm is that install: 0.64
 * ToolSearch turns a run, ~$0.009 a run (3.9% of the arm's spend; 11% on
 * log-needle-zh), plus 748 more characters of fixed context than the plugin.
 *
 * Claude Code marks the servers it launches with CLAUDECODE=1 (measured on
 * 2.1.325, along with CLAUDE_PROJECT_DIR). Other clients never set it, so a
 * machine with Claude Code hooks installed still gives Cursor or Codex the
 * long text -- the short one claims hooks those clients do not run.
 */
export function instructionsFor(
  env: NodeJS.ProcessEnv = process.env,
  claudeCodeHooksWired = false
): string {
  const plugin = String(env.CLAUDE_PLUGIN_ROOT ?? '').trim() !== '';
  const hookedClaudeCode = env.CLAUDECODE === '1' && claudeCodeHooksWired;
  return plugin || hookedClaudeCode
    ? PLUGIN_INSTRUCTIONS
    : SERVER_INSTRUCTIONS + CODE_MODE_DISCOVERY;
}

/**
 * Whether a settings file this Claude Code session loads wires our hooks: the
 * user file ($CLAUDE_CONFIG_DIR or ~/.claude), and the project's shared and
 * local files under CLAUDE_PROJECT_DIR. PreToolUse is required because the
 * short text promises built-in Read and Grep are compacted, and PreToolUse is
 * the hook that does it. Unreadable or malformed files count as not wired:
 * the long text is the safe default, since it is correct without hooks.
 */
export async function claudeCodeHooksWired(
  env: NodeJS.ProcessEnv = process.env
): Promise<boolean> {
  if (env.CLAUDECODE !== '1') return false;
  const userDir = env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  const files = [path.join(userDir, 'settings.json')];
  if (env.CLAUDE_PROJECT_DIR) {
    for (const name of ['settings.json', 'settings.local.json'])
      files.push(path.join(env.CLAUDE_PROJECT_DIR, '.claude', name));
  }
  let wiredEntries: (settings: unknown) => { event: string }[];
  try {
    ({ wiredEntries } = await import(
      pathToFileURL(
        path.join(
          path.dirname(fileURLToPath(import.meta.url)),
          '..',
          '..',
          'src',
          'hooks-core',
          'wire.mjs'
        )
      ).href
    ));
  } catch {
    return false;
  }
  // `disableAllHooks: true` switches the hooks off without removing their
  // entries, so a wired entry alone does not mean they run. The files are read
  // in Claude Code's precedence order (user, project, local), so the last file
  // that sets the flag decides it.
  let wired = false;
  let disabled = false;
  for (const file of files) {
    let settings: unknown;
    try {
      settings = JSON.parse(await fs.promises.readFile(file, 'utf8'));
    } catch {
      continue;
    }
    const flag = (settings as { disableAllHooks?: unknown } | null)
      ?.disableAllHooks;
    if (typeof flag === 'boolean') disabled = flag;
    if (wiredEntries(settings).some((entry) => entry.event === 'PreToolUse'))
      wired = true;
  }
  return wired && !disabled;
}

/**
 * THE SAME CHOICE FOR EVERY HOOKED CLIENT, not only Claude Code. The long text
 * tells the model smart_* routing is mandatory; with this install's hooks
 * running, built-in reads, searches and shell commands are already bounded,
 * outlined or redirected, so that advice buys loads and turns for nothing.
 *
 * Accurate for every client whose hooks can act before a call runs: each of
 * them denies an expensive call and names its replacement (canDeny), Codex and
 * Qwen also rewrite it (inputRewrite), and only Claude Code compacts output
 * (src/hooks-core/capabilities.mjs). So it promises no compaction, and it does
 * not mention ToolSearch: only Claude Code defers MCP schemas. Code-mode hosts
 * keep the catalog advice.
 */
export const HOOKED_INSTRUCTIONS =
  "This install's hooks watch built-in file reads, searches and shell commands, " +
  'and bound, outline or redirect the expensive ones; use the built-ins for ' +
  'ordinary work. Use these tools only for what the built-ins cannot do -- ' +
  'smart_edit for a large multi-site edit, optimize_session when context is ' +
  'tight, wiki_write for a durable non-obvious finding -- or when a hook names ' +
  'one. Never call an unlisted schema.' +
  CODE_MODE_DISCOVERY;

/** The clients whose hooks this package ships, by the registry's own names. */
export type HookedClient =
  | 'claude-code'
  | 'codex'
  | 'copilot'
  | 'cursor'
  | 'windsurf'
  | 'opencode'
  | 'kilo'
  | 'cline'
  | 'gemini'
  | 'qwen';

/**
 * Which hooked client this server is talking to, from the name it gave in the
 * MCP handshake (`clientInfo.name`). Matched on a fragment because clients
 * spell themselves differently across versions (`codex-mcp-client`,
 * `gemini-cli-mcp-client`, `cursor-vscode`). Claude Code's own CLAUDECODE=1
 * outranks the name. Anything unrecognised is null and keeps the long text.
 */
export function hookedClientFor(
  clientName: string | undefined,
  env: NodeJS.ProcessEnv = process.env
): HookedClient | null {
  if (env.CLAUDECODE === '1') return 'claude-code';
  const name = String(clientName ?? '').toLowerCase();
  if (!name) return null;
  if (name === 'claude-code') return 'claude-code';
  const patterns: [RegExp, HookedClient][] = [
    [/codex/, 'codex'],
    [/qwen/, 'qwen'],
    [/gemini/, 'gemini'],
    [/copilot/, 'copilot'],
    [/cursor/, 'cursor'],
    [/windsurf|codeium|cascade/, 'windsurf'],
    [/opencode/, 'opencode'],
    [/kilo/, 'kilo'],
    // Not Roo: a Cline fork, but one this package ships no hooks for.
    [/^(?!.*roo).*cline/, 'cline'],
  ];
  for (const [pattern, client] of patterns)
    if (pattern.test(name)) return client;
  return null;
}

/** Whether `file` mentions `needle`, with Windows separators read as `/`. */
async function fileHas(file: string, needle: string): Promise<boolean> {
  try {
    return (await fs.promises.readFile(file, 'utf8'))
      .replace(/\\+/g, '/')
      .includes(needle);
  } catch {
    return false;
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.promises.access(file);
    return true;
  } catch {
    return false;
  }
}

async function subdirectories(dir: string): Promise<string[]> {
  try {
    return (await fs.promises.readdir(dir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(dir, entry.name));
  } catch {
    return [];
  }
}

/**
 * Gemini CLI's effective `hooksConfig.enabled`, from its settings files in
 * precedence order (user, then workspace): the last file that sets it decides.
 * Unset means enabled, Gemini's default. Qwen Code is a Gemini CLI fork that
 * reads the same settings layout; where it ignores the key, nobody sets it,
 * so reading it costs nothing.
 *
 * An absent file sets nothing. A file that exists but cannot be read or parsed
 * might be the one switching hooks off, so it counts as off: the long
 * instructions are the safe answer when we cannot tell (#594 review). That
 * includes a file our plain JSON.parse rejects, such as one with comments.
 */
async function geminiHooksEnabled(files: string[]): Promise<boolean> {
  let enabled = true;
  for (const file of files) {
    let settings: unknown;
    try {
      settings = JSON.parse(await fs.promises.readFile(file, 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      return false;
    }
    const flag = (settings as { hooksConfig?: { enabled?: unknown } } | null)
      ?.hooksConfig?.enabled;
    if (typeof flag === 'boolean') enabled = flag;
  }
  return enabled;
}

async function anyOf(checks: Promise<boolean>[]): Promise<boolean> {
  return (await Promise.all(checks)).some(Boolean);
}

/**
 * Whether `client`'s own configuration runs this package's PreToolUse hook:
 * the file that client reads, naming the entry our installer composes
 * (install-client-hooks.mjs, CLIENT_HOOK_INSTALLS). Hook files on disk that no
 * config names are installed and unused, so they do not count. Unreadable
 * files count as not wired: the long text is correct without hooks.
 *
 * `project` is the directory the client launched the server in, which is the
 * workspace for every client here.
 */
export async function hooksWiredFor(
  client: HookedClient | null,
  {
    env = process.env,
    home = os.homedir(),
    project = env.CLAUDE_PROJECT_DIR || process.cwd(),
  }: { env?: NodeJS.ProcessEnv; home?: string; project?: string } = {}
): Promise<boolean> {
  switch (client) {
    case 'claude-code':
      return claudeCodeHooksWired({ ...env, CLAUDECODE: '1' });
    case 'codex': {
      const codexHome = env.CODEX_HOME || path.join(home, '.codex');
      // The plugin carries its own hooks, which Codex runs from its plugin
      // cache; the script install merges hooks.json into the Codex home.
      for (const marketplace of await subdirectories(
        path.join(codexHome, 'plugins', 'cache')
      )) {
        if (
          (await subdirectories(path.join(marketplace, 'token-optimizer')))
            .length
        )
          return true;
      }
      return fileHas(
        path.join(codexHome, 'hooks.json'),
        '.codex/hooks/pre-tool.mjs'
      );
    }
    case 'copilot': {
      const dir = path.join(project, '.github', 'hooks');
      let names: string[];
      try {
        names = (await fs.promises.readdir(dir)).filter((n) =>
          n.endsWith('.json')
        );
      } catch {
        return false;
      }
      return anyOf(
        names.map((n) =>
          fileHas(path.join(dir, n), '.github/hooks/pre-tool.mjs')
        )
      );
    }
    case 'cursor':
      return anyOf(
        [path.join(project, '.cursor'), path.join(home, '.cursor')].map((d) =>
          fileHas(path.join(d, 'hooks.json'), 'token-optimizer/pre-tool.mjs')
        )
      );
    case 'windsurf':
      return anyOf(
        [
          path.join(project, '.windsurf'),
          path.join(home, '.codeium', 'windsurf'),
        ].map((d) =>
          fileHas(path.join(d, 'hooks.json'), 'token-optimizer/pre-tool.mjs')
        )
      );
    case 'cline':
      return anyOf(
        ['PreToolUse', 'PreToolUse.ps1'].map((n) =>
          fileHas(
            path.join(project, '.clinerules', 'hooks', n),
            'token-optimizer/pre-tool.mjs'
          )
        )
      );
    // OpenCode and Kilo load every plugin file in these directories, so the
    // file being there is the wiring.
    case 'opencode':
      return anyOf(
        [
          path.join(project, '.opencode', 'plugins'),
          path.join(home, '.config', 'opencode', 'plugins'),
        ].map((d) => exists(path.join(d, 'token-optimizer.js')))
      );
    case 'kilo':
      return anyOf(
        [
          path.join(project, '.kilo', 'plugin'),
          path.join(home, '.config', 'kilo', 'plugin'),
        ].map((d) => exists(path.join(d, 'token-optimizer.js')))
      );
    // An installed extension's hooks/hooks.json is enabled with it, unless the
    // effective settings switch hooks off (`hooksConfig.enabled: false`), which
    // leaves the extension installed and runs no hook.
    case 'gemini':
    case 'qwen': {
      const dot = client === 'gemini' ? '.gemini' : '.qwen';
      const installed = await exists(
        path.join(
          home,
          dot,
          'extensions',
          'token-optimizer',
          'hooks',
          'hooks.json'
        )
      );
      return (
        installed &&
        geminiHooksEnabled([
          path.join(home, dot, 'settings.json'),
          path.join(project, dot, 'settings.json'),
        ])
      );
    }
    default:
      return false;
  }
}

/**
 * The instructions for the client that just completed the MCP handshake.
 * Claude Code keeps its own short text, since it compacts output and defers
 * schemas; every other client with our hooks wired gets HOOKED_INSTRUCTIONS;
 * the rest get the long text.
 */
export async function instructionsForClient(
  clientName: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  where: { home?: string; project?: string } = {}
): Promise<string> {
  if (String(env.CLAUDE_PLUGIN_ROOT ?? '').trim() !== '')
    return PLUGIN_INSTRUCTIONS;
  const client = hookedClientFor(clientName, env);
  if (!client || !(await hooksWiredFor(client, { env, ...where })))
    return SERVER_INSTRUCTIONS + CODE_MODE_DISCOVERY;
  return client === 'claude-code' ? PLUGIN_INSTRUCTIONS : HOOKED_INSTRUCTIONS;
}
