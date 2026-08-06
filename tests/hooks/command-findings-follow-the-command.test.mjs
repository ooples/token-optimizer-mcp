import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * A command-triggered finding must be looked up in the project the COMMAND runs
 * in, not the one the session happens to sit in.
 *
 * `forCommand` was handed `wikiDir(projectRootFor(payload.cwd, payload.cwd))`, so
 * the graph consulted was always the session's. Run a command inside another
 * checkout -- a worktree, a second repository, anything reached with `cd` -- and
 * every finding recorded against that project is silently skipped. No injection,
 * no metrics row, no error: the feature simply does not exist there.
 *
 * `projectRootFor`'s own header records this same defect being fixed for the FILE
 * path: "wikiDir(cwd) keys the graph on where the client happens to be running.
 * That is wrong the moment a session touches a second repository ... Observed
 * live: work in another checkout recorded nothing." The command path kept the
 * behaviour that comment describes as wrong.
 *
 * Measured before fixing: a finding stored against a worktree, with a trigger
 * matching the command, produced NO injection and no metrics file at all when an
 * agent ran that command from a session rooted elsewhere. Calling `forCommand`
 * directly with the worktree's own graph injected it in 65 tokens, which is how
 * the lookup was identified as the culprit rather than the trigger.
 */

const CORE = (n) => pathToFileURL(join(process.cwd(), 'hooks-core', n)).href;

let session;
let other;
let wiki;

beforeEach(async () => {
  wiki = await import(CORE('wiki.mjs'));

  // Two separate "repositories", each with the marker projectRootFor looks for.
  session = mkdtempSync(join(tmpdir(), 'cmd-session-'));
  other = mkdtempSync(join(tmpdir(), 'cmd-other-'));
  for (const root of [session, other]) {
    mkdirSync(join(root, '.git'), { recursive: true });
    writeFileSync(join(root, 'package.json'), '{ "name": "x" }\n');
  }
});

afterEach(() => {
  for (const root of [session, other]) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('which graph a command consults', () => {
  it('resolves the project from a cd target, not the session directory', async () => {
    const { commandProjectRoot } = await import(CORE('decide.mjs'));

    const root = commandProjectRoot(
      { cwd: session, tool_input: { command: `cd ${other} && npm test` } },
      session
    );

    expect(root).toBe(wiki.projectRootFor(join(other, 'x'), other));
  });

  it('falls back to the session directory for an ordinary command', async () => {
    // Nothing else should change. A command with no `cd` still belongs to the
    // session's project, which is the case that works today.
    const { commandProjectRoot } = await import(CORE('decide.mjs'));

    const root = commandProjectRoot(
      { cwd: session, tool_input: { command: 'npm test' } },
      session
    );

    expect(root).toBe(wiki.projectRootFor(join(session, 'x'), session));
  });

  it('ignores a cd to somewhere that is not a directory', async () => {
    // `cd $UNSET_VAR && npm test` must not re-root the lookup onto nothing --
    // the same guard touchedFiles already applies when it re-bases operands.
    const { commandProjectRoot } = await import(CORE('decide.mjs'));

    const root = commandProjectRoot(
      {
        cwd: session,
        tool_input: { command: 'cd /nope/does/not/exist && npm test' },
      },
      session
    );

    expect(root).toBe(wiki.projectRootFor(join(session, 'x'), session));
  });
});
