/**
 * NOTHING THE CALLER ALREADY HAS IS WORTH SENDING BACK.
 *
 * Measured at the wire across all 37 cases in bench/tools/reduction.mjs, three
 * kinds of field cost 347 of 21,140 tokens and answer nothing:
 *
 *   `success: true`     on a reply that is not an error. MCP marks failure with
 *                       `isError`, so a true here is a second copy of the fact
 *                       that nothing went wrong.
 *   cache bookkeeping   `cacheHit`, `cached`, `fromCache`, `fileHash`, `hash`,
 *                       `cacheKey` -- facts about this process, not about the
 *                       input the caller asked about.
 *   an echoed path      the file the caller named, handed back to the caller
 *                       who named it.
 *
 * 1.64% in aggregate, but the aggregate is the wrong way to read it: these are
 * fixed costs, so they fall entirely on the small replies. They are 25% of
 * smart_env's answer about an 8-variable file and 17% of smart_tsconfig's about
 * a 76-token config, and removing them turns smart_env/example.env from -14.4%
 * into +14.4% -- a tool that cost more than reading the file into one that
 * does not.
 *
 * WHY HERE AND NOT IN THE TOOLS. `success: true` is written at 371 places in 82
 * files and the cache fields at 557 more. Editing them individually would be a
 * thousand chances to miss one and a thousand diffs to review, and a tool added
 * next week would arrive with the fields back. This is the one place every
 * reply passes, so one rule covers every tool including the ones not written
 * yet.
 *
 * WHAT IT DELIBERATELY CANNOT REACH. A reply may carry the caller's own parsed
 * file -- smart_tsconfig returns the resolved config, and a config is arbitrary
 * JSON that may legitimately contain a key called `cached` or `success`.
 * Removing one would corrupt the answer. So this walks the ENVELOPE only: the
 * reply object itself, and a `metadata` or `summary` object directly beneath
 * it. Those two names are a tool's own bookkeeping container in every reply
 * measured, and nothing nested deeper is touched at any depth. The cost of
 * that boundary is one duplicate flag at `data.format.metadata.cacheHit`, six
 * tokens, whose copy at `metadata.cacheHit` is removed; the benefit is that no
 * amount of caller content can be mistaken for an envelope. A test pins both
 * halves.
 */

/** Cache bookkeeping that is true of this process, not of the input. */
const CACHE_FLAGS = new Set(['cacheHit', 'cached', 'fromCache']);

/** Cache bookkeeping carried as a digest or key rather than a flag. */
const CACHE_DIGESTS = new Set(['fileHash', 'hash', 'cacheKey']);

/** Envelope containers: a tool's own bookkeeping, never a caller's content. */
const ENVELOPE_CONTAINERS = new Set(['metadata', 'summary']);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Every path-like string the caller supplied, normalised for comparison.
 *
 * A reply does not echo the argument verbatim -- smart_tsconfig answers an
 * absolute `configPath` with the same file written relative to the project
 * root -- so matching on the string as sent would find nothing. Comparing the
 * trailing segments instead is what makes `bench/tools/fixtures/tsconfig.json`
 * recognisable as the `C:/.../bench/tools/fixtures/tsconfig.json` that was
 * asked about, while leaving a path the tool resolved on its own, which is the
 * one case where a path IS the answer, alone.
 */
function suppliedPaths(args: unknown): string[] {
  if (!isPlainObject(args)) return [];
  const out: string[] = [];
  const add = (value: unknown): void => {
    if (typeof value === 'string' && value.length > 0)
      out.push(normalise(value));
    else if (Array.isArray(value)) value.forEach(add);
  };
  for (const value of Object.values(args)) add(value);
  return out;
}

function normalise(path: string): string {
  return path
    .replace(new RegExp('\\\\', 'g'), '/')
    .replace(/\/+$/, '')
    .toLowerCase();
}

/** Does `candidate` name a file the caller named? */
function echoesSupplied(candidate: string, supplied: string[]): boolean {
  const seen = normalise(candidate);
  if (seen.length === 0) return false;
  return supplied.some(
    (given) =>
      given === seen || given.endsWith(`/${seen}`) || seen.endsWith(`/${given}`)
  );
}

function pruneEnvelope(
  envelope: Record<string, unknown>,
  supplied: string[]
): Record<string, unknown> {
  const kept: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(envelope)) {
    if (key === 'success' && value === true) continue;
    if (CACHE_FLAGS.has(key) && typeof value === 'boolean') continue;
    if (CACHE_DIGESTS.has(key) && typeof value === 'string') continue;
    if (typeof value === 'string' && echoesSupplied(value, supplied)) continue;
    kept[key] = value;
  }
  return kept;
}

/**
 * Remove, from one reply, what the caller already holds.
 *
 * Returns the same object when nothing was removed, so a reply that carries
 * none of this is not reserialised and cannot be reordered.
 */
export function withoutRestated(reply: unknown, args: unknown): unknown {
  if (!isPlainObject(reply)) return reply;
  const supplied = suppliedPaths(args);
  const pruned = pruneEnvelope(reply, supplied);
  let changed = Object.keys(pruned).length !== Object.keys(reply).length;
  for (const name of ENVELOPE_CONTAINERS) {
    const container = pruned[name];
    if (!isPlainObject(container)) continue;
    const inner = pruneEnvelope(container, supplied);
    if (Object.keys(inner).length === Object.keys(container).length) continue;
    changed = true;
    // A container emptied of bookkeeping is not an answer; drop the container
    // too rather than send `"metadata":{}`.
    if (Object.keys(inner).length === 0) delete pruned[name];
    else pruned[name] = inner;
  }
  return changed ? pruned : reply;
}
