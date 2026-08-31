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

/**
 * A run of `NAME=value ` prefixes at the start of a command.
 *
 * Anchored with `[^\\s=]*` rather than `\\S*` so the value cannot itself swallow
 * the `=` of the NEXT assignment. That ambiguity is what makes the repeated
 * group expensive: with `\\S*`, a string of `A=A=A=...` can be divided between
 * the repetitions an exponential number of ways.
 */
const ASSIGNMENT_PREFIX = /^(?:[A-Za-z_]\w*=[^\s]*\s+)+/;

/** Does this segment change the shell it runs in, rather than just run a program? */
function isStateMutating(segment) {
  const bare = segment.replace(/^(?:(?:builtin|command)\s+)+/, '');

  return (
    /^(?:cd|pushd|popd|export|source|alias|unalias|unset|umask|ulimit|set|shopt|declare|typeset|readonly|eval|exec|trap)(?:\s|$)/.test(
      bare
    ) ||
    /^\.\s/.test(bare) ||
    isAssignmentOnly(bare)
  );
}

/**
 * Splits `cd packages/api && npm test` into the part that must run in the
 * caller's own shell and the part worth bounding.
 *
 * WHY THIS EXISTS. Refusing every state-mutating command was correct and
 * expensive: `cd X && npm test` is one of the most common things an agent
 * writes, and it went through unbounded, which is precisely the debug output
 * this module exists to cap. The mutation and the noisy command are not the
 * same command -- they are two, joined by an operator -- and only the second
 * needs wrapping.
 *
 * ONLY A LEADING RUN, AND ONLY WHAT FOLLOWS IT IS BOUNDED. `npm test; cd ..`
 * has its mutation at the END, where hoisting cannot help without reordering
 * the command, so it stays refused. The prefix is reproduced VERBATIM, operators
 * included, so `cd x && ...` still runs the rest only if the cd succeeded and
 * `cd x || ...` still runs it only if the cd failed.
 */
function hoistablePrefix(command) {
  // Keep the separators: they carry the conditional meaning.
  const parts = command.split(/(\|\||&&|;|\n)/);

  let taken = 0;
  for (let i = 0; i < parts.length; i += 2) {
    const segment = parts[i].trim().replace(/^[({]+\s*/, '').trim();
    if (!segment) break;
    if (!isStateMutating(segment)) break;
    // A `(` opens a group the split cannot see the end of; leave it alone.
    if (/^[({]/.test(parts[i].trim())) return null;
    taken = i + 2;
  }

  if (!taken || taken >= parts.length) return null;

  const rest = parts.slice(taken).join('').trim();
  if (!rest) return null;

  // Whatever follows must be ordinary, or hoisting the front would leave a
  // mutation inside the subshell after all.
  if (splitSegments(rest).some(isStateMutating)) return null;

  return { prefix: parts.slice(0, taken).join('').trim(), rest };
}

/**
 * Is this segment nothing but variable assignments?
 *
 * WRITTEN AS A SPLIT RATHER THAN A REGEX. The regex form was
 * `/^(?:[A-Za-z_]\w*=\S*\s*)+$/`, and CodeQL flagged it as able to backtrack
 * exponentially on `A=A=A=...`, because `\S*` can itself match `=` and leave the
 * repetitions an exponential number of ways to divide the string.
 *
 * No input was found that actually makes V8 take measurable time, so this is a
 * theoretical hazard rather than a demonstrated hang -- but the guard runs on
 * every Bash call, the shape that reaches it is an ordinary-looking assignment
 * list, and the linear form is the clearer code anyway.
 *
 * Splitting on whitespace first makes it linear: each token is checked once, and
 * a token cannot contain whitespace by construction, so the trailing `\S*` the
 * regex needed is implicit.
 */
function isAssignmentOnly(segment) {
  const tokens = segment.split(/\s+/).filter(Boolean);
  return tokens.length > 0 && tokens.every((token) => /^[A-Za-z_]\w*=/.test(token));
}

/** Each segment of a command line, as written. */
function splitSegments(command) {
  return String(command)
    .split(/\|\||&&|[;|&\n]/)
    .map((segment) => segment.trim().replace(/^[({]+\s*/, '').trim())
    .filter(Boolean);
}

/** Each segment of a command line, reduced to the program it actually runs. */
function commandSegments(command) {
  return splitSegments(command)
    .map((segment) =>
      segment
        .replace(ASSIGNMENT_PREFIX, '')
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

  // A SUBSHELL CANNOT CHANGE ITS PARENT. The wrapper runs the command inside
  // `( ... )` so that restoring the caller's `pipefail` stays local -- but that
  // same containment silently discards any state the command existed to set.
  // `cd packages/api && npm test` is the common one and the worst: this client's
  // Bash tool PERSISTS the working directory between calls, so bounding it
  // leaves the next command running in the old directory, with nothing to
  // suggest why. `export`, a bare `FOO=1`, and `source venv/bin/activate` fail
  // the same way in clients whose shell persists more than the cwd.
  //
  // `set` AND `shopt` BELONG HERE TOO, which was not the first judgement. The
  // reasoning then was that their scope is the command they precede, which runs
  // in the same subshell -- true, and beside the point: unbounded, `set -e` also
  // outlives that command and applies to the caller's LATER calls, and bounded
  // it does not. Whether anyone relies on that depends on how persistent a given
  // client's shell is, and this module ships to eleven of them, so the safe
  // reading is the one that does not silently differ.
  //
  // The cost is real -- `set -euo pipefail; npm test` is a common prefix and now
  // goes unbounded. Hoisting a leading mutating segment out of the wrapper would
  // recover it, and is the same follow-up the `cd` case wants.
  //
  // `CI=1 npm test` stays bounded: an assignment attached to a command never
  // outlived that command anyway. Only a segment that is assignments ALONE is a
  // shell mutation.
  // `builtin` AND `command` ARE STRIPPED FIRST. Both take a builtin and run it
  // in the current shell, so `builtin cd packages/api && npm test` and
  // `command cd packages/api && npm test` change the caller's directory exactly
  // as a bare `cd` does -- while sailing past a guard anchored on the word.
  // (`env cd` and `sudo cd` are not the same: those run an external program, so
  // there is no `cd` to lose.)
  if (splitSegments(command).some(isStateMutating)) {
    return 'state-mutating';
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
export function boundedRewrite(
  command,
  { maxBytes = boundBytes(), compactor = null } = {}
) {
  if (typeof command !== 'string') return null;
  const trimmed = command.trim();
  if (!trimmed) return null;

  // A COMMAND THAT ONLY *STARTS* BY CHANGING THE SHELL IS STILL WORTH BOUNDING.
  // `cd packages/api && npm test` is two commands; the cd has to run in the
  // caller's shell to persist, and the test run is exactly what we came for.
  // Hoisting the front out of the wrapper keeps both.
  const hoist = hoistablePrefix(trimmed);
  const subject = hoist ? hoist.rest : trimmed;

  const unsafe = unsafeToBound(subject);
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
  // ASK FOR NO COLOUR, RATHER THAN STRIPPING IT AFTERWARDS.
  //
  // Colour is not a rounding error and it does not go away on its own. Measured
  // on a failing `jest tests/hooks/redact.test.mjs`, with the command IDENTICAL
  // and only the invocation shape differing: a direct node spawn, a plain bash
  // pipe, and this bounded wrapper each carried 348 ANSI sequences. The
  // convention that a tool drops colour when stdout is not a terminal does not
  // hold here -- jest emits it into a pipe -- so the bytes are real in
  // production, and a model gains nothing from any of them.
  //
  // `NO_COLOR=1` and `FORCE_COLOR=0` each removed all 348: 7,301 bytes -> 5,575,
  // a 23.6% cut, with the failing exit status intact. `TERM=dumb` changed
  // nothing.
  //
  // AT THE SOURCE, NOT THROUGH A FILTER, for three reasons. The bytes then never
  // exist, so the byte budget below holds real text instead of escape codes --
  // a filter after the bound would spend the budget on them first. There is no
  // extra process and no regex to get wrong on unusual output. And the obvious
  // filter is actively dangerous: `... | sed 's/<esc>\[[0-9;]*[a-zA-Z]//g'`
  // measured the same byte saving but reported EXIT 0 for a run that failed with
  // 1 -- exactly the status masking this wrapper exists to prevent.
  //
  // Exported inside the subshell, so it reaches the command's children and dies
  // with the subshell -- checked: after a bounded command the caller's own shell
  // still shows both variables unset.
  //
  // A DEFAULT, NOT AN OVERRIDE. Setting them outright would also take colour
  // away from someone who had deliberately put `FORCE_COLOR=1` in their own
  // environment, which is a silent change to something they asked for. `:-`
  // fills in only when the variable is unset or empty, and in the client this
  // was measured in, both are unset (with TERM=xterm-256color, which is why the
  // colour is there at all) -- so the saving is collected in the ordinary case
  // and the deliberate case is left alone. A command-level
  // `FORCE_COLOR=1 npm test` wins over either, since an assignment attached to
  // a command outranks the exported environment.
  const NO_COLOUR =
    'export NO_COLOR="${NO_COLOR:-1}" FORCE_COLOR="${FORCE_COLOR:-0}";';

  // THE COMMAND GOES IN AS A LITERAL, NOT AS SHELL TEXT.
  //
  // Interpolating it between our subshell delimiters let it CLOSE them: with
  // `echo one ); echo INJECTED; ( echo two`, bash rejects the command outright
  // when it is run on its own -- a syntax error, exit 2, no output -- while the
  // bounded form completed successfully and ran the middle command. Turning a
  // command the shell refuses into one that runs is the most serious thing this
  // wrapper could do, and it is a change in meaning even when nothing hostile
  // is intended.
  //
  // Single-quoting and handing it to `eval` closes that off: the shell sees one
  // word, our structure is fixed before the command is looked at, and the
  // command is then parsed exactly as it would have been on its own. Every
  // legitimate shape that contains a paren keeps working, and those were the
  // reason not to simply ban the character -- `case a in a) ...;; esac`, a
  // function definition, a quoted `"a (b)"`, and the author's own `( ... )` all
  // behave identically bounded and unbounded.
  //
  // The escape is the standard one: end the quoted run, add an escaped quote,
  // start a new run.
  const quoted = `'${subject.split("'").join("'\\''")}'`;

  // THE FINAL STAGE: EITHER THE SHELL'S OWN head+tail, OR THE COMPACTOR.
  //
  // `compactAgainstPreviousRun` swaps `{ head; tail; }` for a node stage that
  // does the same bounding AND drops lines this command already printed on its
  // previous run in this session. It is opt-in: without it the wrapper is
  // byte-for-byte what it was, so nothing that depends on the shell form
  // changes.
  //
  // THE INTERPRETER IS NAMED BY ABSOLUTE PATH, never as bare `node`. If `node`
  // were not on the PATH of the shell the command runs in, the stage would
  // print nothing and the model would receive an EMPTY result -- losing the
  // command's output entirely, which is far worse than failing to bound it.
  // `process.execPath` is the interpreter already running this code, so it
  // exists by construction.
  //
  // Forward slashes and quotes, because these paths are absolute and on Windows
  // contain both backslashes and spaces.
  const shellPath = (value) => `"${String(value).split('\\').join('/')}"`;
  const stage = compactor
    ? `${shellPath(compactor.node)} ${shellPath(compactor.helper)} ` +
      `${shellPath(compactor.previous)} ${maxBytes}`
    : `{ head -c ${headBytes}; ${tailStage}; }`;

  // AND ALL OF IT INSIDE ONE OUTER SUBSHELL, so nothing survives the command.
  //
  // The pipefail dance above was written at the CALLER'S level, which fixed the
  // leak into the command and created the mirror of it on the other side: after
  // a bounded command the caller's shell was left with `pipefail` ON and
  // `_tok_pf` still defined. In a persistent shell that changes the meaning of
  // everything the user runs NEXT -- verified: following a bounded command,
  // `false | true` exited 1 where it had exited 0. Silently changing an exit
  // status is the defect this wrapper exists to avoid, and doing it to later
  // commands is no better than doing it to this one.
  //
  // Wrapping the whole construction makes both the variable and the option
  // local to a shell that ends with the command. The exit status still comes
  // out intact, because a subshell reports the status of the last thing in it,
  // which is our pipeline.
  // The hoisted prefix runs first, in the caller's own shell, exactly as written.
  const lead = hoist ? `${hoist.prefix} ` : '';

  return {
    command:
      `${lead}( _tok_pf=$(set +o 2>/dev/null | grep pipefail); ` +
      `{ set -o pipefail; } 2>/dev/null; ` +
      `( eval "$_tok_pf" 2>/dev/null; ${NO_COLOUR} eval ${quoted}\n) 2>&1 | ` +
      `${stage} )`,
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
