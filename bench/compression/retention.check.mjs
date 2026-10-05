/**
 * THE RETENTION CLASSIFICATION, CHECKED WHERE THE ANSWER IS KNOWN IN ADVANCE.
 *
 * Every case is synthetic and offline. No fixture is read, no engine runs, and
 * nothing here depends on the day -- which is the point: the real head-to-head
 * takes minutes and produces numbers nobody can check by inspection, so the
 * part of it that is arithmetic gets checked separately on inputs that state
 * their own answer.
 *
 * THE CASE THAT MATTERS MOST IS THE POSITIVE CONTROL. `inSpill` was 0 on all
 * twelve published workloads, and 0 is ambiguous between "the arm evicted
 * nothing" and "the branch cannot fire". Until something proves the branch
 * fires, every zero in that column is unreadable. So one case here hands the
 * classifier a spill that certainly contains an id the output certainly lacks
 * and demands a 1. With that armed, a null means no sink and a zero means no
 * eviction, and neither can mean a broken probe.
 */

import { classifyIds } from './retention.mjs';

let failures = 0;
// CONDITION FIRST, matching `cost-split.check.mjs`. The sibling file
// `calibrate.check.mjs` takes the name first, and a helper whose argument order
// you have to remember is one that silently passes: declared name-first and
// called condition-first, `ok` binds to the message string, which is always
// truthy, and every case reports success without evaluating anything. That
// happened here. The self-test below is what caught it, and it stays.
const check = (ok, name, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` -- ${detail}` : ''}`);
};

// THE HELPER CHECKS ITSELF FIRST. If `check` cannot report a failure, nothing
// below it means anything, so this runs before any real case and is the one
// place the counter is allowed to go up and come back down.
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

/** Ids are 8+ chars with a digit, matching the shape the fixtures actually use. */
const id = (n) => `trace_${String(n).padStart(8, '0')}`;
const IDS = [id(1), id(2), id(3), id(4)];

// ---------------------------------------------------------------------------
// 1. The positive control. Everything else is unreadable without it.
// ---------------------------------------------------------------------------

{
  const r = classifyIds({
    ids: IDS,
    output: `kept ${id(1)}`,
    reconstructed: '',
    spill: `evicted block holding ${id(2)} and ${id(3)}`,
    hasSink: true,
  });
  check(
    r.inSpill === 2 && r.inOut === 1 && r.gone === 1,
    'the spill branch fires when a sink exists and holds the id',
    `inOut ${r.inOut}, inSpill ${r.inSpill}, gone ${r.gone}`
  );
}

{
  // The same inputs with the sink taken away. The two ids in the spill are now
  // genuinely gone -- there is nowhere for them to have gone TO -- and the
  // column must refuse to report a number rather than reporting zero.
  const r = classifyIds({
    ids: IDS,
    output: `kept ${id(1)}`,
    spill: `evicted block holding ${id(2)} and ${id(3)}`,
    hasSink: false,
  });
  check(
    r.inSpill === null && r.gone === 3,
    'a sinkless arm reports null, not a zero it never measured',
    `inSpill ${r.inSpill}, gone ${r.gone}`
  );
}

{
  // And the other half of the distinction: a sink that was offered and evicted
  // nothing is a real zero, and must not be confused with the null above.
  const r = classifyIds({ ids: IDS, output: IDS.join(' '), spill: '', hasSink: true });
  check(
    r.inSpill === 0 && r.inOut === 4 && r.gone === 0,
    'a sink that evicted nothing is a measured zero, distinct from null',
    `inSpill ${r.inSpill}`
  );
}

// ---------------------------------------------------------------------------
// 2. The cheapest-first ordering, which decides what a survivor costs.
// ---------------------------------------------------------------------------

{
  // Present literally AND sitting in a spilled block. It is free, not one Read
  // away, so it must land in `inOut`; scoring it as spill would invent a round
  // trip the agent never makes and understate the arm.
  const r = classifyIds({
    ids: [id(1)],
    output: `still here: ${id(1)}`,
    spill: `also evicted: ${id(1)}`,
    hasSink: true,
  });
  check(
    r.inOut === 1 && r.inSpill === 0,
    'an id that is both present and spilled is free, not a round trip',
    `inOut ${r.inOut}, inSpill ${r.inSpill}`
  );
}

{
  // Reconstruction is free too, but only ranks above spill -- never above a
  // literal, or the two free columns would trade places run to run.
  const r = classifyIds({
    ids: [id(1), id(2)],
    output: `literal ${id(1)}`,
    reconstructed: `decoded ${id(1)} ${id(2)}`,
    hasSink: true,
  });
  check(
    r.inOut === 1 && r.derived === 1 && r.zeroTurn === 2,
    'a literal outranks its own reconstruction, and both are zero-turn',
    `inOut ${r.inOut}, derived ${r.derived}, zeroTurn ${r.zeroTurn}`
  );
}

// ---------------------------------------------------------------------------
// 3. The denominator. Every bucket must account for every id, exactly once.
// ---------------------------------------------------------------------------

{
  const r = classifyIds({
    ids: IDS,
    output: id(1),
    reconstructed: id(2),
    spill: id(3),
    hasSink: true,
  });
  check(
    r.inOut + r.derived + r.inSpill + r.gone === r.ids && r.ids === 4,
    'the four buckets partition the ids, with nothing counted twice or dropped',
    `${r.inOut}+${r.derived}+${r.inSpill}+${r.gone} = ${r.ids}`
  );
}

{
  // A sinkless arm still has to partition -- with the spill bucket absent
  // rather than zero, the other three must carry every id between them.
  const r = classifyIds({ ids: IDS, output: id(1), reconstructed: id(2), hasSink: false });
  check(
    r.inOut + r.derived + r.gone === r.ids && r.inSpill === null,
    'a sinkless arm partitions across three buckets, not four',
    `${r.inOut}+${r.derived}+${r.gone} = ${r.ids}, inSpill ${r.inSpill}`
  );
}

// ---------------------------------------------------------------------------
// 4. Substring scoring, and the ids too short to be scored that way.
// ---------------------------------------------------------------------------

{
  // The reason scoring is by substring at all: compression reformats, so an id
  // that arrived as a JSON field leaves inside a folded line. Exact-token
  // equality would call that data loss.
  const r = classifyIds({
    ids: [id(7)],
    output: `{"trace":"${id(7)}","n":3}`.replace(/[{}"]/g, ''),
    hasSink: true,
  });
  check(r.inOut === 1, 'reformatting around an id is not data loss', `inOut ${r.inOut}`);
}

{
  // And the price of substring scoring: a short id matches by accident. Those
  // leave the denominator instead of collecting a free pass.
  const r = classifyIds({
    ids: ['a1', 'xy3', id(9)],
    output: 'a1 appears here by coincidence, and so does xy3',
    hasSink: true,
  });
  check(
    r.ids === 1 && r.unsafeIds.length === 2 && r.gone === 1,
    'ids too short to score by substring leave the denominator, visibly',
    `scored ${r.ids}, excluded ${r.unsafeIds.length}, gone ${r.gone}`
  );
}

{
  const r = classifyIds({ ids: [], hasSink: true });
  check(
    r.ids === 0 && r.zeroTurn === 0 && r.gone === 0,
    'a workload with no identifiers is empty, not a perfect score'
  );
}

console.log(failures === 0 ? '\nall checks pass' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
