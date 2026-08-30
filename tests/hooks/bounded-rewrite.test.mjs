/**
 * Bounding a command's output instead of refusing the command.
 *
 * THE ASSERTIONS RUN THE REWRITTEN COMMANDS. A rewrite is a silent mutation of
 * somebody's command, so the only assertion worth making is that the rewritten
 * form still MEANS the same thing -- same stdout content at the tail, same exit
 * status, stderr still captured. Pattern-matching the generated string would
 * pass just as well for a rewrite that breaks every command it touches.
 */
import { describe, it, expect, afterAll } from '@jest/globals';
import { execFileSync, spawnSync } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import {
  boundedRewrite,
  boundNotice,
  isOutputHeavy,
  DEFAULT_BOUND_BYTES,
} from '../../hooks-core/rewrite.mjs';

/** Runs a command through bash exactly as the client's Bash tool would. */
function run(command, shellFlags = []) {
  try {
    const stdout = execFileSync('bash', [...shellFlags, '-c', command], {
      encoding: 'utf8',
      timeout: 30_000,
    });
    return { stdout, status: 0 };
  } catch (error) {
    return {
      stdout: String(error.stdout ?? ''),
      status: typeof error.status === 'number' ? error.status : -1,
    };
  }
}

describe('the rewritten command still means what it meant', () => {
  it('keeps a successful command successful, and its output intact', () => {
    const original = run('echo hello');
    const { command } = boundedRewrite('echo hello');

    const bounded = run(command);

    expect(original.status).toBe(0);
    expect(bounded.status).toBe(0);
    expect(bounded.stdout.trim()).toBe('hello');
  });

  it('PRESERVES A NON-ZERO EXIT, which is the whole reason pipefail is there', () => {
    // Without `set -o pipefail` the pipeline reports tail's status -- always 0 --
    // and every failing test run would read as a passing one. That is far worse
    // than any wasted tokens: the model would simply stop debugging.
    const original = run('echo boom; exit 3');
    expect(original.status).toBe(3);

    const { command } = boundedRewrite('echo boom; exit 3');
    const bounded = run(command);

    expect(bounded.status).toBe(3);
    expect(bounded.stdout).toContain('boom');
  });

  it.each([
    ['false | true', 0],
    ['true | false', 1],
    ['echo a | grep -q a', 0],
  ])('leaves %s exiting %i, as it does unwrapped', (command, expected) => {
    // `pipefail` is a SHELL option, not a property of one pipe, so enabling it
    // changed the meaning of any command that already contained a pipe:
    // `false | true` exits 0 normally and exited 1 once wrapped. Silently
    // changing a command's exit status is the same defect as masking one, just
    // in the other direction.
    expect(run(command).status).toBe(expected);
    expect(run(boundedRewrite(command).command).status).toBe(expected);
  });

  it('preserves the pipefail state the CALLER was already running under', () => {
    // The mirror of the leak above, and just as wrong. Under `bash -o pipefail`
    // a caller's `false | true` returns 1; hard-clearing the option inside the
    // subshell would hand them 0. Either direction is a silent change to an
    // exit status we were only supposed to be bounding the output of.
    const command = 'false | true';
    const underPipefail = (c) =>
      run(c, ['-o', 'pipefail']).status;

    expect(underPipefail(command)).toBe(1);
    expect(underPipefail(boundedRewrite(command).command)).toBe(1);
  });

  it('still honours a pipefail the caller asked for themselves', () => {
    // The reset must not override an explicit intent: the caller's `set -o`
    // runs inside the subshell, after ours is undone.
    const command = 'set -o pipefail; false | true';

    expect(run(command).status).toBe(1);
    expect(run(boundedRewrite(command).command).status).toBe(1);
  });

  it('captures stderr, where a failing build says what went wrong', () => {
    const { command } = boundedRewrite('echo to-stderr 1>&2; exit 1');

    const bounded = run(command);

    expect(bounded.stdout).toContain('to-stderr');
    expect(bounded.status).toBe(1);
  });

  it('keeps BOTH ENDS, because the client itself truncates from the middle', () => {
    // Claude Code caps Bash output at 30,000 characters and cuts the MIDDLE,
    // keeping head and tail. A tail-only bound would be cheaper AND lose the
    // head -- where a failing jest run lists WHICH suites failed -- so it could
    // read as a cost win while being a regression for the model.
    const { command } = boundedRewrite('seq 1 2000', { maxBytes: 60 });

    const bounded = run(command);

    expect(bounded.stdout.startsWith('1\n2\n3')).toBe(true);
    expect(bounded.stdout.trimEnd().endsWith('2000')).toBe(true);
    expect(Buffer.byteLength(bounded.stdout, 'utf8')).toBeLessThanOrEqual(60);
  });

  it.each([
    ['well under the bound', 'printf abcdefghij', 10],
    ['between half and the bound', 'printf %.0sx $(seq 1 30)', 30],
  ])('returns output %s COMPLETE and untouched', (_why, command, expected) => {
    // The middle band is the one two earlier marker attempts got wrong. An
    // unconditional marker lied about every output that fitted; gating it on a
    // one-byte probe narrowed the lie to exactly this band, where head takes
    // its half and tail takes the whole remainder -- so nothing is dropped and
    // an omission was still announced.
    const { command: bounded } = boundedRewrite(command, { maxBytes: 40 });

    const plain = run(command);
    const result = run(bounded);

    expect(plain.stdout.length).toBe(expected);
    expect(result.stdout).toBe(plain.stdout);
  });

  it.each([
    ['a trailing comment', 'echo hi # explain'],
    ['a trailing semicolon', 'echo hi;'],
  ])('does not BREAK a working command ending in %s', (_why, command) => {
    // Both of these ran fine unwrapped and were syntax errors under the first
    // implementation, which closed the group with `; }`:
    //   echo hi # explain  ->  { echo hi # explain; }   `; }` is inside the
    //                          comment, so the group never closes
    //   echo hi;           ->  { echo hi;; }            `;;` is a syntax error
    // Breaking a command that would have worked is the worst thing this module
    // can do: the failure looks like the user's own command is at fault.
    const original = run(command);
    const bounded = run(boundedRewrite(command).command);

    expect(original.status).toBe(0);
    expect(bounded.status).toBe(0);
    expect(bounded.stdout).toContain('hi');
  });

  it('leaves output shorter than the bound completely untouched', () => {
    const { command } = boundedRewrite('echo short', { maxBytes: 8000 });

    const bounded = run(command);

    expect(bounded.stdout.trim()).toBe('short');
    // AND CLAIMS NOTHING. Nothing is injected into output that fitted, so the
    // model is never sent looking for a middle that does not exist -- which
    // would cost the turn this module exists to save.
    expect(bounded.stdout).not.toContain('omitted');
    expect(bounded.stdout).not.toContain('token-optimizer');
  });

  it('bounds a compound command as one unit, not just its last part', () => {
    // `{ a; b; } | tail` and `a; b | tail` are different commands. The braces
    // are what make the bound apply to everything the call produces.
    const { command } = boundedRewrite('seq 1 100; echo LAST', { maxBytes: 60 });

    const bounded = run(command);

    // `LAST` is produced by the SECOND command in the group; seeing it proves
    // the bound wrapped the whole call rather than only its last part.
    expect(bounded.stdout).toContain('LAST');
    // Bounded, not unbounded: the full sequence is ~292 bytes.
    expect(Buffer.byteLength(bounded.stdout, 'utf8')).toBeLessThan(200);
  });
});

describe('commands it refuses to touch', () => {
  // Each of these is a case where wrapping changes what the command MEANS.
  // Returning null leaves the call exactly as the author wrote it.
  it.each([
    ['a heredoc, whose body is data', "cat <<'EOF'\nhello\nEOF"],
    // Bash spells the delimiter several ways, and the first guard matched the
    // DELIMITER rather than the operator -- so the escaped form slipped past it
    // and was rewritten. Every one of these must be refused.
    ['an escaped heredoc delimiter', 'cat <<' + String.fromCharCode(92) + 'EOF\nx\nEOF'],
    ['a double-quoted delimiter', 'cat <<"EOF"\nx\nEOF'],
    ['a dash heredoc', 'cat <<-EOF\nx\nEOF'],
    ['a herestring', 'cat <<< "hello"'],
    ['a backgrounded process it no longer owns', 'npm run dev &'],
    ['output already redirected to a file', 'npm test > out.log'],
    ['an author-supplied bound', 'npm test | head -n 20'],
        ['a streaming or interactive command', 'tail -f server.log'],
    // Follow mode does not merely waste effort, it HANGS: the wrapper's own
    // `tail -c` cannot emit until EOF and follow mode never reaches EOF. The
    // flag need not come first and need not be short, and matching only
    // `tail -f` left all four of these to hang.
    ['tail -F', 'tail -F server.log'],
    ['a follow flag that is not first', 'tail -n 100 -f server.log'],
    ['the long follow flag', 'tail --follow server.log'],
    ['the long follow flag with a value', 'tail --follow=name server.log'],
    // Clustered short options: GNU tail accepts both, and a guard anchored on
    // `-f\b` matches neither because the word boundary fails against the next
    // letter in the cluster.
    ['a clustered follow flag', 'tail -fn 1 server.log'],
    ['two clustered follow flags', 'tail -fF server.log'],
  ])('leaves %s alone', (_why, command) => {
    expect(boundedRewrite(command)).toBeNull();
  });

  it.each([
    ['tail -n 5 build.log'],
    ['tail -c 100 build.log'],
  ])('still bounds %s, which is not follow mode', (command) => {
    // Guards against over-correction: the follow-mode check must not swallow
    // every use of `tail`, or an ordinary bounded read stops being bounded.
    expect(boundedRewrite(command)).not.toBeNull();
  });

  it('still bounds a command containing && and ||, which are not backgrounding', () => {
    // The backgrounding guard must not swallow ordinary control operators.
    // Harmless operands on purpose: an earlier version used a real
    // `npm run build && npm test`, and the test DID run them and timed out.
    const rewritten = boundedRewrite('true && false || echo failed');

    expect(rewritten).not.toBeNull();
    expect(run(rewritten.command).stdout).toContain('failed');
  });

  it('does not bound an empty or non-string command', () => {
    expect(boundedRewrite('   ')).toBeNull();
    expect(boundedRewrite(undefined)).toBeNull();
  });
});

describe('the bound announces itself', () => {
  it('names the limit and a way out, because a silent rewrite gets distrusted', () => {
    // The spike's model noticed an unannounced rewrite and reported the output
    // as suspect rather than using it. A model that distrusts its output
    // re-runs the command, spending the turn this mechanism exists to save.
    const notice = boundNotice(DEFAULT_BOUND_BYTES);

    expect(notice).toContain(String(DEFAULT_BOUND_BYTES));
    expect(notice).toMatch(/TOKEN_OPTIMIZER_BOUND_BYTES/);
    // BOTH ends, not just the tail.
    expect(notice).toMatch(/beginning and its end/);
    // Stated as the POLICY, not as a claim about this particular output --
    // which is what lets it be true whether or not this command was cut.
    expect(notice).toMatch(/Shorter output is returned complete/);
  });
});


/* ------------------------------------------------------------------ *
 * The real router, end to end
 * ------------------------------------------------------------------ */

const HERE = dirname(fileURLToPath(import.meta.url));
const ROUTER = join(HERE, '..', '..', 'plugin', 'hooks', 'pretooluse-router.mjs');

/** An empty graph, so no stored finding can influence the decision. */
const GRAPH = mkdtempSync(join(tmpdir(), 'bounded-graph-'));

afterAll(() => {
  try {
    rmSync(GRAPH, { recursive: true, force: true });
  } catch {
    /* windows can hold a handle briefly */
  }
});

/** Drives the shipped router exactly as the client does. */
function router(payload, env = {}) {
  const result = spawnSync(process.execPath, [ROUTER], {
    input: JSON.stringify({ session_id: 's-bound', cwd: process.cwd(), ...payload }),
    encoding: 'utf8',
    env: {
      ...process.env,
      TOKEN_OPTIMIZER_MCP_CAPABILITIES:
        'smart_read,smart_write,smart_edit,smart_glob,smart_grep,wiki_write',
      TOKEN_OPTIMIZER_WIKI_DIR: GRAPH,
      TOKEN_OPTIMIZER_SHARED_DIR: GRAPH,
      ...env,
    },
  });
  // A CRASH IS NOT AN ALLOW. A router that dies before it writes anything
  // produces exactly the empty stdout a silent allow produces, so without this
  // every "leaves it alone" assertion below would pass against a router that
  // never started. This is not hypothetical: a stray escape in the router's
  // source turned it into a SyntaxError, and the only reason it was caught was
  // that a different check read stderr.
  if (result.status !== 0) {
    throw new Error(
      `router exited ${result.status}: ${result.stderr.trim().slice(0, 400)}`
    );
  }

  // A silent allow emits nothing at all. Spelled out with the same shape as
  // the parsed path so a caller cannot tell them apart by accident.
  if (!result.stdout.trim()) {
    return { decision: 'allow', reason: '', context: '', updatedInput: null };
  }
  const out = JSON.parse(result.stdout).hookSpecificOutput || {};
  return {
    decision: out.permissionDecision || (out.additionalContext ? 'advise' : 'allow'),
    reason: out.permissionDecisionReason || '',
    context: out.additionalContext || '',
    updatedInput: out.updatedInput || null,
  };
}

describe('the shipped router bounds instead of refusing', () => {
  const SEARCH = { tool_name: 'Bash', tool_input: { command: 'grep -rn needle .' } };

  it('allows a recursive search WITH a rewritten command, where it used to deny', () => {
    // The whole point of the change: this exact call was a refusal, and a
    // refusal costs about one turn. Now it runs, bounded, for zero.
    const r = router(SEARCH, { TOKEN_OPTIMIZER_MODE: 'enforce' });

    expect(r.decision).toBe('allow');
    expect(r.updatedInput).not.toBeNull();
    expect(r.updatedInput.command).toContain('grep -rn needle .');
    expect(r.updatedInput.command).toContain('tail -c');
  });

  it('tells the model what it did, so the rewrite is not silent', () => {
    const r = router(SEARCH, { TOKEN_OPTIMIZER_MODE: 'enforce' });

    expect(r.context).toMatch(/bounds this command/i);
    expect(r.context).toContain('TOKEN_OPTIMIZER_BOUND_BYTES');
  });

  it('leaves the command alone in assist, which was already letting it through', () => {
    // Bounding here would be a NEW behaviour, not a cheaper spelling of an old
    // one -- assist's contract is that the call proceeds untouched.
    const r = router(SEARCH, { TOKEN_OPTIMIZER_MODE: 'assist' });

    expect(r.updatedInput).toBeNull();
    expect(r.decision).toBe('allow');
  });

  it('keeps the verdict\'s own guidance when it bounds instead of refusing', () => {
    // Bounding instead of refusing must not cost the guidance the refusal would
    // have carried. The reason names the optimizer tool that makes the NEXT
    // call cheaper; dropping it leaves a byte notice that teaches nothing, and
    // the model repeats the expensive call it was being steered away from.
    const r = router(
      { tool_name: 'Bash', tool_input: { command: 'grep -rn foo .' } },
      { TOKEN_OPTIMIZER_MODE: 'enforce' }
    );

    expect(r.updatedInput.command).toContain('head -c');
    expect(r.context).toContain('smart_grep');
    expect(r.context).toContain('bounds this command');
  });

  it.each([['enforce'], ['assist']])(
    'bounds a test run in %s, where nothing was going to refuse it',
    (mode) => {
      // THE DEBUG-LOOP PATH. A test run produces no verdict, so it used to
      // reach the end of the router unbounded -- the bound only ran where a
      // refusal would otherwise have happened.
      //
      // assist is included deliberately: a bound is not a refusal, it costs no
      // turn, and gating it on enforcement would mean the posture we intend to
      // ship got none of the win it exists for.
      const r = router(
        { tool_name: 'Bash', tool_input: { command: 'npm test' } },
        { TOKEN_OPTIMIZER_MODE: mode }
      );

      expect(r.decision).toBe('allow');
      expect(r.updatedInput.command).toContain('npm test');
      expect(r.updatedInput.command).toContain('head -c');
    }
  );

  it('leaves a test run alone when the optimizer is off', () => {
    const r = router(
      { tool_name: 'Bash', tool_input: { command: 'npm test' } },
      { TOKEN_OPTIMIZER_MODE: 'off' }
    );

    expect(r.updatedInput).toBeNull();
  });

  it('does not rewrite a command it cannot bound safely', () => {
    // A heredoc body is data; wrapping it in braces moves the terminator. The
    // router must fall back to its previous behaviour rather than mangle it.
    const r = router(
      {
        tool_name: 'Bash',
        tool_input: { command: "grep -rn needle . <<'EOF'\nbody\nEOF" },
      },
      { TOKEN_OPTIMIZER_MODE: 'enforce' }
    );

    expect(r.updatedInput).toBeNull();
  });
});


describe('commands whose point is to change the shell itself', () => {
  // The wrapper runs the command in `( ... )` so the pipefail restore stays
  // local, and that same containment discards whatever the command meant to
  // set. This client's Bash tool persists the working directory between calls,
  // so a bounded `cd` leaves the NEXT command in the old directory with nothing
  // to explain it.
  it.each([
    ['cd packages/api && npm test'],
    ['npm test; cd ..'],
    ['pushd src && make'],
    ['export FOO=1; npm test'],
    ['source venv/bin/activate && pytest -q'],
    ['. venv/bin/activate && pytest'],
    ['FOO=1'],
  ])('refuses to bound %s', (command) => {
    expect(boundedRewrite(command)).toBeNull();
  });

  it.each([
    // `set` and `shopt` scope to the command they precede, which runs inside
    // the same subshell -- a bound changes nothing about them.
    ['set -euo pipefail; npm test'],
    ['shopt -s globstar; npx jest'],
    // An assignment ATTACHED to a command never outlived that command anyway.
    ['CI=1 npm test'],
    // And the words must be matched as commands, not found anywhere: these two
    // contain `cd` and `export` and mutate nothing.
    ['make cdrom'],
    ['grep -n export src/a.ts'],
  ])('still bounds %s', (command) => {
    expect(boundedRewrite(command)).not.toBeNull();
  });
});

describe('the configured bound is the bound', () => {
  // Both stages used to get floor(maxBytes / 2) with a floor of 1, which
  // overshoots on any odd value and DOUBLES it at the bottom: a configured
  // bound of 1 byte emitted two.
  it.each([[1], [2], [3], [7], [100], [101], [8000]])(
    'emits at most %i bytes when %i is configured',
    (maxBytes) => {
      const producer = 'for i in $(seq 1 3000); do echo "line $i"; done';
      const bounded = boundedRewrite(producer, { maxBytes });

      const out = run(bounded.command);

      expect(out.stdout.length).toBeLessThanOrEqual(maxBytes);
    }
  );

  it('keeps the exit status when the tail stage has no bytes to take', () => {
    // A zero-byte tail cannot simply be dropped. A bare `head -c N` exits as
    // soon as it has its bytes and SIGPIPEs the producer, which under pipefail
    // reports 141 -- the status-masking this wrapper exists to avoid.
    const bounded = boundedRewrite('exit 3', { maxBytes: 1 });

    expect(run(bounded.command).status).toBe(3);
  });
});

describe('follow mode in commands that are not tail', () => {
  // For a streamer the wrapper is strictly WORSE than no wrapper: unwrapped the
  // model receives output until the client timeout, wrapped it receives nothing
  // and the timeout is spent anyway.
  it.each([
    ['journalctl -f'],
    ['journalctl --follow -u nginx'],
    ['docker logs -f web'],
    ['docker compose logs -f'],
    ['kubectl logs -f pod/api'],
    ['kubectl logs --follow deploy/api'],
    ['pm2 logs -f'],
    ['adb logcat -f'],
  ])('refuses to bound %s', (command) => {
    expect(boundedRewrite(command)).toBeNull();
  });

  it.each([
    // The same programs without the follow flag terminate, so they keep the bound.
    ['docker logs web'],
    ['kubectl logs pod/api'],
    ['journalctl -u nginx -n 500'],
  ])('still bounds %s', (command) => {
    expect(boundedRewrite(command)).not.toBeNull();
  });
});

describe('watch mode, which a bound would turn into a hang', () => {
  // A word-boundary pattern needs a word boundary AFTER the word, so it caught --watch and
  // missed --watchAll. That was harmless while only would-be refusals were
  // bounded; now that test runners are bounded on sight, a watch run reaches
  // the bound routinely, and `tail -c` cannot emit until an EOF that never comes.
  it.each([
    ['npm test -- --watch'],
    ['npx jest --watchAll'],
    ['npx jest --watch-all'],
    ['vitest -w'],
    ['vitest watch'],
  ])('refuses to bound %s', (command) => {
    expect(boundedRewrite(command)).toBeNull();
  });

  it.each([
    ['npm test -- -i'],
    ['vitest run'],
    // `watcher` is not `watch`: widening the guard must not cost the bound on
    // an ordinary run that merely names a file.
    ['npm test src/watcher.test.ts'],
  ])('still bounds %s', (command) => {
    expect(boundedRewrite(command)).not.toBeNull();
  });
});

describe('which commands are worth bounding at all', () => {
  // The bound shipped applied only where a REFUSAL would otherwise have
  // happened, and a test run is never refused -- so the family it was built for
  // never reached it. These are the runners that reach it now.
  it.each([
    ['npm test'],
    ['npx jest tests/hooks'],
    ['pytest -q'],
    ['cargo test'],
    ['go test ./...'],
    ['dotnet test'],
    ['npm run build'],
    ['make'],
    ['tsc --noEmit'],
    ['eslint src'],
    ['CI=1 npm test'],
    ['npm run build && npm test'],
    ['sudo make install'],
  ])('bounds %s', (command) => {
    expect(isOutputHeavy(command)).toBe(true);
  });

  it.each([
    ['git status'],
    ['cat README.md'],
    ['git show HEAD'],
    ['git log --oneline'],
    // THE THREE THAT A `\b` PATTERN GOT WRONG, and each would have been
    // silently truncated: the words appear in a string, in a filename, and as
    // an argument -- never as the command being run.
    ['echo "run npm test"'],
    ['ls src/jest-helpers.ts'],
    ['grep -n make Makefile'],
    ['cat Makefile'],
  ])('leaves %s alone', (command) => {
    expect(isOutputHeavy(command)).toBe(false);
  });
});
