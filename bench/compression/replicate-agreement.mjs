/**
 * WHEN A SPEED VERDICT MAY BE ENFORCED: WHEN TWO RECORDINGS AGREE.
 *
 * Their side of every speed pair is captured once and replayed, so it is
 * byte-identical between runs -- measured 0% drift on all eighteen rows. Ours is
 * re-timed by the harness in a fresh Node process each time, and that is what
 * moves. Two recordings of the IDENTICAL capture at the IDENTICAL commit, both
 * load-controlled and both inside the witness band (0.9% drift), gave our own
 * per-pass-p90 medians:
 *
 *   agentic-conversation  116.4 -> 88.1ms  (-24%)
 *   code-search            22.8 -> 27.3ms  (+20%)
 *   api-responses          17.3 -> 20.5ms  (+18%)
 *   sre-debugging          83.6 -> 71.7ms  (-14%)
 *
 * and that last one FLIPPED sre-debugging/speed from a 0.7% loss against their
 * comparable arm into a 13.6% win, with no change to the code under test. The
 * load witness cannot catch it -- both runs were in band -- so this is the
 * estimator's own resolution and not interference, and a tighter load rule
 * cannot fix it.
 *
 * MORE PASSES WAS THE OTHER CANDIDATE AND WAS REJECTED. Passes inside one
 * recording share a process, a JIT state and a heap, so more of them narrows the
 * within-process variance that the median across passes already handles, and
 * says nothing about the between-recording variance that flipped the verdict. It
 * costs harness runtime linearly for a variance it may not reduce at all.
 *
 * A DISAGREEMENT IS UNDECIDED, NOT A LOSS. When two recordings reach opposite
 * verdicts the instrument failed to resolve the margin, and that is not evidence
 * about which arm is faster. Two of eighteen rows sit inside that resolution
 * (relevance-probe, margin 8.2% against 10.9% drift; sre-debugging, 13.6%
 * against 16.5%), and those are the two this refuses to enforce.
 */

/**
 * Why this pair of records cannot be read as two recordings of one thing.
 *
 * Checked per row rather than once, so a replicate that covers part of the
 * corpus still counts where it covers it.
 *
 * A COPY IS NOT A SECOND RECORDING, and that is the trap the last clause exists
 * to close: copying the record over the replicate path satisfies every other
 * test here and turns the whole rule into a no-op that reports agreement with
 * itself. Two genuine recordings cannot produce identical floating-point sample
 * arrays, so identical readings are proof of a copy, not of stability.
 */
export function disqualify({ primary, replicate, name }) {
  if (replicate === null || replicate === undefined) return 'no second recording';
  if (replicate.capture?.dir !== primary.capture?.dir)
    return (
      `the replicate was recorded against capture ${replicate.capture?.dir ?? 'unknown'} ` +
      `and this record against ${primary.capture?.dir ?? 'unknown'} -- two captures ` +
      `are not two recordings of one`
    );
  if (replicate.reproduction?.commit !== primary.reproduction?.commit)
    return (
      `the replicate names commit ` +
      `${String(replicate.reproduction?.commit ?? 'unknown').slice(0, 8)} and this ` +
      `record ${String(primary.reproduction?.commit ?? 'unknown').slice(0, 8)} -- they ` +
      `measured different code`
    );
  if ((replicate.reproduction?.refusal ?? null) !== null)
    return `the replicate refuses its own provenance: ${replicate.reproduction.refusal}`;
  const b = (replicate.workloads ?? []).find((w) => w.name === name);
  if (b === undefined) return 'the replicate does not cover this row';
  const a = (primary.workloads ?? []).find((w) => w.name === name);
  if (a === undefined) return 'this record does not cover this row';
  if (JSON.stringify(a.speed?.oursMsPasses ?? null) === JSON.stringify(b.speed?.oursMsPasses ?? null))
    return (
      'the replicate carries readings identical to this record, so it is a copy of ' +
      'it rather than a second recording'
    );
  return null;
}

/**
 * The verdict, given the same judgement applied to each recording.
 *
 * `judge` is ONE function applied to two recordings rather than two comparisons
 * written separately, for the same reason the comparable column reuses
 * `speedVerdict`: a second reading judged by a softer test than the first is not
 * a second opinion, it is a loophole.
 *
 * An ALREADY-REFUSED primary needs no second opinion and keeps its own reason --
 * saying "not enforceable on one recording" over the top of "our referencing arm
 * was not timed in this capture" buries the reason that matters.
 */
export function agreeAcrossRecordings({ judge, primary, replicate, name }) {
  const first = judge(
    ((primary.workloads ?? []).find((w) => w.name === name) ?? {}).speed
  );
  if (first.pass !== true && first.pass !== false) return first;
  const why = disqualify({ primary, replicate, name });
  if (why !== null)
    return {
      pass: null,
      detail:
        `${first.detail} -- NOT ENFORCEABLE (${why}): a speed pair needs two ` +
        `independent recordings that agree`,
    };
  const second = judge(
    ((replicate.workloads ?? []).find((w) => w.name === name) ?? {}).speed
  );
  if (second.pass !== first.pass)
    return {
      pass: null,
      detail:
        `TWO RECORDINGS DISAGREE, so the margin is inside the instrument's own ` +
        `resolution: [1] ${first.detail} | [2] ${second.detail}`,
    };
  return { pass: first.pass, detail: `${first.detail} | replicate agrees: ${second.detail}` };
}
