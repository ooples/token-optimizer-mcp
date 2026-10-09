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
  if (offset != null || limit != null) return null;

  const target = join(outlineDir(), `${recordKey(sessionId || '', filePath)}.outline.txt`);
  const found = substitutionFor(filePath, {
    turnsSoFar: turnsSoFar(state),
    alreadyRead: existsSync(target),
  });
  if (!found) return null;

  try {
    mkdirSync(outlineDir(), { recursive: true });
    writeFileSync(target, found.outline);
    return { target, found };
  } catch {
    // Nowhere to write means no substitution, never a broken read.
    return null;
  }
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
