/**
 * THE OFFLOAD CLASSIFIER, CHECKED ON ARMS WHOSE ANSWER IS KNOWN IN ADVANCE.
 *
 * Every case is synthetic and offline. Nothing here reads a capture, runs a
 * compressor or touches the network, so a failure means the classifier is
 * wrong and never that a capture drifted.
 *
 * The case that matters most is `every arm offloading gives null, not a zero`.
 * That single null is the difference between reporting "their non-offload arm
 * reduced nothing" -- a measurement nobody took, which happens to flatter us --
 * and reporting that the comparison does not exist for that workload.
 */

import {
  bestArm,
  classifyArms,
  declaredOffloadBytes,
  isOffloading,
  offloadMarkers,
} from './offload.mjs';

let failures = 0;
// CONDITION FIRST, matching cost-split.check.mjs. The two sibling check files
// in this repo disagree on argument order -- calibrate.check.mjs takes the name
// first -- and calling one with the other's order binds the message to `ok`,
// which is always truthy, so every case prints "ok" without being evaluated.
const check = (ok, name, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` -- ${detail}` : ''}`);
};

// THE HELPER CHECKS ITSELF FIRST. If `check` cannot report a failure, every
// result below it is meaningless, so this runs before any real case.
{
  const before = failures;
  const say = console.log;
  console.log = () => {}; // the deliberate FAIL line would read as a real one
  check(false, 'self-test');
  console.log = say;
  const caught = failures === before + 1;
  failures = before;
  if (!caught) {
    console.log('FAIL the check helper cannot detect a failure -- every result below is void');
    process.exit(1);
  }
  console.log('ok   the check helper reports a false condition as a failure');
}

const mark = (id, kb) => `<<ccr:${id},string,${kb}KB>>`;
const arm = (text, beforeText) => ({ text, beforeText });

// ---------------------------------------------------------------------------
// 1. Detecting an offload at all.
// ---------------------------------------------------------------------------

{
  const found = offloadMarkers(`head ${mark('44e5f6344bfd', '57.4')} tail`);
  check(
    found.length === 1 && found[0].id === '44e5f6344bfd' && found[0].kind === 'string',
    'a store marker is found, with its id and type',
    JSON.stringify(found[0] ?? null)
  );
}

{
  check(
    !isOffloading('a perfectly ordinary compressed body with no markers'),
    'text with no marker is not an offload'
  );
  check(isOffloading(mark('abc123', '1')), 'text with a marker is an offload');
}

{
  // A marker declares its own size, and the units have to be honoured or a
  // kilobyte reads as a byte and the store looks a thousand times smaller.
  const n = declaredOffloadBytes(`${mark('aa', '1')} ${mark('bb', '2')}`);
  check(n === 3 * 1024, 'declared sizes sum in bytes, honouring the unit', `${n}`);
}

{
  // Something marker-SHAPED but not a marker must not be counted, or prose
  // about the format inflates the store.
  check(
    !isOffloading('<<ccr:not-hex,string,many>> is what the marker looks like'),
    'a marker-shaped string that is not a marker is not an offload'
  );
}

// ---------------------------------------------------------------------------
// 2. Picking an arm, and refusing to pick one that does not exist.
// ---------------------------------------------------------------------------

const BEFORE = 'x'.repeat(1000);

{
  const arms = {
    weak: arm('y'.repeat(800), BEFORE),
    strong: arm('y'.repeat(200), BEFORE),
    middling: arm('y'.repeat(500), BEFORE),
  };
  const best = bestArm(arms);
  check(best.label === 'strong' && best.ratio === 0.2, 'the best arm is the smallest ratio', `${best.label} ${best.ratio}`);
}

{
  // The whole point: their smallest arm wins by moving bytes out, and the
  // like-for-like column must pick the smallest arm that did not.
  const arms = {
    encoded: arm('y'.repeat(400), BEFORE),
    offloaded: arm(mark('deadbeef', '57.4'), BEFORE),
  };
  check(bestArm(arms).label === 'offloaded', 'best-of-any picks the offloading arm when it is smallest');
  check(
    bestArm(arms, { excludeOffload: true }).label === 'encoded',
    'the like-for-like column skips the offloading arm'
  );
}

{
  // THE CASE THIS MODULE EXISTS FOR. Every arm offloaded, so there is no
  // non-offload reduction to report. Null, never zero.
  const arms = {
    a: arm(mark('aaaaaaaa', '10'), BEFORE),
    b: arm(`${mark('bbbbbbbb', '5')} residue`, BEFORE),
  };
  const c = classifyArms(arms);
  check(c.clean === null, 'every arm offloading gives null, not a zero');
  check(c.comparable === false, 'and says so, so a caller cannot sum it by accident');
  check(c.any !== null && c.any.offloads === true, 'while the best-of-any reading still exists', c.any?.label);
}

{
  const c = classifyArms({ only: arm('y'.repeat(300), BEFORE) });
  check(
    c.comparable === true && c.clean.label === 'only' && c.any.label === 'only',
    'an arm that kept everything in context is comparable, and is both readings'
  );
}

{
  check(bestArm({}) === null, 'no arms at all is null, not a fabricated winner');
}

{
  // Each arm is scored against its OWN before-text. The wrapped arm's envelope
  // is not a cost the harness gets to charge it.
  const arms = {
    raw: arm('y'.repeat(500), 'x'.repeat(1000)),
    wrapped: arm('y'.repeat(600), 'x'.repeat(2000)),
  };
  const best = bestArm(arms);
  check(best.label === 'wrapped' && best.ratio === 0.3, 'each arm is scored on its own denominator', `${best.label} ${best.ratio}`);
}

{
  // An arm with no before-text has no ratio. Treating that as 1.0 would rank
  // an unmeasurable arm alongside one that honestly achieved nothing.
  const best = bestArm({ unmeasurable: arm('anything', ''), real: arm('y'.repeat(900), BEFORE) });
  check(best.label === 'real', 'an arm with no denominator is skipped, not scored 1.0', best.label);
}

{
  // The unit is injected, and it decides the winner. These two arms disagree:
  // `terse` is shorter in characters, `dense` is shorter in words. A caller
  // that asks for the wrong unit gets the wrong arm, so the unit is required
  // to travel with the question rather than being assumed.
  const arms = { terse: arm('a b c d e f', BEFORE), dense: arm('aaaaaaaaaaaaaa', BEFORE) };
  const byChar = bestArm(arms, { size: (s) => s.length });
  const byWord = bestArm(arms, { size: (s) => s.split(/\s+/).filter(Boolean).length });
  check(byChar.label === 'terse', 'on characters the shorter string wins', `${byChar.label} ${byChar.ratio}`);
  check(byWord.label === 'dense', 'on a token-like unit the other arm wins instead', `${byWord.label} ${byWord.ratio}`);
  check(
    byChar.label !== byWord.label,
    'so the unit really does decide the winner, and must not be defaulted silently'
  );
}

console.log(failures === 0 ? '\nall checks pass' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
