/**
 * WHAT INSTRUMENT WAS A RATCHET ENTRY RECORDED WITH?
 *
 * The ratchet's rule is that a pass may never regress, and that rule is only as
 * good as the readings the pass was recorded from. It was not: twelve speed
 * entries were promoted from captures hr6 and hr7, where their engine ran with
 * its Python fallback detector and an ML compressor that had not finished
 * loading -- so their arm paid startup inside every timed region and read 60 to
 * 270ms. With their native detector on and the model warm, the same workloads
 * read 3 to 15ms. Our own readings barely moved. Five of those six "passes"
 * were never passes; they were a competitor measured while it was not all there.
 *
 * Nothing in the ratchet file could have said so, because an entry was the bare
 * value `true`. This module gives an entry the provenance that makes it
 * checkable: the capture it came from and a fingerprint of the capabilities
 * their engine ran with. An entry whose fingerprint is missing, or no longer
 * matches, is STALE -- not a pass, and not a regression either. It is a claim
 * whose instrument is unknown, and the only honest move is to re-earn it
 * against a capture that records one.
 *
 * THE FINGERPRINT COVERS EVERY CRITERION, not just speed. A degraded competitor
 * emits a bigger payload as well as a slower one, and a bigger payload for them
 * is a cheaper cost column and a thinner retention bar for us. The same missing
 * capability flatters all three.
 */

/** Bumped when a field is added below, because that is a real reason to re-earn. */
export const FINGERPRINT_VERSION = 'v1';

/**
 * The competitor capabilities a verdict depends on, as a short stable string.
 *
 * ONLY CAPABILITY FACTS GO IN HERE, never a timing or a byte count. The point is
 * that two honest captures of the same engine produce the same fingerprint, so
 * a legitimate re-capture inherits its passes and only a changed instrument
 * forces them to be re-earned. `waitedSeconds` differs between two warm runs;
 * `ready` does not.
 *
 * @param {object|null} provenance results.capture.theirsProvenance
 * @returns {string}
 */
export function instrumentFingerprint(provenance) {
  const p = provenance ?? {};
  const detect = typeof p.detectBackend === 'string' ? p.detectBackend : 'unrecorded';
  const warm = p.kompressWarmup;
  const kompress =
    warm === undefined || warm === null
      ? 'unrecorded'
      : warm.ready === true
        ? 'ready'
        : 'notready';
  const warnings = p.competitorWarnings;
  const degraded =
    warnings === undefined || warnings === null || !Array.isArray(warnings.degraded)
      ? 'unrecorded'
      : warnings.degraded.length === 0
        ? 'none'
        : String(warnings.degraded.length);
  const witness = p.loadWitness === undefined || p.loadWitness === null ? 'no' : 'yes';
  // CHUNKING IS AN INSTRUMENT DIFFERENCE, so a pass may not be carried across it.
  // A chunked capture sweeps each slice against a CCR store the earlier slices
  // have already grown, and separates its speed passes by a chunk-sized sweep
  // rather than a roster-sized one. Both move the columns this ratchet guards, so
  // a pass earned on one sweep is not evidence about the other.
  //
  // THE TERM IS ABSENT ON AN UNCHUNKED CAPTURE, deliberately. This is therefore
  // not the kind of field addition FINGERPRINT_VERSION exists for: every capture
  // taken so far produces the byte-identical string it produced before, which the
  // `a whole capture` case asserts by value, so no recorded entry changes meaning
  // and none has to be re-earned. A chunked capture simply earns its own.
  //
  // WHAT COUNTS AS UNCHUNKED IS THE ABSENCE OF BOTH FIELDS, not just of the merge
  // count. A single chunk's own file carries `chunk: {index, of}` and no merge
  // count, and it holds part of a roster: reading that as a whole sweep is the
  // flattering direction, so anything that is not plainly one sweep gets a term.
  const merged = p.mergedFromChunks;
  const chunk = p.chunk;
  const chunked =
    merged === undefined && (chunk === undefined || chunk === null)
      ? ''
      : typeof merged === 'number' && Number.isFinite(merged)
        ? ` chunks=${merged}`
        : ' chunks=unrecorded';
  return `${FINGERPRINT_VERSION}:detect=${detect} kompress=${kompress} degraded=${degraded} witness=${witness}${chunked}`;
}

/**
 * Read one ratchet entry in either shape.
 *
 * The legacy shape is the bare `true` the file used before provenance existed.
 * It is accepted, and it is accepted as what it is: a pass with no instrument
 * recorded, which cannot be inherited.
 *
 * @param {unknown} value
 * @returns {{enforced: boolean, fingerprint: string|null, capture: string|null}}
 */
export function readEntry(value) {
  if (value === true) return { enforced: true, fingerprint: null, capture: null };
  if (value !== null && typeof value === 'object') {
    const e = /** @type {Record<string, unknown>} */ (value);
    return {
      enforced: e.pass === true,
      fingerprint: typeof e.fingerprint === 'string' ? e.fingerprint : null,
      capture: typeof e.capture === 'string' ? e.capture : null,
    };
  }
  return { enforced: false, fingerprint: null, capture: null };
}

/**
 * May this entry's pass be carried into this run's verdict?
 *
 * @param {unknown} value the raw ratchet entry
 * @param {string} current this capture's fingerprint
 * @returns {{inherit: boolean, reason: string|null}}
 */
export function inheritance(value, current) {
  const entry = readEntry(value);
  if (!entry.enforced) return { inherit: false, reason: null };
  if (entry.fingerprint === null)
    return {
      inherit: false,
      reason: 'recorded before the instrument was fingerprinted, so what it was measured against is unknown',
    };
  if (entry.fingerprint !== current)
    return {
      inherit: false,
      reason: `recorded against ${entry.fingerprint}, this capture is ${current}`,
    };
  return { inherit: true, reason: null };
}

/**
 * The entry to write for a pair that passes under this capture.
 *
 * @param {string} capture results.capture.dir
 * @param {string} fingerprint
 */
export function writeEntry(capture, fingerprint) {
  return { pass: true, capture, fingerprint };
}

/**
 * The retraction map to write, given the one on disk and the ones this run made.
 *
 * A KEY CAN BE RETRACTED AND LATER RE-EARNED, and both facts matter. Writing the
 * new pass to `enforced` while leaving the old retraction alone puts the same key
 * in both maps with nothing to say which came last; deleting the retraction
 * erases that the claim was once made against an instrument we could not verify.
 * So a superseded retraction stays and names the capture that replaced it.
 *
 * `enforcedNow` is the map about to be written, so membership in it -- not a
 * verdict re-derived here -- decides what counts as re-earned.
 */
export function retractionMap(existing, made, enforcedNow, capture, fingerprint) {
  const out = {};
  for (const [key, value] of Object.entries(existing ?? {})) {
    out[key] =
      (enforcedNow ?? {})[key] === undefined
        ? value
        : { ...value, supersededBy: { capture, fingerprint } };
  }
  for (const [key, value] of Object.entries(made ?? {})) out[key] = value;
  return out;
}
