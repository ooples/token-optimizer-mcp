/**
 * WHAT A PUBLISHED NUMBER HAS TO CARRY BEFORE SOMEONE ELSE CAN RE-RUN IT.
 *
 * Every figure in this repository is produced by two programs on one machine,
 * and an outside reader has no way to tell a number that would come back the
 * same from a number that happened once. The difference is entirely in what the
 * record says about the run, so this module states the minimum and refuses a
 * record that falls short of it.
 *
 * THE FIELDS ARE NOT A WISH LIST. Each one has already moved a published number
 * on this project, or is the only thing that could have detected a move that
 * did happen:
 *
 *   commit, dirty     a record stamped with a sha whose tree was modified names
 *                     code that does not exist anywhere. Reproducing it is not
 *                     merely hard, it is undefined.
 *   node, tiktoken    the token column IS the tokeniser. A different tiktoken
 *                     build re-segments every payload, and nothing else in the
 *                     record would show it.
 *   encoding          cl100k_base against o200k_base moves the same text by
 *                     double digits.
 *   payloadsDigest    the ratios are a function of the input. Two records with
 *                     different payload sets are not comparable, and the
 *                     payload set is generated, so it drifts.
 *   theirsDigest      a stale out-dir reproduced a competitor column that had
 *                     already been retracted, and nothing in the record showed
 *                     it: ours moved, theirs reverted, the standing went from
 *                     nine workloads to five.
 *   headroomVersion   their engine's own version, without which "theirs" names
 *                     nothing -- EXCEPT on a known-answer capture, where their
 *                     engine never ran and a version here would name an engine
 *                     that had no part in the column. See `stubArms`.
 *   stubArms          whether their column came from stub arms instead of their
 *                     engine. It is what makes an ABSENT version readable: with
 *                     it, the absence is the honest answer; without it, the
 *                     absence is a gap. A version that IS present answers the
 *                     reader's question on its own, so nothing more is asked of
 *                     a record that carries one -- unless `stubArms` contradicts
 *                     it, which is the refusal above.
 *   python            their capture runs under it.
 *   instrument        their engine reads its redeemable content out of a durable
 *                     store, and the arms that decide the comparable cost and
 *                     retention columns move by up to two orders of magnitude
 *                     between a sweep that started from an empty store and one
 *                     that started from a warm one. The detector backend and the
 *                     chunk count move columns the same way, and all of it is
 *                     already one string, so the record carries that string
 *                     rather than a second copy of the same facts that could
 *                     disagree with it.
 *   speedPasses       a speed verdict taken over fewer than two passes cannot
 *                     separate a regression from interference, on either side.
 *
 * EVERY PROBLEM AT ONCE, not the first one. A refusal that stops at the first
 * missing field costs a full re-run per field, and a re-run is the expensive
 * thing here -- the capture takes minutes and the meter reads cannot be
 * repeated at will. So the refusal lists all of them.
 */

/** sha256 truncated to 16, the width the record uses. */
const HEX16 = /^[0-9a-f]{16}$/;
/** A version, permissively: leading major.minor.patch, anything after. */
const SEMVER = /^[0-9]+[.][0-9]+[.][0-9]+/;
const SHA40 = /^[0-9a-f]{40}$/;
const NAME = /^[a-z0-9_]+$/;
/**
 * The instrument fingerprint `instrumentFingerprint` builds, REQUIRED TO END IN A
 * STORE STATE. `store=unrecorded` is not a state, it is the admission that the
 * capture did not look, and it is exactly the case a reader cannot reproduce: the
 * term reads `unrecorded` when their store file exists with no live-entry count,
 * which is when there is most to get wrong. A fingerprint with no store term at
 * all predates the stamp and is refused for the same reason.
 */
const INSTRUMENT = /^v[0-9]+:.* store=(?:empty|warm)$/;

/**
 * The required fields, each with the shape it must have and the reason a reader
 * needs it. Order is the order the refusal reports them in.
 */
export const FIELDS = {
  commit: { look: SHA40, says: 'the 40-character sha of the tree that produced it' },
  node: { look: SEMVER, says: 'the node version the scorer ran on' },
  tiktoken: { look: SEMVER, says: 'the tokeniser package version' },
  encoding: { look: NAME, says: 'the encoding the token column was measured in' },
  payloadsDigest: { look: HEX16, says: 'sha256 of payloads.json, first 16' },
  theirsDigest: { look: HEX16, says: 'sha256 of their output, first 16' },
  python: { look: SEMVER, says: 'the python their capture ran under' },
  instrument: {
    look: INSTRUMENT,
    says: 'the instrument fingerprint, ending in the store state their engine started from',
  },
};

/** Both sides of a speed verdict need at least this many separated passes. */
export const MIN_PASSES = 2;

/**
 * Why this record cannot be reproduced, or null when it can.
 *
 * @param {object|null|undefined} prov the record's reproduction block
 * @returns {string|null}
 */
export function reproducibilityRefusal(prov) {
  if (prov === null || typeof prov !== 'object') {
    return 'no reproduction block at all, so nothing about the run was recorded';
  }
  const problems = [];
  for (const [field, { look, says }] of Object.entries(FIELDS)) {
    const value = prov[field];
    if (value === undefined || value === null || value === '' || value === 'unknown') {
      problems.push(`${field} is missing (${says})`);
    } else if (typeof value !== 'string' || !look.test(value)) {
      // A FIELD THAT IS PRESENT AND UNUSABLE IS WORSE THAN AN ABSENT ONE,
      // because it reads as recorded. An empty digest, a truncated sha and the
      // literal string 'unknown' all arrived here from real code paths that
      // swallowed a failure and carried on.
      problems.push(`${field} is not usable: ${JSON.stringify(value)} (${says})`);
    }
  }
  // THEIR VERSION IS REQUIRED OR FORBIDDEN, AND WHICH ONE IS NOT OUR CHOICE.
  // `stubArms` names the module that replaced their engine, and under it their
  // package is never imported: a semver here would name an engine that produced
  // none of the column, which is a fabricated provenance field and reads as
  // recorded. Without it their engine did produce the column and a reader cannot
  // reproduce the figures without knowing which version of it -- a stale out-dir
  // once reproduced a competitor column that had already been retracted. So both
  // arms refuse, and neither is the lenient one.
  const stubbed = typeof prov.stubArms === 'string' && prov.stubArms !== '';
  const version = prov.headroomVersion;
  const absent =
    version === undefined || version === null || version === '' || version === 'unknown';
  if (stubbed) {
    if (!absent) {
      problems.push(
        `headroomVersion is ${JSON.stringify(version)} on a capture taken with ` +
          `stub arms (${prov.stubArms}), where their engine never ran -- it names ` +
          'an engine that produced none of this column'
      );
    }
  } else if (absent) {
    // BOTH WAYS OUT, NAMED. The reader of this refusal either has a version to
    // record or has a stub to declare, and a refusal that mentioned only the
    // first would send a known-answer capture off to install a package it never
    // calls.
    problems.push(
      'headroomVersion is missing (the competitor package version), and stubArms ' +
        'does not say a stub produced their column instead'
    );
  } else if (typeof version !== 'string' || !SEMVER.test(version)) {
    problems.push(
      `headroomVersion is not usable: ${JSON.stringify(version)} ` +
        '(the competitor package version)'
    );
  }
  // A DIRTY TREE IS THE ONE FIELD WHOSE HONEST VALUE IS A REFUSAL. The sha is
  // well formed and the code it names is not the code that ran.
  if (prov.dirty === true) {
    problems.push('the working tree was modified, so the commit names code that did not run');
  } else if (prov.dirty !== false) {
    problems.push('dirty is missing, so nothing says whether the tree was clean');
  }
  const passes = prov.speedPasses;
  if (passes === null || typeof passes !== 'object') {
    problems.push('speedPasses is missing (how many separated passes each side was timed over)');
  } else {
    for (const side of ['ours', 'theirs']) {
      const n = passes[side];
      if (!Number.isInteger(n) || n < MIN_PASSES) {
        problems.push(
          `speedPasses.${side} is ${JSON.stringify(n)}, and a speed verdict needs ` +
            `${MIN_PASSES} or more separated passes on both sides`
        );
      }
    }
  }
  if (problems.length === 0) return null;
  return `${problems.length} thing(s) stop this record being re-runnable: ` + problems.join('; ');
}
