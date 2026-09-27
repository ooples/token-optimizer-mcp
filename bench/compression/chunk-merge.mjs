/**
 * REASSEMBLING A SWEEP THAT WAS RUN IN CHUNKS -- and refusing to, when the chunks
 * do not describe one run.
 *
 * WHY THE SWEEP IS CHUNKED AT ALL. Their CCR store serves a marker for a bounded
 * time only -- their own resolver quotes "CCR TTL: 1800 seconds" -- and a full
 * roster sweep takes longer than that. The workloads measured FIRST are therefore
 * already unredeemable when the sweep ends, and their retention on those rows
 * reads as a total loss that is really our own sequencing. Chunking fixes the
 * sequencing: each chunk is small enough to be resolved inside the window, by a
 * fresh resolver process, before the next chunk begins.
 *
 * WHAT IT COSTS, which is why each of these facts is recorded rather than
 * smoothed over. A chunked capture is not the same experiment as one sweep:
 *
 *  - their CCR store is durable and GROWS between chunks, so chunk 3 ran against
 *    a store already holding what chunks 1 and 2 put there. Their `pipeline@*`
 *    arms depend on that state -- the same arms that vary by up to 100x between
 *    store states -- so a chunked capture varies an input across its own rows.
 *  - each chunk pays its own model warm-up, and pools its load-witness readings
 *    over its own chunk rather than over the roster.
 *  - the speed passes are separated by a CHUNK-sized sweep instead of a
 *    roster-sized one, so interference outlasting one chunk but not the roster no
 *    longer shows up as a pass disagreeing with its neighbours.
 *
 * None of that is a reason to refuse the merge. All of it is a reason the seam is
 * named in the merged provenance, because a merged file indistinguishable from a
 * single sweep is how a known limitation becomes an unknown one.
 *
 * WHAT IS REFUSED is any set of chunks that cannot be one run: a different engine
 * version, a different detector backend, a roster they disagree on, a gap, an
 * overlap, a chunk whose rows contradict the slice it claims, a whole-sweep
 * capture mixed in among chunks, or a known-answer capture, which measures this
 * harness and not an engine.
 */

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const median = (xs) => (xs.length === 0 ? null : xs.slice().sort((a, b) => a - b)[xs.length >> 1]);

// FACTS THAT MUST BE IDENTICAL ACROSS CHUNKS, because a difference in any of them
// means two engines were measured rather than one. `detectBackend` is on the list
// for the reason ratchet.mjs records: captures hr6 and hr7 timed their Python
// fallback detector and the result was published as their speed.
const MUST_AGREE = [
  'headroomVersion',
  'python',
  'theirFixtures',
  'detectBackend',
  'detectBackendPreset',
];

/**
 * @param {Array<{dir?: string, theirs: object, resolved?: object|null}>} chunks
 * @returns {{ok: boolean, errors: string[], seam: object|null,
 *            theirs: object|null, resolved: object|null}}
 */
export function mergeChunks(chunks) {
  const errors = [];
  const refuse = () => ({ ok: false, errors, seam: null, theirs: null, resolved: null });
  if (!Array.isArray(chunks) || chunks.length === 0) {
    errors.push('no chunks to merge');
    return refuse();
  }

  const parts = [];
  for (const c of chunks) {
    const label = c?.dir ?? '(unnamed)';
    const p = c?.theirs?.__provenance__;
    if (p === undefined || p === null) {
      errors.push(`${label}: no __provenance__, so nothing about how it was taken is known`);
      continue;
    }
    if (!('chunk' in p)) {
      errors.push(`${label}: predates chunking -- it cannot say which slice of the roster it holds`);
      continue;
    }
    // A WHOLE-SWEEP CAPTURE IS NOT A CHUNK. It holds every row, so merging it
    // beside real chunks double-counts the overlap instead of failing, and the
    // duplicate rows silently take whichever value came last.
    if (p.chunk === null) {
      errors.push(`${label}: is a WHOLE-sweep capture, not a chunk -- merging it would double-count`);
      continue;
    }
    if (!Array.isArray(p.roster) || p.roster.length === 0) {
      errors.push(`${label}: records no roster, so completeness cannot be checked at all`);
      continue;
    }
    if (p.stubArms !== null && p.stubArms !== undefined) {
      errors.push(
        `${label}: is a known-answer capture (stubArms ${JSON.stringify(p.stubArms)}) -- ` +
          'it measures this harness, not an engine'
      );
      continue;
    }
    const rows = Object.keys(c.theirs).filter((k) => !k.startsWith('__'));
    const claimed = Array.isArray(p.chunk.names) ? p.chunk.names : [];
    // A CAPTURE MUST HOLD WHAT IT SAYS IT HOLDS. Coverage below is checked against
    // the DECLARATIONS, so a chunk that declares four workloads and carries three
    // merges into a file short one row while every coverage check passes.
    const unclaimed = rows.filter((n) => !claimed.includes(n));
    const short = claimed.filter((n) => !rows.includes(n));
    if (unclaimed.length > 0 || short.length > 0)
      errors.push(
        `${label}: claims ${claimed.length} workload(s) and carries ${rows.length}` +
          (short.length > 0 ? ` -- missing ${short.join(', ')}` : '') +
          (unclaimed.length > 0 ? ` -- carries unclaimed ${unclaimed.join(', ')}` : '')
      );
    parts.push({ label, prov: p, chunk: p.chunk, rows, theirs: c.theirs, resolved: c.resolved ?? null });
  }
  if (parts.length === 0) return refuse();

  // ONE ROSTER, OR NO MERGE. Two chunks cut from different rosters are two
  // different experiments, and coverage computed against either one of them is
  // meaningless.
  const rosters = new Set(parts.map((p) => p.prov.roster.join(',')));
  if (rosters.size > 1) {
    errors.push(
      `the chunks were cut from ${rosters.size} different rosters: ` +
        parts.map((p) => `${p.label} holds ${p.prov.roster.length}`).join('; ')
    );
    return refuse();
  }
  const roster = parts[0].prov.roster;

  for (const field of MUST_AGREE) {
    const seen = new Map();
    for (const p of parts) seen.set(JSON.stringify(p.prov[field] ?? null), p.label);
    if (seen.size > 1)
      errors.push(
        `${field} differs across chunks, so these are not one engine: ` +
          [...seen].map(([v, where]) => `${where}=${v}`).join(', ')
      );
  }

  // EVERY WORKLOAD ONCE. A gap makes a merged capture that is short a row while
  // reading as finished; an overlap makes one whose totals count a row twice.
  const owner = new Map();
  for (const p of parts)
    for (const name of p.chunk.names ?? []) {
      if (owner.has(name)) errors.push(`${name} is claimed by both ${owner.get(name)} and ${p.label}`);
      else owner.set(name, p.label);
    }
  const gaps = roster.filter((n) => !owner.has(n));
  if (gaps.length > 0)
    errors.push(`${gaps.length} of ${roster.length} workload(s) are in no chunk: ${gaps.join(', ')}`);
  const strays = [...owner.keys()].filter((n) => !roster.includes(n));
  if (strays.length > 0) errors.push(`claimed but not on the roster: ${strays.join(', ')}`);

  // THE DECLARED COUNT IS ITS OWN CHECK. Coverage above is satisfied by any set of
  // chunks that tiles the roster, including three chunks of a four-way split whose
  // fourth was folded into another dir by hand -- which is no longer the split the
  // provenance describes.
  const ofs = new Set(parts.map((p) => num(p.chunk.of)).filter((v) => v !== null));
  if (ofs.size > 1) errors.push(`the chunks disagree on how many there are: ${[...ofs].join(', ')}`);
  else if (ofs.size === 1) {
    const of = [...ofs][0];
    const idx = parts.map((p) => num(p.chunk.index)).filter((v) => v !== null);
    if (parts.length !== of)
      errors.push(`${parts.length} chunk(s) given for a ${of}-way split`);
    const dupes = idx.filter((v, i) => idx.indexOf(v) !== i);
    if (dupes.length > 0) errors.push(`chunk index ${dupes.join(', ')} given more than once`);
  }

  if (errors.length > 0) return refuse();

  // ---- the merge itself, once the chunks are known to describe one run ----

  const ordered = parts.slice().sort((a, b) => (num(a.prov.sweptAt) ?? 0) - (num(b.prov.sweptAt) ?? 0));
  const rows = {};
  for (const p of ordered) for (const name of p.rows) rows[name] = p.theirs[name];

  // POOLED ACROSS CHUNKS, WITH THE CHUNK NAMED ON EVERY READING. `before-pass-0`
  // occurs once per chunk, so without the prefix the merged pool reads as one
  // session that took four readings at the same point and the label stops
  // identifying anything.
  const witnessReadings = [];
  const witnessErrors = [];
  for (const p of ordered) {
    const w = p.prov.loadWitness ?? {};
    const tag = p.chunk.selector ?? p.label;
    for (const r of w.readings ?? []) witnessReadings.push({ ...r, at: `${tag} ${r.at}` });
    for (const e of w.errors ?? []) witnessErrors.push({ ...e, at: `${tag} ${e.at}` });
  }

  // ADDITIVE, BECAUSE THE CHUNKS ARE DISJOINT. Both counts are per workload, and
  // no workload is in two chunks, so summing them is exactly what run-theirs.py
  // would have computed over the whole roster -- no rule is re-derived here.
  const inertArms = {};
  for (const p of ordered)
    for (const [arm, counts] of Object.entries(p.prov.inertArms ?? {})) {
      const into = (inertArms[arm] ??= { ranOn: 0, returnedInputUnchanged: 0 });
      into.ranOn += num(counts.ranOn) ?? 0;
      into.returnedInputUnchanged += num(counts.returnedInputUnchanged) ?? 0;
    }

  const warnings = { degraded: [], advisory: [] };
  for (const bucket of ['degraded', 'advisory']) {
    const byMessage = new Map();
    for (const p of ordered)
      for (const w of p.prov.competitorWarnings?.[bucket] ?? []) {
        const had = byMessage.get(w.message);
        if (had === undefined) byMessage.set(w.message, { ...w });
        else had.count = (num(had.count) ?? 0) + (num(w.count) ?? 0);
      }
    warnings[bucket] = [...byMessage.values()].sort((a, b) => String(a.message).localeCompare(String(b.message)));
  }

  // N WARM-UPS HAPPENED, AND THE MERGED FILE SAYS N. `ready` stays a single
  // boolean because instrumentFingerprint reads it, and it is true only when EVERY
  // chunk was warm -- one cold chunk degrades the capture it is part of.
  const warmups = ordered.map((p) => ({ chunk: p.chunk.selector, ...(p.prov.kompressWarmup ?? {}) }));
  const kompressWarmup = {
    ready: warmups.every((w) => w.ready === true),
    waitedSeconds: warmups.reduce((a, w) => a + (num(w.waitedSeconds) ?? 0), 0),
    why: warmups.filter((w) => w.why).map((w) => `${w.chunk}: ${w.why}`).join('; ') || null,
    perChunk: warmups,
  };

  const sweptPerWorkload = {};
  for (const p of ordered) Object.assign(sweptPerWorkload, p.prov.sweptPerWorkload ?? {});
  const starts = ordered.map((p) => num(p.prov.sweepStartedAt)).filter((v) => v !== null);
  const ends = ordered.map((p) => num(p.prov.sweptAt)).filter((v) => v !== null);

  const seam = {
    // WHAT A READER HAS TO KNOW BEFORE TRUSTING A ROW OF THIS FILE.
    chunks: ordered.map((p) => ({
      dir: p.label,
      selector: p.chunk.selector,
      index: num(p.chunk.index),
      of: num(p.chunk.of),
      workloads: p.rows.slice().sort(),
      sweepStartedAt: num(p.prov.sweepStartedAt),
      sweptAt: num(p.prov.sweptAt),
      sweepSeconds:
        num(p.prov.sweptAt) === null || num(p.prov.sweepStartedAt) === null
          ? null
          : Math.round((p.prov.sweptAt - p.prov.sweepStartedAt) * 10) / 10,
      // THE STATE THEIR ARMS RAN AGAINST, per chunk, because it is an input that
      // this capture deliberately varies. A `pipeline@*` row from a later chunk was
      // measured against a fuller store than the same arm in chunk 1.
      ccrStoreAfterRun: p.prov.ccrStoreAfterRun ?? null,
      resolved: p.resolved !== null,
      resolvedAt: num(p.resolved?.__provenance__?.resolvedAt),
      entryAgeSecondsWorst: Math.max(
        ...[0, ...Object.values(p.resolved?.__provenance__?.entryAgeSeconds ?? {}).map((v) => num(v) ?? 0)]
      ),
    })),
    // Named, not inferred: a reader should not have to work these out from the
    // chunk list to know what the split changed.
    storeGrewBetweenChunks:
      new Set(ordered.map((p) => p.prov.ccrStoreAfterRun?.sha256 ?? null)).size > 1,
    warmupsPaid: ordered.length,
    witnessSessionsPooled: ordered.length,
    speedPassSeparation:
      'passes within a chunk are separated by a chunk-sized sweep, not a roster-sized one',
    chunksWithoutResolution: ordered.filter((p) => p.resolved === null).map((p) => p.label),
  };

  const provenance = {
    ...parts[0].prov,
    roster,
    // NOT A CHUNK AND NOT A SINGLE SWEEP. `chunk` is cleared because this file
    // holds the whole roster, and `mergedFromChunks` is what says so -- a merged
    // file that looked like one sweep is the thing this module exists to avoid.
    chunk: null,
    mergedFromChunks: ordered.length,
    chunkSeam: seam,
    sweepStartedAt: starts.length > 0 ? Math.min(...starts) : null,
    sweptAt: ends.length > 0 ? Math.max(...ends) : null,
    sweptAtIso: ordered[ordered.length - 1].prov.sweptAtIso ?? null,
    sweptPerWorkload,
    loadWitness: {
      ms: median(witnessReadings.map((r) => num(r.ms)).filter((v) => v !== null)),
      readings: witnessReadings,
      errors: witnessErrors,
      script: parts[0].prov.loadWitness?.script ?? null,
    },
    // The state the NEXT run inherits, which is the last chunk's -- the same reason
    // run-theirs.py records it after its own sweep rather than before.
    ccrStoreAfterRun: ordered[ordered.length - 1].prov.ccrStoreAfterRun ?? null,
    carriedPayloads: [...new Set(ordered.flatMap((p) => p.prov.carriedPayloads ?? []))].sort(),
    inertArms,
    competitorWarnings: warnings,
    kompressWarmup,
  };

  // THE RESOLUTION, MERGED THE SAME WAY -- and this is the half the chunking was
  // for. `entryAgeSeconds` is per workload and the chunks are disjoint, so a
  // union carries each row its OWN age and `resolutionUsable` decides one row at a
  // time. The two fallbacks it reaches for when a row has no age of its own are
  // taken at their WORST across chunks, because a fallback is only sound in the
  // strict direction.
  let resolved = null;
  const withRes = ordered.filter((p) => p.resolved !== null);
  if (withRes.length > 0) {
    const entryAgeSeconds = {};
    for (const p of withRes)
      Object.assign(entryAgeSeconds, p.resolved.__provenance__?.entryAgeSeconds ?? {});
    const ttls = withRes
      .map((p) => num(p.resolved.__provenance__?.theirStatedTtlSeconds))
      .filter((v) => v !== null);
    const olds = withRes
      .map((p) => num(p.resolved.__provenance__?.elapsedSecondsOldestEntry))
      .filter((v) => v !== null);
    const elapsed = withRes
      .map((p) => num(p.resolved.__provenance__?.elapsedSeconds))
      .filter((v) => v !== null);
    resolved = { __provenance__: {} };
    for (const p of withRes)
      for (const [k, v] of Object.entries(p.resolved)) if (!k.startsWith('__')) resolved[k] = v;
    resolved.__provenance__ = {
      resolvedAt: Math.max(...withRes.map((p) => num(p.resolved.__provenance__?.resolvedAt) ?? 0)),
      resolvedAtIso: withRes[withRes.length - 1].resolved.__provenance__?.resolvedAtIso ?? null,
      resolvedPerChunk: withRes.map((p) => ({
        chunk: p.chunk.selector,
        resolvedAt: num(p.resolved.__provenance__?.resolvedAt),
        ageBasis: p.resolved.__provenance__?.ageBasis ?? null,
        pastTheirTtl: p.resolved.__provenance__?.pastTheirTtl ?? null,
      })),
      entryAgeSeconds,
      // THEIR BOUND IS A PROPERTY OF THEIR STORE, not of a chunk, so the largest one
      // any chunk got told is the one that applies to all of them. A chunk that was
      // never refused anything quotes nothing, and quoting nothing must not erase a
      // bound another chunk established.
      theirStatedTtlSeconds: ttls.length > 0 ? Math.max(...ttls) : null,
      elapsedSecondsOldestEntry: olds.length > 0 ? Math.max(...olds) : null,
      elapsedSeconds: elapsed.length > 0 ? Math.max(...elapsed) : null,
      ageBasis: withRes.every((p) => p.resolved.__provenance__?.ageBasis === 'oldest-entry')
        ? 'oldest-entry'
        : 'mixed',
      // TRUE IF ANY CHUNK WAS LATE, because the merged file then contains rows that
      // cannot be read as their loss, and `resolutionUsable` needs the bound above
      // to be present in order to refuse them one by one.
      pastTheirTtl: withRes.some((p) => p.resolved.__provenance__?.pastTheirTtl === true),
    };
  }

  return { ok: true, errors, seam, theirs: { __provenance__: provenance, ...rows }, resolved };
}

/**
 * The payload sets, unioned. Disjoint chunks cannot collide, so a collision means
 * a dir was re-run with a different selector and the two copies may not be the
 * same bytes -- which would put a payload in the merged file that no row was
 * actually measured over.
 */
export function mergePayloads(sets) {
  const out = {};
  const errors = [];
  for (const { dir, data } of sets)
    for (const [name, value] of Object.entries(data ?? {})) {
      const had = out[name];
      if (had !== undefined && JSON.stringify(had) !== JSON.stringify(value))
        errors.push(`${name}: two chunks carry different bytes for it (${dir} disagrees)`);
      out[name] = value;
    }
  return { out, errors };
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  process.argv[1].split(String.fromCharCode(92)).join('/').endsWith('bench/compression/chunk-merge.mjs');

if (invokedDirectly) {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const args = process.argv.slice(2);
  const out = args.find((a) => a.startsWith('--out='))?.slice(6);
  const dirs = args.filter((a) => !a.startsWith('--'));
  if (out === undefined || dirs.length === 0) {
    console.error('usage: node bench/compression/chunk-merge.mjs --out=<dir> <chunk-dir> ...');
    process.exit(2);
  }
  const read = (dir, file) => {
    const p = path.join(dir, file);
    return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null;
  };
  const chunks = dirs.map((dir) => ({
    dir,
    theirs: read(dir, 'theirs.json'),
    resolved: read(dir, 'theirs-resolved.json'),
  }));
  const missing = chunks.filter((c) => c.theirs === null).map((c) => c.dir);
  if (missing.length > 0) {
    console.error(`no theirs.json in: ${missing.join(', ')}`);
    process.exit(2);
  }
  const merged = mergeChunks(chunks);
  if (!merged.ok) {
    console.error('REFUSING TO MERGE:');
    for (const e of merged.errors) console.error(`  ${e}`);
    process.exit(2);
  }
  const payloads = mergePayloads(dirs.map((dir) => ({ dir, data: read(dir, 'payloads.json') })));
  const natives = mergePayloads(dirs.map((dir) => ({ dir, data: read(dir, 'natives.json') })));
  const payloadErrors = [...payloads.errors, ...natives.errors];
  if (payloadErrors.length > 0) {
    console.error('REFUSING TO MERGE:');
    for (const e of payloadErrors) console.error(`  ${e}`);
    process.exit(2);
  }
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'payloads.json'), JSON.stringify(payloads.out));
  fs.writeFileSync(path.join(out, 'natives.json'), JSON.stringify(natives.out));
  fs.writeFileSync(path.join(out, 'theirs.json'), JSON.stringify(merged.theirs, null, 2));
  if (merged.resolved !== null)
    fs.writeFileSync(path.join(out, 'theirs-resolved.json'), JSON.stringify(merged.resolved));
  const seam = merged.seam;
  console.log(
    `merged ${seam.chunks.length} chunk(s) into ${out}: ` +
      `${Object.keys(merged.theirs).length - 1} workload(s), ` +
      `${seam.warmupsPaid} warm-up(s), store ${seam.storeGrewBetweenChunks ? 'GREW between chunks' : 'unchanged'}`
  );
  for (const c of seam.chunks)
    console.log(
      `  ${c.selector}: ${c.workloads.length} workload(s), ${c.sweepSeconds}s sweep, ` +
        `${c.resolved ? `resolved, worst entry age ${c.entryAgeSecondsWorst}s` : 'NOT RESOLVED'}`
    );
  if (seam.chunksWithoutResolution.length > 0)
    console.log(`  unresolved chunk(s): ${seam.chunksWithoutResolution.join(', ')}`);
}
