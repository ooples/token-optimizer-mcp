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
const CACHE_FLAGS = new Set([
  'cacheHit',
  'cached',
  'fromCache',
  // Cache state under a different word. `isDiff` says this reply is a diff
  // against what the cache already held, and `incrementalUpdate` says only
  // the changed files were walked. Both describe how this process answered,
  // not the thing it was asked about -- which is what `cacheHit` says.
  'isDiff',
  'incrementalUpdate',
]);

/** Cache bookkeeping carried as a digest or key rather than a flag. */
const CACHE_DIGESTS = new Set(['fileHash', 'hash', 'cacheKey']);

/**
 * Facts about the caller's own file, restated.
 *
 * Each is derivable from the name the caller typed: `size` by stat-ing it,
 * `format` and `language` from its extension. Twenty tokens across the
 * benched cases, but FIXED ones, so they fall whole on the smallest replies
 * -- where they are the difference between beating a file read and losing.
 */
const INPUT_FACTS = new Set(['size', 'format', 'language', 'extension']);

/**
 * Containers holding a tool's own bookkeeping, never a caller's content.
 *
 * A node with one of these names is pruned wherever it sits, not only
 * directly beneath the root, because smart_pretty keeps a second copy of its
 * cache flag three levels down at `data.format.metadata.cacheHit`.
 */
const ENVELOPE_CONTAINERS = new Set(['metadata', 'summary']);

/**
 * Keys under which a tool hands back the caller's OWN text, never descended.
 *
 * This is the whole safety argument of the file. A config is arbitrary JSON
 * and may legitimately contain a key called `cached`, `success` or
 * `metadata`; removing one there would corrupt the answer rather than
 * shorten it. So the walk below recurses through everything a tool built
 * itself and stops dead at these, the places a tool puts content it did not
 * author.
 *
 * A tool that returns caller content under a NEW key means adding that key
 * here. The boundary test covers `resolved`, at two depths, with a reply
 * carrying every bookkeeping family inside it.
 */
const CALLER_CONTENT = new Set([
  'resolved',
  'config',
  'parsed',
  'content',
  'code',
  'raw',
  'original',
  'source',
  'rows',
  'columns',
  'text',
  'body',
]);

/**
 * Does this field restate an input rather than report a finding?
 *
 * Two ways it can, and the difference between them matters more than it
 * looks. A field equal to what the caller sent under the same name is a
 * verbatim echo. A field equal to the DEFAULT its own inputSchema publishes
 * is an echo too, one step removed: the caller read that default out of
 * `tools/list` before they called.
 *
 * WHY NOT SIMPLY "THE NAME IS A DECLARED INPUT". Because that deletes
 * answers. smart_env declares `environment`, and its schema says
 * "auto-detected if not specified" -- so `environment: "production"` on a
 * reply to a request that named no environment is a DETECTION, the useful
 * part of the answer. Tried by name, it vanished: 81 tokens became 77 and
 * one of the four was a finding. A property that is auto-detected publishes
 * no default, which is exactly what separates it from `mode`, whose schema
 * prints `default: 'graph'`.
 */
function restatesInput(
  key: string,
  value: unknown,
  args: unknown,
  declaredDefaults: ReadonlyMap<string, unknown>
): boolean {
  if (isPlainObject(args) && Object.hasOwn(args, key) && args[key] === value)
    return true;
  return declaredDefaults.has(key) && declaredDefaults.get(key) === value;
}

function isScalar(value: unknown): boolean {
  return typeof value !== 'object' || value === null;
}

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
  supplied: string[],
  args: unknown,
  declaredDefaults: ReadonlyMap<string, unknown>
): Record<string, unknown> {
  const kept: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(envelope)) {
    if (key === 'success' && value === true) continue;
    if (CACHE_FLAGS.has(key) && typeof value === 'boolean') continue;
    if (CACHE_DIGESTS.has(key) && typeof value === 'string') continue;
    if (typeof value === 'string' && echoesSupplied(value, supplied)) continue;
    // AN INPUT IS NOT A FINDING. smart_dependencies answers with
    // `mode: 'graph'` and `metadata.incrementalUpdate: true`, and both are
    // its own inputs at their own published defaults. See restatesInput for
    // why the test is the VALUE and not the name.
    //
    // Scalars only. An object or array under an input name is a finding that
    // happens to share the name, not a restatement of one.
    if (isScalar(value) && restatesInput(key, value, args, declaredDefaults))
      continue;
    if (isScalar(value) && INPUT_FACTS.has(key)) continue;
    kept[key] = value;
  }
  return kept;
}

/**
 * Prune one node, then every container beneath it that the tool itself built.
 *
 * Returns the SAME object when nothing changed anywhere under it, so a reply
 * carrying none of this is never reserialised and cannot be reordered.
 */
function prunedTree(
  node: Record<string, unknown>,
  supplied: string[],
  args: unknown,
  declaredDefaults: ReadonlyMap<string, unknown>,
  prunable: boolean
): Record<string, unknown> {
  const base = prunable
    ? pruneEnvelope(node, supplied, args, declaredDefaults)
    : { ...node };
  let changed = Object.keys(base).length !== Object.keys(node).length;
  for (const [key, value] of Object.entries(base)) {
    if (CALLER_CONTENT.has(key)) continue;
    if (!isPlainObject(value)) continue;
    const inner = prunedTree(
      value,
      supplied,
      args,
      declaredDefaults,
      ENVELOPE_CONTAINERS.has(key)
    );
    if (inner === value) continue;
    changed = true;
    // A container emptied of bookkeeping is not an answer; drop the container
    // too rather than send `"metadata":{}`.
    if (ENVELOPE_CONTAINERS.has(key) && Object.keys(inner).length === 0)
      delete base[key];
    else base[key] = inner;
  }
  return changed ? base : node;
}

/**
 * Remove, from one reply, what the caller already holds.
 *
 * `declaredDefaults` holds, for this tool's own published inputSchema, every
 * property that prints a `default` and what that default is. It is how the
 * seam tells an echoed option from a finding while knowing nothing else
 * about the tool, and it defaults to empty so a caller that cannot supply it
 * still gets the other rules.
 */
export function withoutRestated(
  reply: unknown,
  args: unknown,
  declaredDefaults: ReadonlyMap<string, unknown> = new Map<string, unknown>()
): unknown {
  if (!isPlainObject(reply)) return reply;
  return prunedTree(reply, suppliedPaths(args), args, declaredDefaults, true);
}
