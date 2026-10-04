/**
 * KNOWN ANSWERS FOR THE COMPETITOR-HEALTH GATE.
 *
 * Every case here is a provenance block whose right answer is a matter of
 * reading, not of measurement: either the capture said their engine was whole,
 * or it said it was not, or it did not say. The gate must separate the three,
 * and must never read the third as the first.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ADVISORY_SIGNATURES, degradationRefusal } from './competitor-health.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
let failures = 0;
function check(ok, what, detail) {
  if (ok) {
    console.log(`ok   ${what}`);
  } else {
    failures += 1;
    console.log(`FAIL ${what}${detail === undefined ? '' : ` -- ${detail}`}`);
  }
}

const entry = (message, logger = 'headroom.transforms.content_router', count = 1) => ({
  message,
  logger,
  count,
});
const clean = { competitorWarnings: { degraded: [], advisory: [] } };

// 1. THE THREE STATES, SEPARATED.
{
  check(degradationRefusal(clean) === null, 'a capture that recorded no warnings is accepted');

  const said = {
    competitorWarnings: {
      degraded: [entry('Kompress model not ready; requests will not be compressed', 'headroom.transforms.content_router', 6)],
      advisory: [],
    },
  };
  const r = degradationRefusal(said);
  check(
    typeof r === 'string' && r.includes('Kompress model not ready') && r.includes('6x'),
    'a recorded degradation is refused, named, and counted',
    r
  );

  const silent = { headroomVersion: '0.37.0' };
  const s = degradationRefusal(silent);
  check(
    typeof s === 'string' && /predates degradation recording/.test(s),
    'a capture that never recorded warnings is refused, not read as whole',
    s
  );
}

// 2. NOTHING AT ALL IS NOT NOTHING WRONG.
for (const bad of [null, undefined, 'clean', 42, [], [{ degraded: [] }]]) {
  const r = degradationRefusal(bad);
  check(
    typeof r === 'string' && r.length > 0,
    `a provenance of ${JSON.stringify(bad) ?? 'undefined'} is refused`,
    r
  );
}

// 3. THE RECORDED SHAPE IS PART OF THE CLAIM. A block that carries the key but
// not the two arrays cannot be read, and a gate that reads it as empty passes
// every capture forever.
for (const shape of [
  null,
  'none',
  [],
  {},
  { degraded: [] },
  { advisory: [] },
  { degraded: {}, advisory: [] },
  { degraded: [], advisory: 'none' },
]) {
  const r = degradationRefusal({ competitorWarnings: shape });
  check(
    typeof r === 'string' && /not in the recorded shape/.test(r),
    `competitorWarnings of ${JSON.stringify(shape) ?? 'null'} is refused as unreadable`,
    r
  );
}

// 4. AN ENTRY THAT CANNOT BE READ IS NOT AN ENTRY THAT SAYS NOTHING.
{
  for (const broken of [
    {},
    { message: '', logger: 'headroom', count: 1 },
    { message: 'x', logger: '', count: 1 },
    { message: 'x', logger: 'headroom' },
    { message: 'x', logger: 'headroom', count: 0 },
    { message: 'x', logger: 'headroom', count: 1.5 },
    { message: 'x', logger: 'headroom', count: '3' },
    'Kompress model not ready',
  ]) {
    const r = degradationRefusal({ competitorWarnings: { degraded: [broken], advisory: [] } });
    check(
      typeof r === 'string' && r.startsWith('1 thing(s)'),
      `an unreadable degraded entry ${JSON.stringify(broken)} is still a refusal`,
      r
    );
    const a = degradationRefusal({ competitorWarnings: { degraded: [], advisory: [broken] } });
    check(
      typeof a === 'string' && a.startsWith('1 thing(s)'),
      `an unreadable advisory entry ${JSON.stringify(broken)} is a refusal too`,
      a
    );
  }
}

// 5. THE ALLOW-LIST IS NOT SELF-CERTIFYING. An advisory the capture waved
// through and this file does not recognise is a degradation.
{
  const known = degradationRefusal({
    competitorWarnings: {
      degraded: [],
      advisory: [
        entry(
          'CacheAligner: detected volatile content in system prompt (iso8601=1); cache prefix unstable.',
          'headroom.transforms.cache_aligner',
          12
        ),
      ],
    },
  });
  check(known === null, 'a recognised advisory is accepted', known);

  const invented = degradationRefusal({
    competitorWarnings: {
      degraded: [],
      advisory: [entry('tree-sitter unavailable; signatures will not be extracted')],
    },
  });
  check(
    typeof invented === 'string' && /does not recognise it/.test(invented),
    'an advisory this gate does not recognise is refused, so the capture cannot widen its own allow-list',
    invented
  );
}

// 5b. A RECOGNISED MESSAGE IS NOT A READABLE ENTRY. This is the case the
// other advisory tests cannot separate: they use messages the gate does not
// recognise, so an entry is refused for its message and the state of its
// count never decides anything. A count of zero on an allow-listed message is
// how a degradation gets written down and not counted.
{
  const zeroCount = degradationRefusal({
    competitorWarnings: {
      degraded: [],
      advisory: [
        entry(
          'CacheAligner: cache prefix unstable.',
          'headroom.transforms.cache_aligner',
          0
        ),
      ],
    },
  });
  check(
    typeof zeroCount === 'string' && /unreadable entry/.test(zeroCount),
    'an allow-listed advisory with a count of zero is refused as unreadable, not accepted',
    zeroCount
  );
}

// 6. AND THE TWO LISTS ARE THE SAME LIST. The whole point of mirroring the
// signatures is defeated if the mirror drifts, so it is compared to the
// capture's own source rather than trusted.
{
  const source = readFileSync(join(HERE, 'headroom', 'run-theirs.py'), 'utf8');
  const block = /ADVISORY_SIGNATURES = \(([^)]*)\)/.exec(source);
  const theirs = block === null ? [] : [...block[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  check(theirs.length > 0, 'the capture declares an advisory allow-list this check can read', String(theirs.length));
  check(
    theirs.length === ADVISORY_SIGNATURES.length &&
      theirs.every((signature) => ADVISORY_SIGNATURES.includes(signature)),
    'the gate mirrors the capture allow-list exactly, in both directions',
    `capture ${JSON.stringify(theirs)} vs gate ${JSON.stringify(ADVISORY_SIGNATURES)}`
  );
}

// 7. SEVERAL PROBLEMS ARE ALL REPORTED, because a gate that stops at the first
// one hides how much of the capture is unusable.
{
  const r = degradationRefusal({
    competitorWarnings: {
      degraded: [entry('Kompress model not ready', 'headroom.transforms.content_router', 6), entry('native detector off')],
      advisory: [entry('something new they added')],
    },
  });
  check(
    typeof r === 'string' && r.startsWith('3 thing(s)'),
    'all three problems are counted, not just the first',
    r
  );
}

console.log(failures === 0 ? 'all checks passed' : `${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
