/**
 * WHICH ARMS COMPRESS, AND WHICH ONES JUST MOVE THE BYTES SOMEWHERE ELSE.
 *
 * An arm can shrink its output two ways. It can encode the content more
 * densely, so a reader holds everything it held before in fewer tokens. Or it
 * can take the content out, put it on local disk, and leave a marker behind.
 * The second one is not compression, and the difference is not cosmetic: the
 * first costs the reader nothing, the second costs a retrieval before the
 * content can be read at all.
 *
 * Our side has always kept these apart -- `ours` is the encoding arm, `sub` is
 * the substitution arm, and the report prints "SUBSTITUTION, not reduction"
 * beside `sub` along with how much it parked on disk. Their side was scored as
 * one column, `min(attempts, key=reduction)`, which is best-of-both. So the
 * headline put our encoding arm against their substitution arm, and that is the
 * wrong comparison in the direction that flatters them.
 *
 * This module classifies an arm by what its OUTPUT contains, not by its name.
 * A name can lie and a version can change; a `<<ccr:...>>` marker in the output
 * is the arm telling you the bytes went to the store.
 *
 * ONE RULE ABOUT ABSENCE, AND IT IS THE WHOLE REASON THIS IS A MODULE.
 * When every arm offloads, the like-for-like number does not exist. It is NOT
 * zero. Scoring it as "0% reduction" invents a measurement and, because it
 * lands on their side of the table, invents one that flatters us. `bestArm`
 * returns null for that case, and a caller that sums has to decide out loud
 * what to do with the null rather than adding it to a total as a zero.
 */

/**
 * The store marker HeadRoom leaves behind: `<<ccr:44e5f6344bfd,string,57.4KB>>`
 * -- an id, a type, and the size it claims to be holding.
 */
const MARKER = /<<ccr:([0-9a-f]+),([^,>]*),([0-9.]+)(B|KB|MB|GB)>>/g;

const SCALE = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3 };

/** Every store marker in a text, with the size each one claims. */
export function offloadMarkers(text) {
  const found = [];
  for (const m of String(text ?? '').matchAll(MARKER)) {
    found.push({
      id: m[1],
      kind: m[2],
      // DECLARED, NOT MEASURED. This is the arm's own claim about what it put
      // on disk. It is the right number for "how much left the context" and
      // the wrong one for "how much is really in the store" -- only reading
      // the store answers that, and the caller names which it wanted.
      declaredBytes: Math.round(Number(m[3]) * SCALE[m[4]]),
    });
  }
  return found;
}

/** Did this arm move content out of the context rather than encode it? */
export function isOffloading(text) {
  return offloadMarkers(text).length > 0;
}

/** Total bytes an arm's output claims to have parked on disk. */
export function declaredOffloadBytes(text) {
  return offloadMarkers(text).reduce((n, m) => n + m.declaredBytes, 0);
}

/**
 * The best arm by compression ratio, optionally restricted to arms that did
 * not offload.
 *
 * `arms` maps a label to `{ text, beforeText }`. The ratio is measured against
 * each arm's OWN before-text, because a wrapped tool payload carries envelope
 * bytes the raw text does not, and charging an arm for an envelope the harness
 * added is a denominator error.
 *
 * `size` turns a string into the unit being compared -- `s => s.length` for
 * characters, a tokeniser for tokens. It is injected so this module needs no
 * tokeniser of its own and stays testable offline.
 *
 * Returns null when no arm qualifies. See the header: that is an absent
 * measurement, not a zero.
 */
export function bestArm(arms, { excludeOffload = false, size = (s) => s.length } = {}) {
  let best = null;
  for (const [label, arm] of Object.entries(arms ?? {})) {
    const text = arm?.text ?? '';
    const offloads = isOffloading(text);
    if (excludeOffload && offloads) continue;
    const base = size(arm?.beforeText ?? '');
    // A zero-length before-text has no ratio. Calling it 1.0 would rank an
    // unmeasurable arm alongside one that genuinely achieved nothing.
    if (!base) continue;
    const ratio = size(text) / base;
    if (best === null || ratio < best.ratio) {
      best = { label, ratio, offloads, declaredOffloadBytes: declaredOffloadBytes(text) };
    }
  }
  return best;
}

/**
 * Both readings of one workload's arms: the best arm of any kind, and the best
 * arm that kept everything in the context.
 *
 * `comparable` is the flag a caller needs before it adds anything to a total.
 * False means every arm offloaded, so this workload can be counted in a
 * substitution comparison and must be left out of a reduction comparison.
 */
export function classifyArms(arms, opts = {}) {
  const any = bestArm(arms, { ...opts, excludeOffload: false });
  const clean = bestArm(arms, { ...opts, excludeOffload: true });
  return { any, clean, comparable: clean !== null };
}
