/**
 * MERGING CHUNKS, ON CASES WHOSE ANSWER IS KNOWN IN ADVANCE.
 *
 * The decision under test assembles ONE published capture out of several runs, so
 * its failure mode is a file that reads as complete and is not. Every refusal
 * below corresponds to a way that has already happened somewhere in this harness:
 * a capture compared against another taken with a different instrument, a green
 * gate that ran no tests, a total computed over a set nobody checked the size of.
 *
 * The cases that carry the weight:
 *
 *  - `a gap is refused` -- three chunks of a four-way split merge into a file
 *    short a workload, and every other field looks right.
 *  - `an overlap is refused` -- the converse, which double-counts a row.
 *  - `a different instrument is refused` -- the hr6/hr7 lesson: two captures of
 *    their engine with different capabilities are not one capture.
 *  - `a chunk that does not hold what it claims is refused` -- coverage is checked
 *    against the DECLARATIONS, so this is the hole coverage cannot see.
 *  - `the ages survive the merge per workload` -- the whole reason for chunking.
 */

import { instrumentFingerprint } from './ratchet.mjs';
import { mergeChunks, mergePayloads } from './chunk-merge.mjs';

let failures = 0;
const check = (cond, what, detail) => {
  if (cond) console.log(`ok   ${what}${detail === undefined ? '' : ` -- ${detail}`}`);
  else {
    failures += 1;
    console.log(`FAIL ${what}${detail === undefined ? '' : ` -- ${detail}`}`);
  }
};

const ROSTER = ['alpha', 'bravo', 'charlie', 'delta'];

/** One chunk, with every field the merge reads, and nothing it does not. */
const chunk = (index, names, over = {}) => ({
  dir: `hrc${index}`,
  theirs: {
    __provenance__: {
      headroomVersion: '0.37.0',
      python: '3.12.1',
      theirFixtures: true,
      detectBackend: 'rust',
      detectBackendPreset: null,
      stubArms: null,
      roster: ROSTER,
      chunk: { selector: `--chunk ${index}/2`, index, of: 2, names },
      sweepStartedAt: 1000 + index * 100,
      sweptAt: 1050 + index * 100,
      sweptAtIso: `2026-09-27T0${index}:00:00`,
      sweptPerWorkload: Object.fromEntries(names.map((n, i) => [n, 1000 + index * 100 + i])),
      loadWitness: { ms: 40 + index, readings: names.map(() => ({ at: 'before-pass-0', ms: 40 + index })), errors: [], script: 'compression/load-witness.mjs' },
      // CONTINUOUS BY CONSTRUCTION: chunk N starts from what chunk N-1 left, which is
      // what the merge expects and what the break case below deliberately violates.
      ccrStoreBeforeRun: {
        bytes: 100 * (index - 1),
        entries: 10 * (index - 1),
        liveEntries: 10 * (index - 1),
        sha256: `sha${index - 1}`,
      },
      ccrStoreAfterRun: { bytes: 100 * index, entries: 10 * index, liveEntries: 10 * index, sha256: `sha${index}` },
      carriedPayloads: names.slice(0, 1),
      inertArms: { router: { ranOn: names.length, returnedInputUnchanged: 1 } },
      competitorWarnings: { degraded: [], advisory: [{ message: 'advice', count: index }] },
      kompressWarmup: { ready: true, waitedSeconds: 10 * index, why: null },
      ...over,
    },
    ...Object.fromEntries(names.map((n) => [n, { before: 100, after: 50, arm: 'router' }])),
  },
  resolved: {
    __provenance__: {
      resolvedAt: 1060 + index * 100,
      resolvedAtIso: `2026-09-27T0${index}:01:00`,
      entryAgeSeconds: Object.fromEntries(names.map((n, i) => [n, 20 + i])),
      theirStatedTtlSeconds: null,
      elapsedSecondsOldestEntry: 25,
      elapsedSeconds: 10,
      ageBasis: 'oldest-entry',
      pastTheirTtl: false,
    },
    ...Object.fromEntries(names.map((n) => [n, { text: n, markers: 2, unresolved: 0 }])),
  },
});

const two = () => [chunk(1, ['alpha', 'bravo']), chunk(2, ['charlie', 'delta'])];
const why = (r) => r.errors.join(' | ');

console.log('two disjoint chunks that tile the roster merge');
{
  const r = mergeChunks(two());
  check(r.ok === true, 'the happy path merges', why(r));
  check(
    Object.keys(r.theirs).filter((k) => !k.startsWith('__')).length === 4,
    'all four workloads are present'
  );
  check(r.theirs.__provenance__.chunk === null, 'the merged file is not itself a chunk');
  check(r.theirs.__provenance__.mergedFromChunks === 2, 'and says how many it came from');
  check(r.theirs.__provenance__.sweepStartedAt === 1100, 'the sweep starts at the earliest chunk');
  check(r.theirs.__provenance__.sweptAt === 1250, 'and ends at the latest');
}

console.log('\na gap is refused');
{
  const r = mergeChunks([chunk(1, ['alpha', 'bravo']), chunk(2, ['charlie'])]);
  check(r.ok === false, 'three of four workloads is not a capture', why(r));
  check(why(r).includes('delta'), 'and the missing one is named', why(r));
}

console.log('\nan overlap is refused');
{
  const r = mergeChunks([chunk(1, ['alpha', 'bravo']), chunk(2, ['bravo', 'charlie', 'delta'])]);
  check(r.ok === false, 'a workload in two chunks is not merged', why(r));
  check(why(r).includes('bravo is claimed by both'), 'and the duplicate is named', why(r));
}

console.log('\na different instrument is refused');
{
  const parts = two();
  parts[1].theirs.__provenance__.detectBackend = 'python';
  const r = mergeChunks(parts);
  check(r.ok === false, 'two detector backends are two engines', why(r));
  check(why(r).includes('detectBackend differs'), 'and the field is named', why(r));

  const ver = two();
  ver[1].theirs.__provenance__.headroomVersion = '0.38.0';
  check(mergeChunks(ver).ok === false, 'so are two engine versions', why(mergeChunks(ver)));

  // AND SO ARE TWO SERIALISATIONS. `--separators` changes the bytes handed to
  // both engines, not the engine, which is exactly why a merge across it would
  // look harmless: every version and backend field still agrees.
  const sep = two();
  sep[0].theirs.__provenance__.payloadSeparators = 'default';
  sep[1].theirs.__provenance__.payloadSeparators = 'compact';
  const sr = mergeChunks(sep);
  check(sr.ok === false, 'so are two payload serialisations', why(sr));
  check(why(sr).includes('payloadSeparators differs'), 'and that field is named too', why(sr));

  // THE CONTROL FOR THE CASE ABOVE. A pair that agrees on the new field must
  // still merge, or the check would pass for the wrong reason -- any refusal
  // at all would satisfy it.
  const same = two();
  same[0].theirs.__provenance__.payloadSeparators = 'compact';
  same[1].theirs.__provenance__.payloadSeparators = 'compact';
  check(mergeChunks(same).ok === true, 'two chunks that agree on it still merge', why(mergeChunks(same)));
}

console.log('\na chunk that does not hold what it claims is refused');
{
  const parts = two();
  delete parts[1].theirs.delta;
  const r = mergeChunks(parts);
  check(r.ok === false, 'a declared workload with no row refuses', why(r));
  check(why(r).includes('missing delta'), 'and says which row is absent', why(r));
}

console.log('\na whole-sweep capture is not a chunk');
{
  const parts = two();
  parts[1].theirs.__provenance__.chunk = null;
  const r = mergeChunks(parts);
  check(r.ok === false, 'mixing one in would double-count', why(r));
  check(why(r).includes('WHOLE-sweep'), 'and it is named as such', why(r));

  const old = two();
  delete old[1].theirs.__provenance__.chunk;
  check(mergeChunks(old).ok === false, 'a capture predating chunking is refused too');
  const noRoster = two();
  delete noRoster[1].theirs.__provenance__.roster;
  check(mergeChunks(noRoster).ok === false, 'so is one that records no roster');
}

console.log('\na known-answer capture is refused, as it is everywhere else');
{
  const parts = two();
  parts[1].theirs.__provenance__.stubArms = 'bench/ka-arms.py';
  const r = mergeChunks(parts);
  check(r.ok === false, 'it measures the harness, not an engine', why(r));
}

console.log('\nthe declared split size is its own check');
{
  // The coverage check above is satisfied here: these two chunks tile the roster.
  // What is wrong is that they say they are two of THREE, so a third exists and
  // was not passed -- and the roster they tile is the one they agreed on, which a
  // hand-edited chunk can also agree on.
  const parts = two();
  for (const p of parts) p.theirs.__provenance__.chunk.of = 3;
  const r = mergeChunks(parts);
  check(r.ok === false, 'two chunks of a three-way split refuse', why(r));
  check(why(r).includes('3-way split'), 'and the shortfall is named', why(r));

  const disagree = two();
  disagree[1].theirs.__provenance__.chunk.of = 3;
  check(mergeChunks(disagree).ok === false, 'chunks disagreeing on the count refuse');
}

console.log('\nthe entry ages survive the merge per workload');
{
  // THE REASON THE SWEEP IS CHUNKED AT ALL. `resolutionUsable` decides one row at
  // a time from this map, so a merge that collapsed it to one number would put
  // every row back on the oldest entry -- the exact defect chunking exists to fix.
  const r = mergeChunks(two());
  const ages = r.resolved.__provenance__.entryAgeSeconds;
  check(Object.keys(ages).length === 4, 'every workload keeps its own age', JSON.stringify(ages));
  check(ages.alpha === 20 && ages.delta === 21, 'and the values are its own', JSON.stringify(ages));
}

console.log('\na bound one chunk was told applies to all of them');
{
  // Their TTL is a property of their store, and a chunk that was never refused
  // anything quotes nothing. Letting the absent quote win would erase the only
  // bound in the run -- and `resolutionUsable` refuses a late row ONLY when a
  // bound is present, so erasing it turns every late row back into their loss.
  const parts = two();
  parts[0].resolved.__provenance__.theirStatedTtlSeconds = 1800;
  parts[0].resolved.__provenance__.pastTheirTtl = true;
  const r = mergeChunks(parts);
  check(r.resolved.__provenance__.theirStatedTtlSeconds === 1800, 'the quoted bound survives');
  check(r.resolved.__provenance__.pastTheirTtl === true, 'and one late chunk makes the run late');
  check(
    r.resolved.__provenance__.elapsedSecondsOldestEntry === 25,
    'the fallback age is the worst across chunks, not the newest'
  );
}

console.log('\nthe seam is recorded, not smoothed over');
{
  const r = mergeChunks(two());
  const seam = r.theirs.__provenance__.chunkSeam;
  check(seam.warmupsPaid === 2, 'each chunk paid its own warm-up and the file says so');
  check(seam.storeGrewBetweenChunks === true, 'their store grew between chunks', '10 -> 20 live entries');
  check(seam.chunks.length === 2, 'and every chunk is listed with its own store state');
  check(
    seam.chunks[0].ccrStoreAfterRun.sha256 === 'sha1' && seam.chunks[1].ccrStoreAfterRun.sha256 === 'sha2',
    'so a pipeline row can be told which store it ran against'
  );
  // A store that did NOT grow is the comparable case, and must not be reported as
  // if it had -- the flag is a fact about this capture, not a property of chunking.
  const same = two();
  same[1].theirs.__provenance__.ccrStoreAfterRun = { bytes: 100, entries: 10, liveEntries: 10, sha256: 'sha1' };
  check(
    mergeChunks(same).theirs.__provenance__.chunkSeam.storeGrewBetweenChunks === false,
    'an unchanged store is reported unchanged'
  );
  // THE WAL CASE, and the reason neither store field is keyed on the digest. SQLite
  // keeps committed rows in `ccr_store.db-wal` until it checkpoints, so the db file's
  // digest moves with the store unchanged: measured between two of our own processes
  // on this capture, 913408 bytes / sha 485cfcc04a1715ae left by chunk 1 and the same
  // 913408 bytes / sha 18b2b9f548c3566d read by chunk 2. Keyed on the digest this
  // reads as growth on every chunked capture.
  const checkpointed = two();
  checkpointed[1].theirs.__provenance__.ccrStoreAfterRun = {
    bytes: 100,
    entries: 10,
    liveEntries: 10,
    sha256: 'checkpointed-since',
  };
  check(
    mergeChunks(checkpointed).theirs.__provenance__.chunkSeam.storeGrewBetweenChunks === false,
    'a checkpoint is not growth',
    'same rows, different digest'
  );
}

console.log('\nthe pooled witness names which chunk each reading came from');
{
  const r = mergeChunks(two());
  const w = r.theirs.__provenance__.loadWitness;
  check(w.readings.length === 4, 'every reading is kept', String(w.readings.length));
  check(
    w.readings.every((x) => x.at.startsWith('--chunk ')),
    'and carries its chunk, so the label still identifies a moment',
    w.readings[0].at
  );
  check(w.ms === 42, 'the median is taken over the pooled readings', String(w.ms));
}

console.log('\nthe additive provenance is added, not re-derived');
{
  const r = mergeChunks(two());
  const p = r.theirs.__provenance__;
  // Both counts are per workload and the chunks are disjoint, so the sum is what a
  // single sweep would have computed. Re-deriving the rule in a second language is
  // how the two would drift.
  check(p.inertArms.router.ranOn === 4, 'inert-arm denominators sum', JSON.stringify(p.inertArms));
  check(p.inertArms.router.returnedInputUnchanged === 2, 'and so do the numerators');
  check(p.kompressWarmup.ready === true, 'two warm chunks are a warm capture');
  check(p.kompressWarmup.waitedSeconds === 30, 'and the waits sum', String(p.kompressWarmup.waitedSeconds));
  check(p.competitorWarnings.advisory[0].count === 3, 'warning counts sum per message');
  check(p.carriedPayloads.join(',') === 'alpha,charlie', 'carried payloads union', p.carriedPayloads.join(','));

  // ONE COLD CHUNK DEGRADES THE CAPTURE IT IS PART OF. instrumentFingerprint reads
  // this single boolean, so a merged file that reported `ready` because most chunks
  // were warm would let a ratchet entry be inherited across a changed instrument.
  const cold = two();
  cold[1].theirs.__provenance__.kompressWarmup = { ready: false, waitedSeconds: 240, why: 'download' };
  const c = mergeChunks(cold).theirs.__provenance__.kompressWarmup;
  check(c.ready === false, 'one cold chunk makes the capture not-ready', JSON.stringify(c.why));
  check(String(c.why).includes('download'), 'and the reason names its chunk', String(c.why));
}

console.log('\na chunk with no resolution is named, not quietly dropped');
{
  const parts = two();
  parts[1].resolved = null;
  const r = mergeChunks(parts);
  check(r.ok === true, 'the merge still succeeds -- an unresolved chunk is a known state');
  check(
    r.theirs.__provenance__.chunkSeam.chunksWithoutResolution.join(',') === 'hrc2',
    'and the chunk is listed'
  );
  check(
    r.resolved.charlie === undefined,
    'its rows have no resolution, which the scorer reads as unmeasured'
  );
}

console.log('\npayload sets union, and a collision refuses');
{
  const ok = mergePayloads([
    { dir: 'a', data: { alpha: 'x' } },
    { dir: 'b', data: { bravo: 'y' } },
  ]);
  check(ok.errors.length === 0 && Object.keys(ok.out).length === 2, 'disjoint sets union');
  const clash = mergePayloads([
    { dir: 'a', data: { alpha: 'x' } },
    { dir: 'b', data: { alpha: 'DIFFERENT' } },
  ]);
  check(clash.errors.length === 1, 'two different bytes for one name refuse', clash.errors[0]);
}


console.log('\ntheir store is stamped at both ends of the capture, and between chunks');
{
  // THE INPUT THIS CAPTURE DELIBERATELY VARIES. Their `pipeline@*` arms read a
  // durable store, so which state a row was measured against is part of the
  // measurement -- and an after-stamp alone cannot say it, because every sweep
  // ends with its own entries in there.
  const p = mergeChunks(two()).theirs.__provenance__;
  check(p.ccrStoreBeforeRun?.sha256 === 'sha0', 'the whole run begins where its first chunk began', p.ccrStoreBeforeRun?.sha256);
  check(p.ccrStoreAfterRun?.sha256 === 'sha2', 'and ends where its last chunk left off', p.ccrStoreAfterRun?.sha256);
  const pairs = p.chunkSeam.chunks.map((c) => `${c.ccrStoreBeforeRun?.sha256}->${c.ccrStoreAfterRun?.sha256}`).join(' ');
  check(pairs === 'sha0->sha1 sha1->sha2', 'each chunk keeps its own pair', pairs);
  check(p.chunkSeam.storeGrewBetweenChunks === true, 'the growth is named');
  check(p.chunkSeam.storeContinuousBetweenChunks === true, "and the growth is this run's own");
}
{
  // A THIRD PARTY WROTE TO THEIR STORE MID-CAPTURE. Chunk 2 did not start from
  // what chunk 1 left, so its rows were measured against a state nothing in the
  // merged file describes. Invisible in the numbers, so it is named rather than
  // refused: the rows are still what they are, and a reader has to be told.
  const parts = two();
  parts[1].theirs.__provenance__.ccrStoreBeforeRun = {
    bytes: 999,
    entries: 99,
    liveEntries: 99,
    sha256: 'someone-else',
  };
  const r = mergeChunks(parts);
  check(r.errors.length === 0, 'the merge still produces a file -- this is a fact, not a refusal', why(r));
  const broke = r.theirs.__provenance__.chunkSeam.storeContinuousBetweenChunks;
  check(Array.isArray(broke) && broke.length === 1, 'the break is reported', JSON.stringify(broke));
  check(
    String(broke).includes('99') && String(broke).includes('left 10'),
    'naming both the state it found and the one it should have',
    String(broke)
  );
}
{
  // A FALL IS NOT A BREAK, and this is the case that makes the rule one-sided. Their
  // `sqlite.py` deletes `created_at + ttl < now` on every open, their ttl is 1800s and
  // a chunk takes roughly twelve minutes, so by chunk 4 the rows chunk 1 wrote are
  // gone. Nothing in the stamp separates that from a third party deleting rows -- but
  // reporting it as a break would fire on every capture long enough to cross their
  // ttl, and a detector that fires on every capture cannot report the real case.
  const expired = two();
  expired[1].theirs.__provenance__.ccrStoreBeforeRun = {
    bytes: 100,
    entries: 10,
    liveEntries: 3,
    sha256: 'sha1',
  };
  check(
    mergeChunks(expired).theirs.__provenance__.chunkSeam.storeContinuousBetweenChunks === true,
    'entries expiring between chunks is not a third party',
    '10 left, 3 still live'
  );
  // Their whole store purged away, by their own hygiene or by a `rm`: still a fall.
  const gone = two();
  gone[1].theirs.__provenance__.ccrStoreBeforeRun = { present: false, bytes: 0, sha256: null };
  check(
    mergeChunks(gone).theirs.__provenance__.chunkSeam.storeContinuousBetweenChunks === true,
    'and neither is an absent store file, which needs no count to read as zero'
  );
}
{
  // A FILE THAT IS THERE WITH NO LIVE COUNT IS NOT A VERDICT EITHER. This is the shape
  // the byte-only stamp wrote, and it is the one case where guessing has a direction:
  // reading it as continuous would inherit a claim about a store nobody counted.
  const uncounted = two();
  uncounted[1].theirs.__provenance__.ccrStoreBeforeRun = { present: true, bytes: 3866624, sha256: 'ca9' };
  const seam = mergeChunks(uncounted).theirs.__provenance__.chunkSeam;
  check(
    seam.storeContinuousBetweenChunks === null,
    'an uncounted store file yields no continuity verdict',
    JSON.stringify(seam.storeContinuousBetweenChunks)
  );
}
{
  // AN UNSTAMPED CHUNK IS NOT A BREAK. A capture taken before run-theirs.py
  // stamped the start has nothing to compare, and claiming continuity there would
  // be the flattering direction -- so the verdict is null, which is neither.
  const parts = two();
  delete parts[1].theirs.__provenance__.ccrStoreBeforeRun;
  const r = mergeChunks(parts);
  check(
    r.theirs.__provenance__.chunkSeam.storeContinuousBetweenChunks === null,
    'an unstamped chunk yields no verdict',
    JSON.stringify(r.theirs.__provenance__.chunkSeam.storeContinuousBetweenChunks)
  );
}

console.log('');
console.log('the store state a merged capture may claim');
{
  // THE MERGED STAMP IS WHAT THE FINGERPRINT READS, so these assert through it
  // rather than through the field. The bug this covers shipped: the merged record
  // took chunk 1's before-stamp, and in a default chunked sweep chunk 1 is the one
  // chunk that started from nothing, so a mixed run was published as `store=empty`.
  const setStores = (parts, lives) => {
    parts.forEach((part, i) => {
      part.theirs.__provenance__.ccrStoreBeforeRun =
        lives[i] === null
          ? { path: 'p', present: false, bytes: 0, entries: 0, liveEntries: 0, sha256: null }
          : { path: 'p', present: true, bytes: 4096, entries: lives[i], liveEntries: lives[i], sha256: 'x' };
    });
    return parts;
  };
  const term = (lives) => {
    const r = mergeChunks(setStores(two(), lives));
    check(r.errors.length === 0, 'the merge produced a file', why(r));
    return instrumentFingerprint(r.theirs.__provenance__);
  };

  check(term([0, 0]).endsWith(' store=empty'), 'both chunks empty makes an empty capture', term([0, 0]));
  check(
    term([7, 4]).endsWith(' store=warm'),
    'both warm makes a warm one -- the counts need not match',
    term([7, 4])
  );

  // THE CASE THE OLD CODE GOT WRONG, in both of its shapes. A capture whose chunks
  // disagree has no single state to attribute a difference to, and the honest term
  // says so rather than picking the gentler of the two states.
  const mixed = term([0, 10]);
  check(mixed.endsWith(' store=unrecorded'), 'a mixed capture claims neither state', mixed);
  check(!mixed.includes('store=empty'), 'and does not inherit chunk 1 and call the run empty', mixed);
  check(
    term([10, 0]).endsWith(' store=unrecorded'),
    'mixed the other way round too, so the rule is not about chunk order',
    term([10, 0])
  );

  // THE SHORT-CIRCUIT. `present: false` is read as empty BEFORE any count, so a
  // mixed capture whose first chunk had no store file has to stop claiming that
  // file or the count-based refusal above never runs at all.
  check(
    term([null, 10]).endsWith(' store=unrecorded'),
    'an absent file on chunk 1 does not make a mixed capture empty',
    term([null, 10])
  );

  // AND THE MIX IS NAMED, because `unrecorded` alone tells a reader the stamp was
  // unusable, not that the sweep design was what made it so.
  const named = mergeChunks(setStores(two(), [0, 10])).theirs.__provenance__.ccrStoreBeforeRun;
  check(
    Array.isArray(named.mixedAcrossChunks) && named.mixedAcrossChunks.length === 2,
    'the merged stamp lists each chunk state',
    JSON.stringify(named.mixedAcrossChunks)
  );
  check(
    named.mixedAcrossChunks.some((e) => e.state === 'empty') &&
      named.mixedAcrossChunks.some((e) => e.state === 'warm'),
    'naming both states it found'
  );

  // A STORE FILE WITH NO COUNT IS A THIRD STATE, and hr28 is why this case exists:
  // its chunk 1 recorded `present: false` while chunks 2 to 6 recorded 913408 bytes
  // and up with no count, because they were swept before this stamp counted rows.
  // Treating those as comparable-to-nothing and keeping chunk 1 would publish that
  // capture as an empty-store sweep, which is exactly the claim it cannot support.
  const noCount = setStores(two(), [0, 10]);
  delete noCount[1].theirs.__provenance__.ccrStoreBeforeRun.liveEntries;
  const kept = instrumentFingerprint(mergeChunks(noCount).theirs.__provenance__);
  check(kept.endsWith(' store=unrecorded'), 'an uncounted chunk is not an empty one', kept);

  // AND UNANIMITY DOES NOT RESCUE IT EITHER. Every chunk holding a store file with
  // no count is unanimous about nothing; the count is the thing under discussion.
  const noneCounted = setStores(two(), [5, 10]);
  for (const part of noneCounted) delete part.theirs.__provenance__.ccrStoreBeforeRun.liveEntries;
  const allUnknown = instrumentFingerprint(mergeChunks(noneCounted).theirs.__provenance__);
  check(allUnknown.endsWith(' store=unrecorded'), 'uncounted throughout is still unrecorded', allUnknown);

  // THE INHERITANCE PROMISE, which this whole rule must not break. A capture from
  // before the stamp existed has no store field on any chunk, so there is nothing to
  // disagree about: it gets NO store term, and every pass recorded against it stands.
  const unstamped = two();
  for (const part of unstamped) delete part.theirs.__provenance__.ccrStoreBeforeRun;
  const bare = instrumentFingerprint(mergeChunks(unstamped).theirs.__provenance__);
  check(!bare.includes('store='), 'an unstamped capture gets no store term at all', bare);
}

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
