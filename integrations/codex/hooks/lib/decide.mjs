// GENERATED FILE -- do not edit.
// Source of truth: hooks-core/decide.mjs. Regenerate with `npm run sync:hooks`.
﻿/**
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

import {
  fileSize,
  isBinaryPath,
  isMachineOwned,
  largeFileBytes,
  refusalFloorBytes,
} from './policy.mjs';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalPath, resolvableCandidates, isFsSafePath } from './paths.mjs';
import { activeRules } from './remedy.mjs';
import { wikiDir, projectRootFor } from './wiki.mjs';

const KB = (bytes) => Math.round(bytes / 1024);

/** Whether a path names an existing directory. Never throws. */
function isDirectory(path) {
  // See fileSize: a native abort is not catchable, so the check precedes the
  // stat rather than relying on the try below.
  if (!isFsSafePath(path)) return false;
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Does this command DUMP file contents, rather than merely naming a file?
 *
 * `cat`, `head` and `grep` pay for the bytes; `Write`, `Edit` and a bare
 * `wc -l` do not. Charging a full-file read for all of them overstated the very
 * cost the holdout comparison is built on, and an inflated saving is the one
 * failure this project cannot afford.
 */
export function isContentDump(command) {
  if (typeof command !== 'string') return false;
  // Heredoc bodies are data. A commit message that says `cat foo.ts` does not
  // print foo.ts, and charging the session for its bytes would inflate the
  // measured cost -- the one number this project must never overstate.
  const runnable = stripHeredocs(command);
  if (RECURSIVE_SEARCH.test(runnable)) return true;
  if (!DUMP_COMMANDS.test(runnable)) return false;

  // A DUMP WHOSE STDOUT GOES TO A FILE PUTS NOTHING IN CONTEXT, and refusing it is a false
  // positive that blocks ordinary work. `cat >> file <<'EOF'` is the standard way to APPEND a
  // heredoc -- cat is WRITING there, not printing -- and stripping the heredoc body leaves
  // `cat >> file <<'EOF'`, which still matched \bcat\b and was refused.
  //
  // Hit while appending a test file to this very repository. The whole Bash call was denied, so
  // the git checkout and the python edit chained inside it silently never ran, and the change
  // looked applied when nothing had happened. A false positive here does not merely annoy: it
  // fails silently in the middle of a compound command.
  //
  // The same reasoning covers `head -100 big.log > out.txt` -- those bytes land on disk, not in
  // the transcript. Segments are checked individually, so `cat big.ts | head`, where the output
  // DOES reach context, is still caught.
  return segmentsOf(runnable).some(
    (segment) => DUMP_COMMANDS.test(segment) && !redirectsStdoutToFile(segment),
  );
}

/** Command segments, split on the operators that end one command's stdout. */
function segmentsOf(command) {
  return String(command).split(/\|\||&&|[|;&\n]/).map((s) => s.trim()).filter(Boolean);
}

/**
 * Does this segment send its stdout to a file?
 *
 * `2>` is stderr and does not count, and `>&1`/`>&2` duplicate a descriptor rather than naming a
 * file. Anything else of the form `>` or `>>` followed by a path captures output that would
 * otherwise have reached the transcript.
 */
function redirectsStdoutToFile(segment) {
  return /(?:^|[^0-9&2])>>?\s*(?!&)\S+/.test(String(segment));
}

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
const RECURSIVE_SEARCH =
  /\b(?:grep|egrep|fgrep|rg|ag|ack|findstr|Select-String|sls)\b/;

/** The search tools themselves, as a whole command word rather than a substring. */
const SEARCH_TOOL =
  /^(?:grep|egrep|fgrep|rg|ag|ack|findstr|Select-String|sls)$/i;

/** Tools that walk directories with no flag asked for. */
const RECURSES_BY_DEFAULT = /^(?:rg|ag|ack)$/i;

/** Words that may precede the real command without changing what it is. */
const COMMAND_PREFIX = /^(?:sudo|time|env|command|nice|ionice|nohup|xargs)$/;

/**
 * Removes heredoc BODIES, which are data the command carries rather than
 * commands the shell will run.
 *
 * `git commit -F - <<'MSG' ... MSG` is one command that runs git. Every line of
 * the message is text. This hook refused its own author three separate times
 * over one afternoon -- a test body quoting `cat .git/index`, then two commit
 * messages describing the greps they had just fixed -- because those lines were
 * parsed as though the shell would execute them.
 *
 * Data is the safe reading. Treating a heredoc as commands produces refusals of
 * things that will never run, which cost a turn each; treating it as data at
 * worst misses an optimization on the rare `bash <<EOF` that really does pipe a
 * script in.
 */
function stripHeredocs(command) {
  const lines = String(command).split('\n');
  const out = [];
  let delimiter = null;

  for (const line of lines) {
    if (delimiter !== null) {
      if (line.trim() === delimiter) delimiter = null;
      continue;
    }
    out.push(line);
    const opener = line.match(/<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/);
    if (opener) delimiter = opener[2];
  }

  return out.join('\n');
}

/**
 * Splits a command into its pipeline/list segments WITHOUT splitting inside
 * quotes.
 *
 * Quote awareness is the whole point. A `node -e "...; grep -r x ."` is one
 * command that runs node; the text after the semicolon is an argument, not a
 * segment, and treating it as one makes the hook react to strings that are
 * merely mentioned.
 */
function shellSegments(command) {
  const out = [];
  let current = '';
  let quote = null;

  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote) {
      if (c === quote && command[i - 1] !== '\\') quote = null;
      current += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      current += c;
    } else if (c === ';' || c === '\n' || c === '|' || c === '&') {
      if ((c === '|' || c === '&') && command[i + 1] === c) i++;
      out.push(current);
      current = '';
    } else {
      current += c;
    }
  }
  out.push(current);
  return out;
}

/**
 * Is this command an unbounded recursive search?
 *
 * The question has to be asked PER SEGMENT, of the segment's head word. The
 * previous version tested "does a search tool appear anywhere in the string"
 * and "does a -r-ish flag appear anywhere in the string" INDEPENDENTLY, and
 * denied when both were true anywhere. So this, caught live against a real
 * build command, was refused as a recursive search:
 *
 *   rm -rf build && npm run verify | grep passed
 *
 * `rm -rf` supplied the flag, `grep passed` supplied the tool, and neither
 * segment is a recursive search. Any `cp -r`, `chmod -R`, `ls -R` or `tar -rf`
 * next to any grep hit the same false positive, and a wrongly refused command
 * costs the user a whole turn to work around.
 *
 * Quote-aware segmentation fixes the mirror-image case at the same time: a
 * `grep -rn` quoted inside a script body is a string, not a command.
 */
export function isRecursiveSearch(command) {
  if (typeof command !== 'string') return false;

  for (const segment of shellSegments(stripHeredocs(command))) {
    const tokens = segment.match(/(?:"[^"]*"|'[^']*'|[^\s]+)/g) || [];

    let i = 0;
    while (
      i < tokens.length &&
      (/^\w+=/.test(tokens[i]) || COMMAND_PREFIX.test(tokens[i]))
    )
      i++;
    if (i >= tokens.length) continue;

    // `/usr/bin/grep` is grep; `git grep` is grep with a word in front.
    let head = tokens[i].replace(/^.*[/\\]/, '');
    if (head === 'git' && tokens[i + 1] === 'grep') {
      head = 'grep';
      i++;
    }
    if (!SEARCH_TOOL.test(head)) continue;

    if (RECURSES_BY_DEFAULT.test(head)) return true;

    const flags = tokens.slice(i + 1);
    if (
      flags.some(
        (t) => t === '--recursive' || /^-[A-Za-z]*[rR][A-Za-z]*$/.test(t)
      )
    )
      return true;
  }

  return false;
}

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
    if (token.includes('*') || token.includes('$') || token.startsWith('<'))
      continue;
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
  return resolvableCandidates(operand, cwd);
}

/**
 * Every real file this call touches, canonicalised.
 *
 * THE GRAPH'S PRODUCER. Before this existed, only `tool_input.file_path` was
 * ever observed -- so a session spent in the shell (`cat`, `grep -r`, reading a
 * build log) produced no cost record and no graph node, and measured as though
 * nothing had happened. Bash operands are real touches and belong in both.
 *
 * Only paths that RESOLVE are returned: an operand that is a flag, a glob or a
 * heredoc marker is not a file, and inventing a node for it would put fiction
 * in the graph.
 */
/**
 * The project a COMMAND belongs to.
 *
 * `forCommand` was looked up with `projectRootFor(payload.cwd, payload.cwd)`, so
 * the graph consulted was always the SESSION's. Run a command inside another
 * checkout -- a worktree, a second repository, anything reached with `cd` -- and
 * every finding recorded against that project was silently skipped: no
 * injection, no metrics row, no error.
 *
 * `projectRootFor` documents this same defect being fixed for the FILE path:
 * keying the graph on where the client happens to be running is wrong the moment
 * a session touches a second repository. The command path kept the behaviour
 * that comment calls wrong.
 *
 * Only a `cd` naming a directory that EXISTS is trusted, exactly as touchedFiles
 * treats it: `cd $UNSET && npm test` must not re-root the lookup onto nothing.
 */
export function commandProjectRoot(payload, fallback) {
  const raw = payload?.tool_input?.command;
  const base = payload?.cwd ?? fallback;
  if (typeof raw === 'string') {
    const command = stripHeredocs(raw);
    const cd = /(?:^|\n|;|&&)\s*cd\s+("[^"]+"|'[^']+'|\S+)/.exec(command);
    if (cd) {
      const target = canonicalPath(cd[1].replace(/^['"]|['"]$/g, ''), base);
      // A pseudo-file inside the directory, because projectRootFor takes a FILE
      // and starts from its dirname -- handing it a directory begins the walk one
      // level too high and silently falls back. Same idiom as stop-harvest.mjs.
      if (isDirectory(target))
        return projectRootFor(join(target, '__command__'), base);
    }
  }
  return projectRootFor(join(base, '__command__'), base);
}

export function touchedFiles(payload) {
  const input = payload?.tool_input || {};
  // path -> size. Resolving a candidate ALREADY stats it -- `fileSize() >= 0`
  // is how a real file is told from a flag, a glob or a heredoc marker -- and
  // throwing that answer away made every caller measure the same file again,
  // on a hook that runs before EVERY tool call.
  const out = new Map();

  // A `cd` INSIDE the command changes where its relative operands resolve, and
  // the hook payload's cwd knows nothing about it. Observed live: a Bash call
  // that began `cd /other/repo` had every one of its relative operands resolved
  // against the session's directory instead, found nothing, and recorded no
  // touch at all -- so work in a second repository was invisible.
  // Heredoc bodies stripped first, for the same reason the cost path strips
  // them: a file named inside a commit message or a test fixture was mentioned,
  // not touched, and a node built from it is fiction.
  const command =
    typeof input.command === 'string' ? stripHeredocs(input.command) : '';
  const cd = /(?:^|\n|;|&&)\s*cd\s+("[^"]+"|'[^']+'|\S+)/.exec(command);
  const cdTarget = cd
    ? canonicalPath(cd[1].replace(/^['"]|['"]$/g, ''), payload?.cwd)
    : null;
  // Only trust a `cd` that names a directory which EXISTS. `cd $REPO && cat
  // src/app.ts` -- an unexpanded variable, or a plain typo -- otherwise re-bases
  // every relative operand onto a path resolving to nothing, so the call records
  // no touch at all. Falling back to the session cwd is strictly better than
  // losing the observation.
  // `isDirectory` is a statSync, and it runs ahead of the per-candidate check
  // below -- so guarding only the candidates left the abort reachable through
  // any command beginning `cd <bad path> && ...`. The guard lives INSIDE
  // isDirectory rather than here: a second check at this call site would mask
  // the removal of the real one, and a mutation proved exactly that.
  const cwd = cdTarget && isDirectory(cdTarget) ? cdTarget : payload?.cwd;

  const add = (candidate) => {
    if (!candidate || typeof candidate !== 'string') return;
    for (const spelling of resolvableCandidates(candidate, cwd)) {
      // Sizing a candidate stats it, and a path carrying U+10FFFF aborts libuv
      // outright rather than throwing. This is where externally supplied paths
      // first enter the hook, so refusing here keeps the character away from
      // every downstream consumer instead of asking each one to defend itself.
      if (!isFsSafePath(spelling)) continue;
      const size = fileSize(spelling);
      if (size >= 0) {
        // Nothing under .git/, node_modules/ or a build directory belongs in a
        // knowledge graph: it is not authored, it churns constantly, and it
        // would thrash staleness for every file that anchors to it.
        if (!isMachineOwned(spelling))
          out.set(canonicalPath(spelling, cwd), size);
        return;
      }
    }
  };

  add(input.file_path);
  add(input.path);
  add(input.notebook_path);

  // EVERY pipeline segment, not just the first. `fileOperands` looks only at
  // the head of the pipeline because that is where the COST is -- `git log |
  // head` must not be mistaken for a file dump. But observation is a different
  // question from cost: a file named after a pipe was still read, and dropping
  // it loses a real touch. Non-files fall out anyway, since only operands that
  // resolve are kept.
  for (const segment of command.split('|')) {
    for (const operand of fileOperands(segment)) add(operand);
  }

  return [...out].map(([path, size]) => ({ path, size }));
}
/** Dump commands as a whole word, for testing a segment's head. */
const DUMP_HEAD = /^(?:cat|bat|head|tail|more|less|type|Get-Content|gc)$/i;

/**
 * The first large file this command will ACTUALLY PRINT.
 *
 * The dump check and the operand lookup have to be the same segment, or the
 * hook refuses commands that print nothing. Measured live, on a command that
 * merely counted the lines of a big file and tailed a log:
 *
 *   ls .token-optimizer/wiki/ && wc -l graph.jsonl
 *   node web-server.js > dash.log &
 *   grep -iE "listen|error" dash.log | head -5
 *
 * `head` (last segment, operating on a 4 KB log) satisfied a whole-string
 * DUMP_COMMANDS test, and the operand search then returned graph.jsonl from the
 * FIRST segment, producing "this command prints graph.jsonl (22840 KB) into the
 * context". It prints a line count. Same defect as the recursive-search one
 * fixed alongside it: two independent whole-string tests, joined by an `&&`
 * that has nothing to do with either.
 */
function largeDumpedOperand(command, cwd) {
  const threshold = largeFileBytes();

  for (const segment of shellSegments(stripHeredocs(command))) {
    const tokens = segment.match(/(?:"[^"]*"|'[^']*'|[^\s]+)/g) || [];

    let i = 0;
    while (
      i < tokens.length &&
      (/^\w+=/.test(tokens[i]) || COMMAND_PREFIX.test(tokens[i]))
    )
      i++;
    if (i >= tokens.length) continue;
    if (!DUMP_HEAD.test(tokens[i].replace(/^.*[/\\]/, ''))) continue;

    // Only THIS segment's operands, and only from the dump command onwards.
    for (const operand of fileOperands(tokens.slice(i).join(' '))) {
      for (const path of candidatePaths(operand, cwd)) {
        const size = fileSize(path);
        if (size >= threshold && !isBinaryPath(path) && !isMachineOwned(path)) {
          return { path: operand, size };
        }
      }
    }
  }

  return null;
}

/** Resolves the first operand that is a real file over the size threshold. */
function largeOperand(command, cwd) {
  const threshold = largeFileBytes();
  for (const operand of fileOperands(command)) {
    for (const path of candidatePaths(operand, cwd)) {
      const size = fileSize(path);
      // Machine-owned too, not just binary-by-extension. `.git/index` has NO
      // extension, so isBinaryPath cannot see it, and the advisory it produced
      // named a 1.3 MB binary index and pointed at smart_read -- which would
      // have dumped it. Observed live on this repository's own commit command.
      if (size >= threshold && !isBinaryPath(path) && !isMachineOwned(path)) {
        return { path: operand, size };
      }
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
const TOOL_ALIASES = new Map(
  Object.entries({
    read: 'Read',
    read_file: 'Read',
    view_file: 'Read',
    readfile: 'Read',
    view: 'Read',
    str_replace_editor_view: 'Read',
    open_file: 'Read',

    grep: 'Grep',
    search_file_content: 'Grep',
    grep_search: 'Grep',
    ripgrep_search: 'Grep',
    codebase_search: 'Grep',
    search: 'Grep',

    glob: 'Glob',
    find_files: 'Glob',
    file_search: 'Glob',
    list_dir: 'Glob',
    glob_file_search: 'Glob',

    edit: 'Edit',
    edit_file: 'Edit',
    replace: 'Edit',
    apply_patch: 'Edit',
    str_replace: 'Edit',
    multiedit: 'Edit',
    search_replace: 'Edit',

    write: 'Write',
    write_file: 'Write',
    create_file: 'Write',

    bash: 'Bash',
    powershell: 'Bash',
    pwsh: 'Bash',
    shell: 'Bash',
    run_command: 'Bash',
    execute_command: 'Bash',
    // Gemini's shell tool. Its own hooks.json matcher already listed
    // run_shell_command, so the hook fired and then normalizeTool returned null,
    // silently allowing every shell call through on that client.
    run_shell_command: 'Bash',
    run_terminal_cmd: 'Bash',
    terminal: 'Bash',
  })
);

/** Maps a client's tool name onto the canonical one, or null if unhandled. */
export function normalizeTool(name) {
  if (!name) return null;
  if (
    ['Read', 'Grep', 'Glob', 'Edit', 'MultiEdit', 'Write', 'Bash'].includes(
      name
    )
  )
    return name;
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
  // camelCase is accepted for the CONTAINER too, not just for `toolName` and
  // `sessionId`. Accepting `toolName` but not `toolArgs` meant a client that
  // spoke camelCase throughout had its arguments silently dropped: the payload
  // still carried a tool name, so the hook ran, found no path and no command,
  // and allowed every call. A total no-op with nothing in stderr and no failing
  // check anywhere -- the worst way for an integration to be broken.
  const rawInput =
    raw.tool_input ||
    raw.toolInput ||
    raw.tool_args ||
    raw.toolArgs ||
    raw.arguments ||
    raw.args ||
    raw.parameters ||
    {};
  let input = rawInput;
  // Copilot CLI serializes toolArgs as a JSON string. Treating that string as
  // an object preserved the tool name but discarded every argument, so every
  // hook invocation silently allowed the call.
  if (typeof rawInput === 'string') {
    try {
      input = JSON.parse(rawInput);
    } catch {
      input = {};
    }
  }
  const filePath =
    input.file_path ??
    input.path ??
    input.absolute_path ??
    input.filePath ??
    input.target_file;
  const command = input.command ?? input.cmd ?? input.script;

  const cwd = raw.cwd ?? raw.workspace_root ?? process.cwd();

  return {
    session_id: raw.session_id ?? raw.sessionId ?? raw.conversation_id ?? 'default',
    // WHICH AGENT, not just which session. Subagents inherit the parent's session
    // id, so state keyed on the session alone is shared by every agent under it
    // -- which made one agent's reads silence another's. The transcript path is
    // per agent, and it has to survive normalisation to be usable: this function
    // returns a NEW object rather than spreading `raw`, so a field that is not
    // named here is silently dropped. That is exactly how it was lost the first
    // time this fix was attempted.
    transcript_path: raw.transcript_path ?? raw.transcriptPath ?? null,
    cwd,
    tool_name: normalizeTool(raw.tool_name ?? raw.toolName ?? raw.tool),
    tool_input: {
      ...input,
      // CANONICALISED HERE, once. Every consumer downstream -- the `seen` map
      // that powers re-read detection, the verdict key that powers loop
      // breaking, the size check, and the wiki anchor -- keys off this value,
      // so normalising at the single point they all share is what makes one
      // file one identity regardless of which tool spelled it.
      ...(filePath !== undefined
        ? { file_path: canonicalPath(filePath, cwd) }
        : {}),
      // The ORIGINAL spelling, kept for messages. Identity is internal and
      // canonical; what the refusal says back to the model should be the path
      // the model actually used, or the instruction reads as being about a
      // different file than the one it asked for.
      ...(filePath !== undefined ? { raw_file_path: filePath } : {}),
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
/**
 * A skip rule covering this path, if one is in force.
 *
 * Only the rule types that mean "do not read the contents". A composite touch
 * or a diff preference changes what is SERVED, not whether the call proceeds,
 * and turning either into a refusal would deny a read nobody decided to deny.
 */
function matchingRule(cwd, path) {
  const canonical = canonicalPath(path);
  for (const rule of activeRules(wikiDir(cwd))) {
    if (rule.type !== 'skip' && rule.type !== 'skeleton-only') continue;
    if (rule.anchor && rule.anchor === canonical) return rule;
  }
  return null;
}

export function decide(payload, state) {
  const tool = payload.tool_name;
  const input = payload.tool_input || {};
  const threshold = largeFileBytes();

  if (tool === 'Read') {
    const path = input.file_path;
    const shown = input.raw_file_path ?? path;
    // Machine-owned paths are never refused: there is no structure to offer
    // and no knowledge to carry, so a refusal would promise both and deliver
    // neither.
    if (!path || isBinaryPath(path) || isMachineOwned(path)) return null;

    // A paged read is already a deliberate act of token economy. Overriding it
    // would replace a bounded read with an unbounded one.
    if (input.offset != null || input.limit != null) return null;

    const size = fileSize(path);
    if (size < 0) return null;

    // A REFUSAL IS NOT FREE. The message that replaces the file is itself
    // 50-110 tokens, so below the floor every branch here spends more than the
    // read would have cost. Measured live: a re-read of a 9-byte version.json
    // (2 tokens) was refused with a 57-token message. Allowing the read is
    // strictly cheaper, so allow it.
    if (size < refusalFloorBytes()) return null;

    // A FIX THAT HAS BEEN APPLIED HAS TO BITE, or it was a report with extra
    // steps. Rules are derived from this project's own measured history -- a
    // file read across many sessions that has never once been the source of a
    // finding -- so the refusal states the measurement rather than a policy.
    const rule = matchingRule(payload.cwd, path);
    if (rule) {
      return {
        key: `read:${path}`,
        reason:
          `${shown} is covered by a fix applied on ${new Date(rule.appliedAt).toISOString().slice(0, 10)}: ` +
          `${rule.why}. Call smart_read with path="${shown}" for its structure, or ` +
          `revert the rule with id "${rule.id}" if it is wrong.`,
      };
    }

    // THE RE-READ CASE, which size-gating alone never caught. On a repeat visit
    // smart_read returns only what CHANGED, so the saving is proportional to
    // the whole file rather than to how much of it is new -- but only above the
    // floor, because below it the refusal costs more than the file it replaces.
    if (state.seen[path]) {
      return {
        key: `read:${path}`,
        reason:
          `You already read ${shown} earlier in this session. Call the ` +
          `token-optimizer MCP tool smart_read with path="${shown}" instead -- ` +
          `it returns only a diff of what changed since that read, typically a ` +
          `few tokens rather than the whole file.`,
      };
    }

    if (size >= threshold) {
      return {
        key: `read:${path}`,
        reason:
          `${shown} is ${KB(size)} KB, large enough to cost a meaningful share ` +
          `of the context window. Call the token-optimizer MCP tool smart_read ` +
          `with path="${shown}" instead -- it caches the content and returns ` +
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

    {
      const hit = largeDumpedOperand(command, payload.cwd);
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
    if (isRecursiveSearch(command)) {
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

/**
 * Records a successful (allowed) READ so a later repeat is recognised.
 *
 * READ ONLY, which is what this docstring always claimed. The condition also
 * admitted `Write`, and a write is not a read: the model holds what it wrote, not
 * the file, and for a small edit to a large file those are very different things.
 *
 * What that cost, observed live: a test file authored earlier in the session via
 * Write was refused on its FIRST EVER Read with "UNCHANGED since you last read it
 * this session -- use what you already have", and the harness then refused the
 * following Write with "File has not been read yet", because from its side no read
 * had happened. Neither side was wrong about its own bookkeeping; the hook had
 * simply asserted a read that never occurred. Escapable only by retrying the Read.
 */
export function remember(payload, state) {
  const path = payload.tool_input?.file_path;
  if (path && payload.tool_name === 'Read') {
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
