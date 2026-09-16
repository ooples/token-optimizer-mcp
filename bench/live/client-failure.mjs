/** Native allocation failures can terminate the CLI before it emits a JSON error. */
export function clientAllocationFailure(exit, stderr) {
  if (!Number.isInteger(exit) || exit === 0) return null;
  if (
    !/(?:^|\r?\n)(?:memory allocation of \d+ bytes failed|FATAL ERROR: [^\r\n]*(?:Allocation failed|heap out of memory))/i.test(
      stderr
    )
  )
    return null;
  return `Client allocation failure (process exit ${exit}); provider usage may be unknown`;
}
