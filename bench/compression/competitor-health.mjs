/**
 * WAS THE COMPETITOR ACTUALLY RUNNING WHEN WE MEASURED IT?
 *
 * Their optional paths fail soft. On the machine this was written on, the
 * Kompress model could not be fetched ("Kompress model not ready; requests will
 * not be compressed" -- their own comment at the emission site calls the result
 * degraded) and the native content detector is off by default on Windows. Each
 * one makes their output larger, which makes our reduction figure better, and
 * neither changes an exit code. `bench/competitive/probe-headroom.py` has
 * refused to write a claims file under that condition since it was written; the
 * head-to-head capture, which is where the published table comes from, recorded
 * nothing at all until `run-theirs.py` was taught to.
 *
 * This is the gate over what it records. A capture that does not say whether
 * their engine was whole is refused exactly like one that says it was not,
 * because the two are indistinguishable from the number alone.
 *
 * THE CLASSIFICATION IS CHECKED TWICE, IN TWO LANGUAGES, ON PURPOSE. The
 * capture decides which warnings are advice about our payload rather than a
 * missing capability of theirs, and it would be trivial to widen that list
 * until every degradation classified itself away. So the same signatures are
 * written out here, independently, and an `advisory` entry this file does not
 * recognise is a refusal. Widening the list on one side fails the gate on the
 * other.
 */

/** Mirrors `ADVISORY_SIGNATURES` in `headroom/run-theirs.py`. Kept in sync by the gate. */
export const ADVISORY_SIGNATURES = Object.freeze([
  // Their cache aligner reporting that OUR fixture carries a timestamp in the
  // system prompt. Their engine ran; the advice is about what we handed it.
  'cache prefix unstable',
]);

const looksLikeEntry = (entry) =>
  entry !== null &&
  typeof entry === 'object' &&
  typeof entry.message === 'string' &&
  entry.message.length > 0 &&
  typeof entry.logger === 'string' &&
  entry.logger.length > 0 &&
  Number.isInteger(entry.count) &&
  entry.count >= 1;

const describe = (entry) => `${entry.message} (${entry.count}x from ${entry.logger})`;

/**
 * @param {unknown} provenance the capture's `__provenance__` block
 * @returns {string|null} why this capture cannot support a published comparison
 */
export function degradationRefusal(provenance) {
  if (provenance === null || typeof provenance !== 'object' || Array.isArray(provenance)) {
    return 'the capture recorded no provenance, so nothing says whether their engine was whole';
  }
  if (!('competitorWarnings' in provenance)) {
    return (
      'the capture predates degradation recording, so nothing says whether their ' +
      'engine ran with a capability missing - re-capture with run-theirs.py'
    );
  }
  const seen = provenance.competitorWarnings;
  if (
    seen === null ||
    typeof seen !== 'object' ||
    Array.isArray(seen) ||
    !Array.isArray(seen.degraded) ||
    !Array.isArray(seen.advisory)
  ) {
    return 'competitorWarnings is present but not in the recorded shape (two arrays: degraded, advisory)';
  }

  const problems = [];
  for (const entry of seen.degraded) {
    problems.push(
      looksLikeEntry(entry)
        ? `their engine ran with a capability missing: ${describe(entry)}`
        : `an unreadable entry in competitorWarnings.degraded: ${JSON.stringify(entry)}`
    );
  }
  // AN ADVISORY THIS FILE DOES NOT RECOGNISE IS A DEGRADATION. The capture's
  // allow-list cannot be the only thing deciding what is allowed through it.
  for (const entry of seen.advisory) {
    if (!looksLikeEntry(entry)) {
      problems.push(
        `an unreadable entry in competitorWarnings.advisory: ${JSON.stringify(entry)}`
      );
    } else if (!ADVISORY_SIGNATURES.some((signature) => entry.message.includes(signature))) {
      problems.push(
        'the capture classified a warning as advice about our payload and this gate ' +
          `does not recognise it: ${describe(entry)}`
      );
    }
  }
  if (problems.length === 0) return null;
  return (
    `${problems.length} thing(s) mean this capture does not describe their engine: ` +
    problems.join('; ')
  );
}
