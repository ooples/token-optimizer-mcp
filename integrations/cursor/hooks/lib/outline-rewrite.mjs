// GENERATED FILE -- do not edit.
// Source of truth: hooks-core/outline-rewrite.mjs. Regenerate with `npm run sync:hooks`.
/**
 * Answering a whole-file read with a structural outline of the same file.
 *
 * ONE IMPLEMENTATION FOR EVERY CLIENT. This lived in the Claude Code plugin's
 * router, so the other native integrations -- whose shared adapter can rewrite
 * a tool call too -- never outlined anything at all (issue #478). Both the
 * router and the adapter now call these functions, so the once-per-file record,
 * the per-agent pricing and the shell quoting cannot drift apart.
 *
 * Every function returns null whenever anything is uncertain. Substituting on a
 * guess is how a mechanism that saves context starts costing turns.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { substitutionFor } from './substitute.mjs';
import { wholeFileDump } from './decide.mjs';
import { canonicalPath } from './paths.mjs';

/** Where served outlines are written; a file's presence is the once-per-file record. */
export function outlineDir() {
  return join(tmpdir(), 'token-optimizer-compact');
}

/** The record key for one file in one session -- the formula the router always used. */
function recordKey(sessionId, filePath) {
  return createHash('sha256').update(`${sessionId}\u0000${filePath}`).digest('hex').slice(0, 32);
}

/**
 * How many tool calls this agent has made, for pricing a substitution.
 *
 * Read from the agent's own state. It used to count marker files by a
 * session-id prefix, but those files are named by a hash, so the count was
 * always 0; and a session-wide count would charge a subagent for its parent's
 * and siblings' calls.
 */
export function turnsSoFar(state) {
  return Number(state?.toolCalls) || 0;
}

/**
 * An outline for a whole-file read of `filePath`, or null.
 *
 * A PAGED READ IS NEVER OUTLINED: the offset and limit would be applied to the
 * outline file, and the outline's own advice -- read with offset and limit --
 * would loop. And a file already outlined once in this session is not outlined
 * again: asking twice is the model saying the outline did not answer.
 */
export function outlineRead({ sessionId, filePath, offset, limit, state }) {
  if (!filePath) return null;
  // KEYED ON THE CANONICAL PATH, as outlineShell keys it. Read hands over
  // `C:\x\a.ts` and the shell side canonicalises to `C:/x/a.ts`, so on Windows
  // the record this module calls "shared" between a cat and a Read never was,
  // and a ranged shell read could not find the outline a Read had served.
  const target = join(outlineDir(), `${recordKey(sessionId || '', canonicalPath(filePath))}.outline.txt`);
  const missed = missedMarker(sessionId);

  if (offset != null || limit != null) {
    // A PAGED READ OF A FILE THIS SESSION WAS GIVEN AN OUTLINE OF says the
    // outline did not answer, and from then on the session gets whole files.
    // Measured 2026-10-30 on two long porting sessions: 22 of 29 outlines were
    // followed by paged reads of the same file, usually covering all of it, so
    // the outlines saved 21k tokens and cost about 25 extra calls. Stopping at
    // the first such read keeps all but ~3 of those calls off.
    if (missed && existsSync(target)) {
      try {
        writeFileSync(missed, '', { flag: 'a', mode: 0o600 });
      } catch {
        // Nowhere to write: outlines simply continue.
      }
    }
    return null;
  }
  if (missed && existsSync(missed)) return null;
  const found = substitutionFor(filePath, {
    turnsSoFar: turnsSoFar(state),
    alreadyRead: existsSync(target),
  });
  if (!found) return null;

  try {
    mkdirSync(outlineDir(), { recursive: true, mode: 0o700 });
    // EXCLUSIVE AND PRIVATE. The record is also the once-per-file rule, and
    // checking for it and then writing it left a window in which two parallel
    // calls both served an outline. `wx` makes creating it the claim: whoever
    // loses gets EEXIST and serves the file. 0o600, because the outline of a
    // private source file sits in the shared temp directory; and `wx` never
    // follows a path someone else created there first.
    writeFileSync(target, found.outline, { flag: 'wx', mode: 0o600 });
    return { target, found };
  } catch {
    // Already claimed by a parallel call, or nowhere to write: either way, no
    // substitution -- never a broken read.
    return null;
  }
}

// A command that prints part of a file rather than all of it.
const RANGED_READ =
  /\bsed\s+(?:-\w+\s+)*-n\b|\bawk\b[^|;&]*\bNR\b|(?:^|[|;&]\s*)(?:head|tail)\b|\bSelect-Object\b[^|;&]*-(?:First|Last|Skip|Index)\b|\bGet-Content\b[^|;&]*-(?:TotalCount|Tail|Head)\b/i;

/**
 * A SHELL read of part of a file this session was given an outline of ends
 * outlining too, exactly as a paged Read does. Agents page through files with
 * `sed -n 'A,Bp'`, `awk 'NR>=A'`, `head`/`tail` and `Select-Object` at least as
 * often as with Read offsets -- one porting session did nothing else -- and
 * those reads never reach outlineRead, so the session went on paying for an
 * outline and then the file, file after file.
 *
 * Every word of the command that names a file this session has an outline
 * record for is checked; the command itself is never changed.
 */
function noteRangedShellRead({ sessionId, command, cwd }) {
  const missed = missedMarker(sessionId);
  if (!missed || typeof command !== 'string' || !RANGED_READ.test(command)) return;
  for (const path of rangedReadOperands(command)) {
    let canonical;
    try {
      canonical = canonicalPath(path, cwd);
    } catch {
      continue;
    }
    const target = join(outlineDir(), `${recordKey(sessionId, canonical)}.outline.txt`);
    if (!existsSync(target)) continue;
    try {
      writeFileSync(missed, '', { flag: 'a', mode: 0o600 });
    } catch {
      // Nowhere to write: outlines simply continue.
    }
    return;
  }
}

// A program that prints a file, possibly only part of it.
const READER = /^(cat|type|nl|head|tail|sed|awk|less|more|Get-Content|gc)$/i;
// A stage that only narrows what an earlier stage printed.
const NARROWER = /^(head|tail|sed|awk|nl|cut|Select-Object|select|cat)$/i;

/** The words of one shell stage, with quotes removed (bash/PowerShell subset). */
function words(stage) {
  return (stage.match(/'[^']*'|"(?:\\.|[^"\\])*"|\S+/g) || []).map((w) =>
    w.replace(/^'(.*)'$/s, '$1').replace(/^"(.*)"$/s, '$1')
  );
}

/**
 * The files a ranged read actually reads: the operands of the program that
 * produces each pipeline's output, and only when every later stage merely
 * narrows it. `echo a.ts | sed -n 1,20p b.ts` reads b.ts, not a.ts (review);
 * an `sed`/`awk` script argument is not an operand.
 */
function rangedReadOperands(command) {
  const out = [];
  for (const statement of pipelines(command)) {
    const stages = statement.map((stage) => words(stage.trim())).filter((w) => w.length);
    if (!stages.length) continue;
    // The producer is the LAST stage that names files of its own: a later
    // `sed -n ... b.ts` ignores its stdin, so b.ts is what is printed.
    let producer = -1;
    for (let k = stages.length - 1; k >= 0; k--) {
      if (READER.test(stages[k][0]) && fileOperands(stages[k]).length) {
        producer = k;
        break;
      }
    }
    if (producer < 0) continue;
    if (!stages.slice(producer + 1).every((w) => NARROWER.test(w[0]))) continue;
    out.push(...fileOperands(stages[producer]));
  }
  return out.slice(0, 24);
}

/**
 * Statements as lists of pipeline stages, split OUTSIDE quotes:
 * `awk 'NR>=10 && NR<=90' a.ts` is one stage, not two statements.
 */
function pipelines(command) {
  const statements = [];
  let stages = [];
  let current = '';
  let quote = '';
  const endStage = () => {
    stages.push(current);
    current = '';
  };
  const endStatement = () => {
    endStage();
    statements.push(stages);
    stages = [];
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    const next = command[i + 1];
    if (quote) {
      current += c;
      if (c === quote) quote = '';
    } else if (c === "'" || c === '"') {
      quote = c;
      current += c;
    } else if (c === '\n' || c === ';') {
      endStatement();
    } else if ((c === '&' && next === '&') || (c === '|' && next === '|')) {
      endStatement();
      i++;
    } else if (c === '|') {
      endStage();
    } else {
      current += c;
    }
  }
  endStatement();
  return statements;
}

/** Path operands of one reader invocation: no flags, and not an sed/awk script. */
function fileOperands(argv) {
  const [program, ...rest] = argv;
  let args = rest.filter((w) => !w.startsWith('-'));
  if (/^(sed|awk)$/i.test(program)) args = args.slice(1);
  return args.filter((w) => /[\\/.]/.test(w) && !/^[\d,$p;]+$/.test(w));
}

/**
 * The marker that ends outlining for a session, or null when there is no real
 * session to scope it to. Codex and Qwen can omit every session id, and the
 * payload normaliser then assigns `default`: a marker under that name would be
 * shared by every such session, so one session paging a file would switch
 * outlines off for all of them (review). Without a real id, outlining stays
 * as it was and no marker is kept.
 */
function missedMarker(sessionId) {
  const id = typeof sessionId === 'string' ? sessionId.trim() : '';
  if (!id || id === 'default') return null;
  return join(outlineDir(), `${recordKey(id, '')}.outline-missed`);
}

/** What the model is told when its read is answered with an outline. */
export function readNotice(displayPath, found) {
  return (
    `token-optimizer replaced this read with a structural outline of ` +
    `${displayPath} (${found.lines} lines, ${Math.round(found.bytes / 1024)}KB). ` +
    `Every symbol is listed with its line number; read the original with offset ` +
    `and limit for any region you need in full.`
  );
}

/**
 * An outline for a command that prints exactly one whole file, or null.
 *
 * `wholeFileDump` refuses pipelines, chains, redirects, flags and slices, and the
 * once-per-file record is SHARED with `outlineRead`, so an outline served to
 * `cat f` counts for a later `Read f` and the second whole read gets the file.
 *
 * The rewritten command has to run in the shell that runs it. `shell` is
 * 'powershell' or 'posix'; anything else -- a shell this cannot name -- is not
 * rewritten, because a quoted path in the wrong shell's syntax is a broken
 * command, not a cheaper one.
 */
export function outlineShell({ sessionId, command, cwd, shell, state }) {
  noteRangedShellRead({ sessionId, command, cwd });
  if (shell !== 'powershell' && shell !== 'posix') return null;
  const dump = wholeFileDump(command, cwd);
  if (!dump) return null;
  // `type` prints a file only in PowerShell and cmd. In a POSIX shell it is the
  // builtin that describes a command, so rewriting it would change its meaning.
  if (shell === 'posix' && !/^cat$/i.test(dump.head)) return null;

  const substitution = outlineRead({
    sessionId,
    filePath: canonicalPath(dump.path, cwd),
    state,
  });
  if (!substitution) return null;

  // PowerShell takes a single-quoted literal path with '' as the escape, and
  // reads a BOM-less file as the ANSI code page unless told UTF-8. A POSIX shell
  // takes '\'' as the escape; Git Bash accepts a drive path with forward slashes.
  const rewritten =
    shell === 'powershell'
      ? `Get-Content -LiteralPath '${substitution.target.replace(/'/g, "''")}' -Encoding UTF8`
      : `cat '${substitution.target.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`;

  const notice =
    `token-optimizer replaced this command's output with a structural outline of ` +
    `${dump.operand} (${substitution.found.lines} lines, ` +
    `${Math.round(substitution.found.bytes / 1024)}KB). Every symbol is listed ` +
    `with its line number; print a line range of the original (sed -n 'A,Bp', or ` +
    `Get-Content with Select-Object -Skip/-First) or Read it with offset and limit ` +
    `for any region you need in full. Printing the whole file again returns it in full.`;
  return { command: rewritten, notice, found: substitution.found };
}
