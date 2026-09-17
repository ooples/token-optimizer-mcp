/** Vocabulary-derived bounds for ordinary (non-special) o200k_base encoding.
 * Tests validate these against every shipped token, so a vocabulary update
 * cannot silently turn the fast acceptance path into a byte-count heuristic.
 */
export const O200K_MAX_TOKEN_BYTES = 128;
export const O200K_UNIFORM_ASCII_MAX_BYTES: ReadonlyMap<number, number> =
  new Map([
    [9, 20],
    [10, 16],
    [32, 128],
    [45, 112],
    [46, 64],
    [48, 3],
    [61, 96],
    [97, 8],
    [120, 8],
  ]);

export function provesTokenBenefit(
  before: string,
  beforeBytes: number,
  afterBytes: number
): boolean {
  // Every ordinary token consumes at least one byte and at most this maximum.
  // Thus ceil(beforeBytes/max) is a lower bound, and afterBytes an upper bound.
  let lower = Math.ceil(beforeBytes / O200K_MAX_TOKEN_BYTES);
  const uniformMax = O200K_UNIFORM_ASCII_MAX_BYTES.get(before.charCodeAt(0));
  if (uniformMax !== undefined) {
    const first = before.charCodeAt(0);
    let uniform = true;
    for (let i = 1; i < before.length; i++) {
      if (before.charCodeAt(i) !== first) {
        uniform = false;
        break;
      }
    }
    if (uniform) lower = Math.ceil(before.length / uniformMax);
  }
  return afterBytes <= lower * 0.9 && lower - afterBytes >= 8;
}
