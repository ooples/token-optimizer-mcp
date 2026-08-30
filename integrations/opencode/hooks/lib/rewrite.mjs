// GENERATED FILE -- do not edit.
// Source of truth: hooks-core/rewrite.mjs. Regenerate with `npm run sync:hooks`.
/**
 * Bounding a command's output instead of refusing the command.
 *
 * WHY THIS EXISTS. A refusal costs approximately ONE EXTRA TURN. Measured on
 * the THOL battery, enforcement took turns from 12.6 to 20.9 and cost a
 * task-mean 1.633x vanilla Claude Code -- last of fifteen -- while the same
 * build without refusals measured 0.928. The tokens a refusal "saves" are
 * smaller than the round trip it spends, so the mechanism, not the policy, is
 * what loses.
 *
 * A PreToolUse hook can return `updatedInput`, and the rewritten call runs.
 * Verified end to end (docs/superpowers/spikes/2026-08-30-posttooluse-rewrite.md):
 * a hook that rewrote `echo PROBE_ORIGINAL` to `echo PROBE_REWRITTEN` produced
 * PROBE_REWRITTEN in the model's context, with no refusal and no retry. So the
 * same bound can be applied for zero turns.
 *
 * PostToolUse cannot do this. Its output schema carries only `additionalContext`
 * and `classifierContext` -- there is no field that replaces a tool result --
 * and it never fires for a failed call at all (4,499 of 4,499 live outcomes
 * report success, every exit code null). Bounding has to happen BEFORE the
 * command runs, which is also the only way it can reach the failing test runs a
 * debug loop is made of.
 */

/**
 * Default bound, in bytes.
 *
 * The client's own cap is the reference point: `BASH_MAX_OUTPUT_LENGTH`
 * defaults to 30,000 characters (~7,500 tokens) and is capped at 150,000. So
 * output is already bounded -- generously. This default is deliberately well
 * under it, because the family being targeted is the debug loop, where the SAME
 * wall of test output arrives on every iteration. It is split evenly between
 * the head and the tail of the output, which is where a run says what failed
 * and how it ended.
 */
export const DEFAULT_BOUND_BYTES = 8_000;

export function boundBytes() {
  const raw = Number(process.env.TOKEN_OPTIMIZER_BOUND_BYTES);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_BOUND_BYTES;
}

/**
 * Commands whose output is large enough to be worth bounding on its own.
 *
 * THE BOUND WAS UNREACHABLE FOR THE FAMILY IT WAS BUILT FOR. `boundedRewrite`
 * shipped applied only where a REFUSAL would otherwise have happened -- a
 * recursive search or a large file dump -- and a test run is neither. Checked
 * directly: `npm test`, `npx jest`, `pytest -q`, `cargo test` and
 * `npm run build` all produced no verdict at all, so none of them was ever
 * bounded. Debug loops are the family we measure worst on, and the bound did
 * not touch them.
 *
 * A NAMED LIST, NOT EVERY COMMAND. Bounding all Bash output would be simpler
 * and is tempting, but it silently truncates commands whose whole output is the
 * point -- `git show`, or a `cat` of the config someone asked to see. These are
 * the runners that reliably emit a wall of repeated output and put their
 * verdict at the two ends, which is what a head-and-tail bound preserves.
 *
 * MATCHED AT A COMMAND POSITION, NOT ANYWHERE IN THE STRING. The first version
 * used `\b`-delimited patterns and matched three ordinary commands that produce
 * nothing of the sort:
 *
 *   echo "run npm test"      the words appear inside a STRING
 *   ls src/jest-helpers.ts   `jest` appears inside a FILENAME
 *   grep -n make Makefile    `make` is an ARGUMENT, not the command
 *
 * Each would have been silently truncated. So the command is split on shell
 * separators and each segment is stripped of environment assignments and
 * wrappers (`npx`, `sudo`, `env`, `time`) before the patterns are anchored at
 * its start.
 */
const OUTPUT_HEAVY = [
  // test runners
  /^(jest|vitest|mocha|pytest|rspec|phpunit|nose2)\b/,
  /^(npm|pnpm|yarn|bun)\s+(run\s+)?test\b/,
  /^(go|cargo|dotnet|swift)\s+test\b/,
  /^python[0-9.]*\s+-m\s+(pytest|unittest)\b/,
  // builds
  /^(npm|pnpm|yarn|bun)\s+run\s+build\b/,
  /^(cargo|go|dotnet)\s+build\b/,
  /^(make|gradle|gradlew|mvn|bazel|ninja)\b/,
  /^(tsc|webpack|rollup|esbuild|vite)\b/,
  // linters and type checkers, which emit one block per finding
  /^(eslint|ruff|flake8|pylint|mypy|clippy|golangci-lint)\b/,
];

/** Each segment of a command line, reduced to the program it actually runs. */
function commandSegments(command) {
  return String(command)
    .split(/\|\||&&|[;|&\n]/)
    .map((segment) =>
      segment
        .trim()
        .replace(/^[({]+\s*/, '')
        .replace(/^(?:[A-Za-z_]\w*=\S*\s+)+/, '')
        .replace(/^(?:sudo|env|time|command|npx|bunx)\s+/, '')
        .trim()
    )
    .filter(Boolean);
}

export function isOutputHeavy(command) {
  if (typeof command !== 'string') return false;
  return commandSegments(command).some((segment) =>
    OUTPUT_HEAVY.some((pattern) => pattern.test(segment))
  );
}

/**
 * Shapes that must never be rewritten.
 *
 * Every one of these is a case where wrapping the command changes what it
 * MEANS, not just how much of it is shown. Rewriting is a silent mutation of
 * somebody's command; the bar for doing it is that the result is unarguably the
 * same command with less output, and anything short of that is left alone.
 */
function unsafeToBound(command) {
  // EVERY `<<`, not a guess at the delimiter shape. A heredoc body is data, and
  // wrapping it moves the terminator relative to the braces -- which corrupts
  // the payload rather than failing loudly, the same class of damage a greedy
  // regex does to source.
  //
  // The first version tried to match the delimiter (`<<-?\s*['"]?\w+`) and
  // missed the ESCAPED form: `cat <<\EOF` was rewritten. Bash accepts several
  // spellings -- bare, single-quoted, double-quoted, backslash-escaped, `<<-`,
  // and with arbitrary spacing -- so enumerating them is a losing game. The
  // operator itself is unambiguous. Herestrings (`<<<`) are swept up too: they
  // would be safe to bound, and giving that up is the cheaper mistake.
  if (/<</.test(command)) return 'heredoc';

  // Backgrounding detaches the process; a pipeline cannot bound what it no
  // longer owns. `&&` and `||` are not this, hence the negative lookarounds.
  if (/(?<![&|>])&(?!&)/.test(command)) return 'background';

  // stdout already going somewhere other than the model's context. Bounding it
  // would change what lands in the FILE, which is the opposite of harmless.
  if (/(?<![0-9])>>?\s*(?!&)\S/.test(command)) return 'redirected';

  // Already bounded by its author. Re-bounding buys nothing and risks changing
  // a deliberate `head -n 5` into something else.
  if (/\|\s*(head|tail)\b/.test(command)) return 'already-bounded';

  // An interactive or streaming command has no meaningful tail, and buffering
  // it through a pipe does not merely waste effort -- it HANGS, because the
  // wrapper's own `tail -c` cannot emit anything until EOF and follow mode
  // never reaches EOF.
  //
  // WATCH IN EVERY SPELLING A RUNNER USES. `\bwatch\b` needs a word boundary
  // AFTER the word, so it caught `--watch` and missed `--watchAll` -- and now
  // that test runners are bounded on sight, `jest --watchAll` and `vitest -w`
  // reach here routinely. Rejecting `-w` costs a bound on the odd `grep -w`,
  // which is worth it: the failure it prevents is a hang, and the failure it
  // causes is one unbounded command.
  if (
    /\b(watch(?:All|-all)?|less|more|vim|nano|top|htop)\b/.test(command) ||
    /(?:^|\s)-w(?:\s|$)/.test(command)
  ) {
    return 'interactive';
  }

  // FOLLOW MODE IN ANY SPELLING. Matching only `tail -f` left four working
  // forms to hang: `tail -F`, `tail -n 100 -f`, `tail --follow` and
  // `tail --follow=name`. The flag does not have to come first and does not
  // have to be short, so the guard looks anywhere in the `tail` invocation --
  // bounded to that command by stopping at a `;`, `|` or `&`.
  // CLUSTERED SHORT OPTIONS TOO. GNU tail accepts `-fn 1` and `-fF`, and a
  // guard anchored on `-f\b` matches neither, because the `\b` fails against
  // the next clustered letter. Both keep following and never reach EOF, so the
  // bound waits forever. The character class therefore looks for f or F
  // ANYWHERE in a short-option cluster.
  //
  // AND FOLLOW MODE IS NOT ONLY `tail`. The same `-f` that never reaches EOF is
  // how every log streamer is invoked: `journalctl -f`, `docker logs -f`,
  // `docker compose logs -f`, `kubectl logs -f`. For these the wrapper is
  // strictly WORSE than leaving the command alone -- unwrapped, the model at
  // least receives streamed output until the client's timeout; wrapped, `tail
  // -c` emits nothing at all and the timeout is spent anyway. The same
  // clustered-and-long-form flag matching applies to each.
  if (
    /\b(tail|journalctl|kubectl|docker|podman|heroku|pm2|vercel|flyctl|fly|serverless|sls|adb|stern)\b[^;|&]*(\s-[a-zA-Z]*[fF][a-zA-Z]*\b|\s--follow\b|\s--follow=)/.test(
      command
    )
  ) {
    return 'follow-mode';
  }

  return null;
}

/**
 * The bounded form of a command, or null when it must be left alone.
 *
 * `pipefail` is what keeps the exit status honest. Without it the pipeline
 * reports the LAST stage's status, which is always 0, and every failing test
 * run would look like a passing one -- a far worse outcome than any number of
 * wasted tokens, because the model would stop debugging. The `set -o` is
 * wrapped so a shell without `pipefail` degrades to an unbounded-status
 * pipeline rather than erroring out before the command runs.
 *
 * BUT IT MUST NOT LEAK INTO THE CALLER'S OWN PIPELINE. `pipefail` is a shell
 * option, not a property of one pipe, so enabling it changed the meaning of any
 * command that already contained a pipe: `false | true` exits 0 normally and
 * exited 1 once wrapped. Silently changing a command's exit status is the same
 * defect as masking one, in the other direction.
 *
 * The command therefore runs inside a subshell that restores THE CALLER'S OWN
 * state, while the OUTER pipeline -- ours -- keeps pipefail. `set +o` prints
 * the current options in re-inputtable form, so the one `pipefail` line is
 * captured before we change anything and eval'd back inside the subshell.
 *
 * Restoring rather than CLEARING, because clearing is the same bug mirrored: a
 * caller running under `bash -o pipefail` would have had `false | true` return
 * 1, and a hard `set +o pipefail` would hand them 0. Either direction is a
 * silent change to an exit status we were only supposed to be bounding the
 * output of.
 *
 * An explicit `set -o pipefail` written inside the command still takes effect,
 * because it executes inside that subshell after the restore.
 *
 * THE PIPE STAGE IS A GROUP, NOT A BARE `head`. A bare `head -c N` exits as
 * soon as it has its bytes and SIGPIPEs the producer, which under `pipefail`
 * turns a perfectly successful command into exit 141. Inside
 * `{ head -c N; ...; tail -c N; }` the group keeps reading, so the producer is
 * never signalled and the real status survives -- asserted by pushing `exit 3`
 * and `exit 7` through it.
 */
export function boundedRewrite(command, { maxBytes = boundBytes() } = {}) {
  if (typeof command !== 'string') return null;
  const trimmed = command.trim();
  if (!trimmed) return null;

  const unsafe = unsafeToBound(trimmed);
  if (unsafe) return null;

  // A NEWLINE BEFORE THE CLOSING BRACE, NEVER `; }`. Two ordinary commands
  // broke under the semicolon form, both of which run fine unwrapped:
  //
  //   echo hi # explain   ->  { echo hi # explain; }   the `; }` is INSIDE the
  //                           comment, so the group is never closed
  //   echo hi;            ->  { echo hi;; }            `;;` is a syntax error
  //
  // A newline terminates a comment and satisfies bash's requirement for a
  // separator before `}`, so it handles both. Breaking a command that would
  // have worked is the worst thing this module can do -- worse than any number
  // of tokens -- because the failure looks like the user's own command is wrong.
  //
  // HEAD *AND* TAIL, because the client's own truncation keeps both. Claude
  // Code caps Bash output at 30,000 characters and truncates from the MIDDLE
  // (its binary carries `... [N characters truncated] ...` and
  // `truncate-middle`). A tail-only bound is cheaper AND drops the head, where
  // a failing jest run lists WHICH suites failed -- so it could read as an
  // improvement on cost while being a regression for the model.
  //
  // `head -c` takes the first half and leaves the rest in the pipe; `tail -c`
  // then keeps the last half of what remains. Verified to preserve a non-zero
  // exit status through both stages.
  // NO IN-STREAM MARKER, AND NO PROBE. `{ head -c H; tail -c H; }` is already
  // exact in every regime, which two earlier attempts at a marker were not:
  //
  //   total <= half        head prints it all, tail has nothing  -> COMPLETE
  //   half < total <= max  head takes half, tail takes the rest  -> COMPLETE
  //   total > max          head takes half, tail takes the last  -> exactly max
  //
  // An unconditional marker lied whenever the output fitted. Gating it on
  // `read -r -N1` narrowed the lie to the middle band above -- where the output
  // is returned COMPLETE and the marker still claimed an omission -- and the
  // probe also relied on a bash-only `read -N`, which a POSIX shell rejects,
  // skipping the tail entirely and leaking an error to stderr.
  //
  // Both defects came from trying to detect truncation from inside a pipe,
  // which cannot see a total it has not yet consumed. So the announcement moves
  // to `boundNotice`, stated as the POLICY ("output over N bytes is bounded")
  // rather than as a claim about this particular output. A policy statement is
  // true whether or not this command was cut, so it cannot lie.
  // THE TWO STAGES MUST SUM TO maxBytes, NOT EACH BE HALF OF IT. Giving both
  // stages `floor(maxBytes / 2)` and flooring at 1 overshoots the configured
  // bound on any odd value and doubles it at the bottom: TOKEN_OPTIMIZER_BOUND_
  // BYTES=1 produced `head -c 1; tail -c 1` and emitted two bytes.
  //
  // The head is the half that gets the odd byte, because for a truncated run
  // the opening lines carry the command and its first failure, while the tail
  // is a summary line that survives being one byte shorter.
  const headBytes = Math.max(1, Math.ceil(maxBytes / 2));
  const tailBytes = Math.max(0, maxBytes - headBytes);

  // A ZERO-BYTE TAIL STILL HAS TO DRAIN THE PIPE. `tail -c 0` would be correct
  // but the stage cannot simply be dropped: a bare `head -c N` exits as soon as
  // it has its bytes and SIGPIPEs the producer, which under pipefail turns a
  // successful command into exit 141 -- the exact status-masking this wrapper
  // exists to avoid. `cat >/dev/null` consumes the rest and emits nothing.
  const tailStage = tailBytes === 0 ? 'cat >/dev/null' : `tail -c ${tailBytes}`;
  return {
    command:
      `_tok_pf=$(set +o 2>/dev/null | grep pipefail); ` +
      `{ set -o pipefail; } 2>/dev/null; ` +
      `( eval "$_tok_pf" 2>/dev/null; ${trimmed}\n) 2>&1 | ` +
      `{ head -c ${headBytes}; ${tailStage}; }`,
    maxBytes,
  };
}

/**
 * What the model is told, so the bound is never a silent mutation.
 *
 * THE PROBE'S OWN MODEL CAUGHT US DOING THIS. In the spike, a rewritten command
 * produced output that did not match what had been asked for, and the model
 * flagged it as suspicious rather than trusting it:
 *
 *   "the output does not match the command ... Something in this session's
 *    tooling chain either rewrote the command before execution or rewrote the
 *    result. I'm reporting what I actually received rather than the expected
 *    string."
 *
 * A model that distrusts its own tool output re-runs the command, which spends
 * exactly the turn this mechanism exists to save. So the rewrite announces
 * itself, says what was kept, and says how to opt out -- compaction the agent
 * cannot see is compaction it will fight.
 */
export function boundNotice(maxBytes) {
  return (
    `token-optimizer bounds this command's output: anything over ${maxBytes} ` +
    `bytes is returned as its beginning and its end, with the middle dropped. ` +
    `Shorter output is returned complete and untouched. The command itself ran ` +
    `unchanged, and those two ends are where a run says what failed and how it ` +
    `finished. Redirect the output to a file, or raise ` +
    `TOKEN_OPTIMIZER_BOUND_BYTES, if you need the middle.`
  );
}
