/**
 * The routing decision, as a pure function.
 *
 * Deliberately free of process, stdin, and exit codes so it can be unit tested
 * directly and reused by every client integration. Claude Code, Codex, Gemini
 * and the rest differ in how a tool call is NAMED and how a refusal is
 * EXPRESSED, not in which calls are wasteful -- so the judgement lives here
 * once and the per-client adapters stay thin.
 *
 * Returns null to allow, or { reason, key } to challenge. `key` identifies the
 * target for loop breaking, so a second attempt at the same thing gets through.
 */

import { fileSize, isBinaryPath, largeFileBytes } from './policy.mjs';

const KB = (bytes) => Math.round(bytes / 1024);

/**
 * Commands that print a whole file to stdout.
 *
 * This closes the obvious bypass: an agent that cannot `Read` a file will
 * cheerfully `cat` it instead, and the bytes land in context either way. Both
 * POSIX and PowerShell spellings are covered because Claude Code runs whichever
 * shell the platform gives it.
 */
const DUMP_COMMANDS = /\b(?:cat|bat|head|tail|more|less|type|Get-Content|gc)\b/;

/** Recursive searches, whose output is unbounded by construction. */
const RECURSIVE_SEARCH = /\b(?:grep|egrep|fgrep|rg|ag|ack|findstr|Select-String|sls)\b/;

/**
 * Pulls candidate file arguments out of a shell command.
 *
 * Flags and their values are skipped, as are anything that looks like a glob or
 * a subshell. The result is checked against the filesystem by the caller, which
 * is what keeps this honest: a token that does not resolve to a real file on
 * disk is simply not treated as one, so `git log | head -30` (no file operand)
 * and `cat <<EOF` (no such file) both pass through untouched.
 */
function fileOperands(command) {
  const operands = [];
  // Only inspect the FIRST pipeline segment. `cat big.json | jq .name` still
  // pays the read, but `git log | head` must not be mistaken for a file dump.
  const segment = command.split('|')[0];
  const tokens = segment.match(/(?:"[^"]*"|'[^']*'|[^\s]+)/g) || [];

  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i].replace(/^['"]|['"]$/g, '');
    if (token.startsWith('-')) {
      // `head -n 30 file` -- the count is a value, not a path.
      if (/^-[a-zA-Z]$/.test(token) && /^\d+$/.test(tokens[i + 1] || '')) i++;
      continue;
    }
    if (token.includes('*') || token.includes('$') || token.startsWith('<')) continue;
    operands.push(token);
  }
  return operands;
}

/**
 * Candidate filesystem paths for one operand, most specific first.
 *
 * WINDOWS SHELLS WRITE PATHS NODE CANNOT STAT. A Bash tool call on Windows
 * carries MSYS/Git-Bash paths -- `cat /c/Users/me/file.ts` -- because that is
 * what the shell accepts. The hook only PARSES that string, so no MSYS
 * translation ever happens, and `statSync('/c/Users/...')` fails ENOENT. The
 * size check then silently found nothing and every shell dump was allowed
 * through, on the one platform this runs on most.
 *
 * The `Read` tool passes `C:\Users\...`, which is why the same file was refused
 * through one path and allowed through the other.
 */
function candidatePaths(operand, cwd) {
  const paths = [];
  const msys = /^\/([A-Za-z])\/(.*)$/.exec(operand);
  if (msys) paths.push(`${msys[1].toUpperCase()}:/${msys[2]}`);

  if (operand.startsWith('/') || /^[A-Za-z]:/.test(operand)) paths.push(operand);
  else paths.push(`${cwd || '.'}/${operand}`);

  return paths;
}

/** Resolves the first operand that is a real file over the size threshold. */
function largeOperand(command, cwd) {
  const threshold = largeFileBytes();
  for (const operand of fileOperands(command)) {
    for (const path of candidatePaths(operand, cwd)) {
      const size = fileSize(path);
      if (size >= threshold && !isBinaryPath(path)) return { path: operand, size };
    }
  }
  return null;
}

/**
 * Canonical tool names, per client.
 *
 * Every CLI agent spells the same six operations differently -- Claude Code's
 * `Read` is Codex's `read_file` and Gemini's `read_file`, Cursor's `read_file`,
 * OpenCode's `read`. The waste is identical in all of them, so the names are
 * normalized here and the policy above stays written once.
 */
const TOOL_ALIASES = new Map(Object.entries({
  read: 'Read', read_file: 'Read', view_file: 'Read', readfile: 'Read',
  view: 'Read', str_replace_editor_view: 'Read', open_file: 'Read',

  grep: 'Grep', search_file_content: 'Grep', grep_search: 'Grep',
  ripgrep_search: 'Grep', codebase_search: 'Grep', search: 'Grep',

  glob: 'Glob', find_files: 'Glob', file_search: 'Glob', list_dir: 'Glob',
  glob_file_search: 'Glob',

  edit: 'Edit', edit_file: 'Edit', replace: 'Edit', apply_patch: 'Edit',
  str_replace: 'Edit', multiedit: 'Edit', search_replace: 'Edit',

  write: 'Write', write_file: 'Write', create_file: 'Write',

  bash: 'Bash', shell: 'Bash', run_command: 'Bash', execute_command: 'Bash',
  // Gemini's shell tool. Its own hooks.json matcher already listed
  // run_shell_command, so the hook fired and then normalizeTool returned null,
  // silently allowing every shell call through on that client.
  run_shell_command: 'Bash', run_terminal_cmd: 'Bash', terminal: 'Bash',
}));

/** Maps a client's tool name onto the canonical one, or null if unhandled. */
export function normalizeTool(name) {
  if (!name) return null;
  if (['Read', 'Grep', 'Glob', 'Edit', 'MultiEdit', 'Write', 'Bash'].includes(name)) return name;
  return TOOL_ALIASES.get(String(name).toLowerCase()) || null;
}

/**
 * Normalizes payload shape across clients.
 *
 * Clients disagree on the argument envelope (`tool_input` vs `tool_args` vs
 * `arguments`) and on the path key (`file_path` vs `path` vs `absolute_path`),
 * so both are resolved once here rather than in each decision branch.
 */
export function normalizePayload(raw) {
  const input = raw.tool_input || raw.tool_args || raw.arguments || raw.args || {};
  const filePath = input.file_path ?? input.path ?? input.absolute_path ?? input.filePath ?? input.target_file;
  const command = input.command ?? input.cmd ?? input.script;

  return {
    session_id: raw.session_id ?? raw.sessionId ?? raw.conversation_id ?? 'default',
    cwd: raw.cwd ?? raw.workspace_root ?? process.cwd(),
    tool_name: normalizeTool(raw.tool_name ?? raw.toolName ?? raw.tool),
    tool_input: {
      ...input,
      ...(filePath !== undefined ? { file_path: filePath } : {}),
      ...(command !== undefined ? { command } : {}),
      // Gemini and Cursor express paging as start_line/end_line.
      ...(input.start_line !== undefined ? { offset: input.start_line } : {}),
      ...(input.end_line !== undefined ? { limit: input.end_line } : {}),
    },
  };
}

/**
 * @param {object} payload   Normalized payload (tool_name, tool_input, cwd).
 * @param {object} state     Session state; `state.seen` maps path -> true.
 */
export function decide(payload, state) {
  const tool = payload.tool_name;
  const input = payload.tool_input || {};
  const threshold = largeFileBytes();

  if (tool === 'Read') {
    const path = input.file_path;
    if (!path || isBinaryPath(path)) return null;

    // A paged read is already a deliberate act of token economy. Overriding it
    // would replace a bounded read with an unbounded one.
    if (input.offset != null || input.limit != null) return null;

    const size = fileSize(path);
    if (size < 0) return null;

    // THE RE-READ CASE, which size-gating alone never caught. On a repeat visit
    // smart_read returns only what CHANGED, so the saving is proportional to
    // the whole file regardless of how small it is.
    if (state.seen[path]) {
      return {
        key: `read:${path}`,
        reason:
          `You already read ${path} earlier in this session. Call the ` +
          `token-optimizer MCP tool smart_read with path="${path}" instead -- ` +
          `it returns only a diff of what changed since that read, typically a ` +
          `few tokens rather than the whole file.`,
      };
    }

    if (size >= threshold) {
      return {
        key: `read:${path}`,
        reason:
          `${path} is ${KB(size)} KB, large enough to cost a meaningful share ` +
          `of the context window. Call the token-optimizer MCP tool smart_read ` +
          `with path="${path}" instead -- it caches the content and returns ` +
          `diffs on later reads.`,
      };
    }
    return null;
  }

  if (tool === 'Grep') {
    // Content searches are the expensive mode; a paths-only search is already
    // cheap and rewriting it would gain nothing.
    if (input.output_mode && input.output_mode !== 'content') return null;
    const pattern = input.pattern || '';
    return {
      key: `grep:${pattern}:${input.path || ''}`,
      reason:
        `Call the token-optimizer MCP tool smart_grep instead of the built-in ` +
        `Grep (pattern="${pattern}"). It returns deduplicated, context-trimmed ` +
        `matches rather than every raw hit.`,
    };
  }

  if (tool === 'Glob') {
    const pattern = input.pattern || '';
    return {
      key: `glob:${pattern}`,
      reason:
        `Call the token-optimizer MCP tool smart_glob instead of the built-in ` +
        `Glob (pattern="${pattern}"). It returns filtered, paginated paths ` +
        `rather than an unbounded match list.`,
    };
  }

  if (tool === 'Edit' || tool === 'MultiEdit') {
    const path = input.file_path;
    if (!path) return null;
    const size = fileSize(path);
    // On a small file the built-in edit is already compact; smart_edit's
    // diffing only pays for itself once the file is sizeable.
    if (size < threshold) return null;
    return {
      key: `edit:${path}`,
      reason:
        `${path} is ${KB(size)} KB. Call the token-optimizer MCP tool ` +
        `smart_edit with path="${path}" instead -- it applies the change and ` +
        `returns a compact unified diff rather than echoing the file.`,
    };
  }

  if (tool === 'Write') {
    const path = input.file_path;
    const content = input.content || '';
    if (!path || content.length < threshold) return null;
    return {
      key: `write:${path}`,
      reason:
        `You are writing ${KB(content.length)} KB to ${path}. Call the ` +
        `token-optimizer MCP tool smart_write instead -- it stores the content ` +
        `through the cache so later reads of this file diff against it.`,
    };
  }

  if (tool === 'Bash') {
    const command = input.command || '';

    if (DUMP_COMMANDS.test(command)) {
      const hit = largeOperand(command, payload.cwd);
      if (hit) {
        return {
          key: `bash:${hit.path}`,
          reason:
            `This command prints ${hit.path} (${KB(hit.size)} KB) into the ` +
            `context. Call the token-optimizer MCP tool smart_read with ` +
            `path="${hit.path}" instead -- same content, cached and diffed.`,
        };
      }
    }

    // A recursive search has no bound on its output. One with an explicit file
    // operand does, so it is left alone.
    // Recursive-search detection has to cover how people actually type it:
    // `-r`, `-R`, `--recursive`, and BUNDLED short flags like `-rn` or `-nr`.
    // The previous pattern required a lone `-r`/`-R`, so `grep -rn pattern .`
    // -- among the most common forms there is -- was not recognised at all and
    // passed straight through.
    const recursiveFlag =
      /(^|\s)-[A-Za-z]*[rR][A-Za-z]*(\s|$)|--recursive\b|\brg\b|\bag\b|\back\b/;
    if (RECURSIVE_SEARCH.test(command) && recursiveFlag.test(command)) {
      if (!largeOperand(command, payload.cwd)) {
        return {
          key: `bash:search:${command.slice(0, 80)}`,
          reason:
            `Recursive shell searches return unbounded output. Call the ` +
            `token-optimizer MCP tool smart_grep instead -- it caps and ` +
            `deduplicates results before they reach the context window.`,
        };
      }
    }
  }

  return null;
}

/** Records a successful (allowed) read so a later repeat is recognised. */
export function remember(payload, state) {
  const path = payload.tool_input?.file_path;
  if (path && (payload.tool_name === 'Read' || payload.tool_name === 'Write')) {
    state.seen[path] = true;
  }
}

/**
 * The size an allowed read actually cost, or 0 when it is not a read.
 *
 * This is the measurement the holdout comparison consumes. It has to be taken
 * here, at the moment a read is permitted, because that is the only point where
 * the cost is both known and attributable to an anchor.
 */
export function readCostBytes(payload) {
  if (payload.tool_name !== 'Read') return 0;
  const path = payload.tool_input?.file_path;
  if (!path || isBinaryPath(path)) return 0;
  const size = fileSize(path);
  return size > 0 ? size : 0;
}
