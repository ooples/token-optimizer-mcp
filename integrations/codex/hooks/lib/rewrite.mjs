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
 * wall of test output arrives on every iteration and the tail is the part that
 * says what failed.
 */
export const DEFAULT_BOUND_BYTES = 8_000;

export function boundBytes() {
  const raw = Number(process.env.TOKEN_OPTIMIZER_BOUND_BYTES);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_BOUND_BYTES;
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
  // A heredoc body is data, and `{ cmd <<'EOF' ; }` moves the terminator
  // relative to the braces. Getting this wrong corrupts the payload rather than
  // failing loudly -- the same class of damage a greedy regex does to source.
  if (/<<-?\s*['"]?\w+/.test(command)) return 'heredoc';

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
  // it through a pipe can hang.
  if (/\b(watch|tail\s+-f|less|more|vim|nano|top|htop)\b/.test(command)) {
    return 'interactive';
  }

  return null;
}

/**
 * The bounded form of a command, or null when it must be left alone.
 *
 * `tail`, NOT `head`, and that choice is load-bearing twice over. A test run
 * puts its verdict at the END -- the failure summary, the counts -- so the tail
 * is the part worth keeping. And `head` closes the pipe early, which sends
 * SIGPIPE to the producer: under `pipefail` a perfectly successful search would
 * then report exit 141 and read as a failure. `tail` consumes its input, so the
 * real exit status survives.
 *
 * `pipefail` itself is what keeps the exit status honest. Without it the
 * pipeline reports `tail`'s status, which is always 0, and every failing test
 * run would look like a passing one -- a far worse outcome than any number of
 * wasted tokens, because the model would stop debugging.
 *
 * The `set -o` is wrapped so a shell without `pipefail` degrades to an
 * unbounded-status pipeline rather than erroring out before the command runs.
 */
export function boundedRewrite(command, { maxBytes = boundBytes() } = {}) {
  if (typeof command !== 'string') return null;
  const trimmed = command.trim();
  if (!trimmed) return null;

  const unsafe = unsafeToBound(trimmed);
  if (unsafe) return null;

  return {
    command:
      `{ set -o pipefail; } 2>/dev/null; ` +
      `{ ${trimmed}; } 2>&1 | tail -c ${maxBytes}`,
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
    `Output is bounded to the last ${maxBytes} bytes by token-optimizer, so ` +
    `the command ran unchanged but only its tail reached you. The tail is ` +
    `where a test run puts its verdict. Re-run with the output redirected to ` +
    `a file, or set TOKEN_OPTIMIZER_BOUND_BYTES higher, if you need the rest.`
  );
}
