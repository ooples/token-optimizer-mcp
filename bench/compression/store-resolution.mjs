/**
 * IS THEIR STORE'S ANSWER AN ANSWER, OR DID WE ASK TOO LATE?
 *
 * WHAT FORCED THIS FILE. Their compressor elides content into a CCR store and
 * leaves a `<<ccr:HASH>>` marker behind. Those markers are redeemable -- scoring
 * them as loss would understate their retention -- so resolve-theirs.py redeems
 * them from a separate, later process and the scorer credits what comes back.
 *
 * Their store keeps an entry for a bounded time. Their own resolver states the
 * bound when it refuses: `Entry not found (CCR TTL: 1800 seconds)`. A resolution
 * taken after that window reports every marker unresolved, and the resulting
 * file is structurally indistinguishable from one where their store genuinely
 * held nothing:
 *
 *   hr24/out/theirs-resolved.json   14 markers, 0 redeemed, error null
 *   hr25/out/theirs-resolved.json   14 markers, 14 redeemed, error null
 *
 * Same capture, same corpus, same code on both sides. The only difference is
 * that the first resolution ran about fifty minutes after its sweep and the
 * second ran immediately. Scored naively, the first says their store lost all
 * fourteen and hands us a retention win on six workloads; the second says they
 * redeemed all fourteen. The win in the first reading is entirely an artifact of
 * our own sequencing, and nothing in the file says so.
 *
 * WHAT THIS DECIDES. A resolution is usable when it can distinguish those two
 * cases and unusable when it cannot. Unusable is UNMEASURED -- never a loss for
 * them. That direction matters: the conservative reading is the one that refuses
 * to bank a win we cannot support, so this file exists to take points away from
 * us, and the refusal has to be cheap enough that re-running properly is the
 * easy path.
 *
 * WHY NOT JUST CHECK THE TIMESTAMP. It does check it, when there is one, and the
 * message is better for it. But the timestamp is the weaker signal, because a
 * capture taken before run-theirs.py stamped `sweptAt` has none, and a clock that
 * moved says nothing about their store. The load-bearing signal is their own
 * refusal text: if their resolver quoted a TTL at us, it refused for want of
 * time, whatever our clocks say.
 */

/** Their stated bound, parsed out of their own refusal rather than hardcoded. */
const TTL_SAID = /CCR TTL: (\d+) seconds/;

/**
 * `{ usable, detail }` for one workload's resolution. Never throws: a shape this
 * function does not recognise is unusable, not assumed good.
 *
 * `entry` is one value from theirs-resolved.json; `prov` is its
 * `__provenance__`, when the resolver that wrote it was new enough to add one.
 */
export function resolutionUsable(entry, prov = null) {
  if (entry === null || entry === undefined)
    return { usable: false, detail: 'no resolution recorded for this workload' };
  if (typeof entry.text !== 'string')
    return { usable: false, detail: 'resolution carries no resolved text' };
  if (entry.error)
    return { usable: false, detail: `their resolver raised ${String(entry.error)}` };

  const markers = Number(entry.markers ?? 0);
  const unresolved = Number(entry.unresolved ?? 0);
  if (!Number.isFinite(markers) || !Number.isFinite(unresolved))
    return { usable: false, detail: 'resolution marker counts are not numbers' };

  // Nothing was elided, so there is nothing a store could have failed to serve.
  // This is the common case and it is fully measured.
  if (markers === 0) return { usable: true, detail: 'no markers to redeem' };

  const reasons = Array.isArray(entry.reasons) ? entry.reasons : [];
  const quoted = reasons.map((r) => TTL_SAID.exec(String(r))).find(Boolean);
  const late =
    prov && typeof prov.elapsedSeconds === 'number' && typeof prov.theirStatedTtlSeconds === 'number'
      ? `resolved ${prov.elapsedSeconds.toFixed(0)}s after the sweep, ` +
        `their stated TTL is ${prov.theirStatedTtlSeconds}s`
      : null;

  if (quoted)
    return {
      usable: false,
      detail:
        `their store refused ${unresolved} of ${markers} marker(s), quoting a ` +
        `${quoted[1]}s TTL` +
        (late ? ` (${late})` : '') +
        ' -- so this cannot tell a store that lost content from one asked too ' +
        'late, and their retention is unmeasured rather than lost',
    };

  // No TTL quoted, but not one marker of many came back. A working store asked
  // inside its window serves at least one; zero-of-many is the store not
  // answering, whatever reason it gave or failed to give.
  if (unresolved === markers)
    return {
      usable: false,
      detail:
        `their store served none of ${markers} marker(s)` +
        (reasons.length ? ` (${reasons.join('; ')})` : ' and gave no reason') +
        (late ? ` (${late})` : '') +
        ' -- a reachable store serves at least one, so their retention is unmeasured',
    };

  // Some came back and some did not. The store answered, so the misses are its
  // answer and belong in their loss column.
  return {
    usable: true,
    detail: `${markers - unresolved} of ${markers} marker(s) redeemed`,
  };
}
