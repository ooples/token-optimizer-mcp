/**
 * Append every item to `destination` without spreading them as arguments.
 *
 * `destination.push(...items)` passes one argument per item, and V8 accepts a
 * measured 125,262 of them before throwing
 * `RangeError: Maximum call stack size exceeded`. That is not a theoretical
 * ceiling: smart_grep globbed 676,875 files on an ordinary home directory and
 * threw on the very first push, so the tool failed identically for every caller
 * in every project.
 *
 * A loop has no argument list and therefore no limit.
 */
export function appendAll<T>(destination: T[], items: readonly T[]): void {
  for (const item of items) {
    destination.push(item);
  }
}
