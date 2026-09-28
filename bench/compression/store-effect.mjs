/**
 * DOES A MUST-WIN VERDICT DEPEND ON WHAT THEIR STORE HAPPENED TO HOLD?
 *
 * Their `pipeline@*` arms hand blocks to a durable CCR store and redeem them back
 * out of it, so those arms return different bytes against different store states --
 * measured at up to 100x on the same workload, same version, same payload. Those
 * are the arms that decide the comparable cost and retention columns, which means
 * a verdict can turn on a condition that is not ours to set and is invisible in
 * the numbers. Until this was measured it was a disclosed unknown; this module is
 * what turns it into a quantity.
 *
 * THE MEASUREMENT IS A PAIR OF CAPTURES, ONE VARIABLE APART: the same corpus, the
 * same commit and the same engine, swept once from an empty store and once from a
 * store that has been lived in. Everything below exists to hold the pair to that,
 * because a pair that differs in two things measures neither.
 *
 * IT IS NOT A REPLICATE PAIR, and must never be read as one. Two recordings of one
 * capture are the same experiment twice, and a disagreement between them is the
 * instrument failing to resolve a margin (see replicate-agreement.mjs). These two
 * are DIFFERENT experiments, and a disagreement is a real dependency: the verdict
 * holds under one store state and not the other.
 *
 * A VERDICT THAT HOLDS UNDER ONE STORE STATE IS NOT A WIN. We do not get to pick
 * which state a reader's engine is in, so the claim we can support is the one that
 * survives both. This module reports which side each disagreement favours rather
 * than averaging them, because an average over two experiments describes no run
 * that was ever performed.
 */

/** The fingerprint term this pair is supposed to differ in, and nothing else. */
const STORE_TERM = / store=(empty|warm|unrecorded)$/;

/**
 * The store state a fingerprint names, or null when it names none.
 *
 * @param {string|null|undefined} fingerprint
 * @returns {'empty'|'warm'|'unrecorded'|null}
 */
export function storeStateOf(fingerprint) {
  if (typeof fingerprint !== 'string') return null;
  const m = STORE_TERM.exec(fingerprint);
  return m === null ? null : /** @type {'empty'|'warm'|'unrecorded'} */ (m[1]);
}

/** The fingerprint with its store term removed, so the rest can be compared. */
export function withoutStoreTerm(fingerprint) {
  return typeof fingerprint === 'string' ? fingerprint.replace(STORE_TERM, '') : '';
}

/**
 * Why this pair cannot be read as one variable moving, or null when it can.
 *
 * EVERY CLAUSE HERE HAS THE SAME SHAPE: something that would let a difference in
 * the verdicts be attributed to the store when it was caused by something else.
 * The corpus and the commit are the obvious two. The third is subtler and is why
 * the fingerprint is compared with its store term stripped rather than ignored:
 * a pair captured across an engine upgrade, a lost native detector or a different
 * chunk split differs in the store term AND in a term that moves the same columns,
 * and the store would take the credit for all of it.
 *
 * @param {{label: string, fingerprint: string, commit: string, payloadsDigest: string}} a
 * @param {{label: string, fingerprint: string, commit: string, payloadsDigest: string}} b
 * @returns {string|null}
 */
export function notOneVariableApart(a, b) {
  const sa = storeStateOf(a.fingerprint);
  const sb = storeStateOf(b.fingerprint);
  if (sa === null || sb === null)
    return (
      `${sa === null ? a.label : b.label} does not record what their store held before ` +
      'the sweep, so this pair cannot say the store is what differed'
    );
  // UNREADABLE IS NOT A STATE. `store=unrecorded` means the stamp was there and
  // unusable, which is the one case that reads as recorded and is not.
  if (sa === 'unrecorded' || sb === 'unrecorded')
    return `${sa === 'unrecorded' ? a.label : b.label} recorded an unusable store stamp`;
  if (sa === sb)
    return (
      `both captures started from a ${sa} store, so this pair holds the store state ` +
      'fixed and measures nothing about it'
    );
  // A MISSING STAMP IS NOT A MATCH. Both sides reading null makes the two
  // comparisons below false, so a record without its reproduction block would sail
  // through the commit and corpus guards instead of being stopped by them -- and a
  // guard that cannot fire is worse than none, because the pair reads as checked.
  for (const rec of [a, b]) {
    if (typeof rec.commit !== 'string' || rec.commit.length === 0)
      return `${rec.label} does not record the commit it was measured at`;
    if (typeof rec.payloadsDigest !== 'string' || rec.payloadsDigest.length === 0)
      return `${rec.label} does not record which payloads it swept`;
  }
  if (a.commit !== b.commit)
    return (
      `the two captures name commits ${String(a.commit).slice(0, 8)} and ` +
      `${String(b.commit).slice(0, 8)}, so they measured different code`
    );
  if (a.payloadsDigest !== b.payloadsDigest)
    return 'the two captures were swept over different payload sets';
  const ra = withoutStoreTerm(a.fingerprint);
  const rb = withoutStoreTerm(b.fingerprint);
  if (ra !== rb)
    return (
      `the instruments differ in more than the store: ${ra} against ${rb}, and both ` +
      'halves move the columns under test'
    );
  return null;
}

/**
 * The verdict pair for one criterion, in the terms that can be claimed.
 *
 * `pass` is the gate's own tri-state: true, false, or null for a criterion it
 * refused to decide. A null on either side leaves the pair undecided -- an
 * unresolved criterion says nothing about the store, and calling that agreement
 * would count a refusal as a win.
 *
 * @param {boolean|null} onEmpty
 * @param {boolean|null} onWarm
 * @returns {'agree-pass'|'agree-fail'|'needs-empty-store'|'needs-warm-store'|'undecided'}
 */
export function pairing(onEmpty, onWarm) {
  if (onEmpty === null || onWarm === null) return 'undecided';
  if (onEmpty === onWarm) return onEmpty ? 'agree-pass' : 'agree-fail';
  return onEmpty ? 'needs-empty-store' : 'needs-warm-store';
}

/**
 * The whole pair, row by row and criterion by criterion.
 *
 * `empty` and `warm` are each `{label, fingerprint, commit, payloadsDigest, verdicts}`
 * where `verdicts` is what `must-win.check.mjs --json` printed for that record --
 * the judge's own output rather than a second opinion computed here, for the reason
 * `agreeAcrossRecordings` takes one `judge`: a second reading judged by a softer
 * test is not a second opinion, it is a loophole.
 *
 * A CRITERION MISSING FROM ONE SIDE IS REPORTED, NOT DROPPED. A pair where one
 * capture covers fewer rows still measures the store on the rows it covers, and
 * silently intersecting the two would hide that it covered fewer.
 */
export function storeEffect({ empty, warm }) {
  const refusal = notOneVariableApart(empty, warm);
  if (refusal !== null) return { refusal, rows: [], summary: null };
  const names = [...new Set([...Object.keys(empty.verdicts ?? {}), ...Object.keys(warm.verdicts ?? {})])].sort();
  const rows = [];
  const missing = [];
  for (const name of names) {
    const a = (empty.verdicts ?? {})[name];
    const b = (warm.verdicts ?? {})[name];
    if (a === undefined || b === undefined) {
      missing.push(`${name} is only in ${a === undefined ? warm.label : empty.label}`);
      continue;
    }
    const criteria = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => k !== 'issue').sort();
    for (const criterion of criteria) {
      const ca = a[criterion];
      const cb = b[criterion];
      if (ca === undefined || cb === undefined) {
        missing.push(`${name}/${criterion} is only in ${ca === undefined ? warm.label : empty.label}`);
        continue;
      }
      rows.push({
        name,
        criterion,
        issue: a.issue ?? b.issue ?? null,
        pairing: pairing(ca.pass ?? null, cb.pass ?? null),
        onEmpty: { pass: ca.pass ?? null, detail: ca.detail ?? null },
        onWarm: { pass: cb.pass ?? null, detail: cb.detail ?? null },
      });
    }
  }
  const of = (kind) => rows.filter((r) => r.pairing === kind);
  return {
    refusal: null,
    rows,
    summary: {
      criteria: rows.length,
      agreePass: of('agree-pass').length,
      agreeFail: of('agree-fail').length,
      // THE MEASURED QUANTITY THIS WHOLE PAIR EXISTS FOR.
      storeDependent: [...of('needs-empty-store'), ...of('needs-warm-store')].map(
        (r) => `${r.name}/${r.criterion} passes only from a ${r.pairing === 'needs-empty-store' ? 'empty' : 'warm'} store`
      ),
      undecided: of('undecided').map((r) => `${r.name}/${r.criterion}`),
      missing,
    },
  };
}

// ---------------------------------------------------------------------------
// THE PAIR, SCORED FROM TWO RECORDS ON DISK.
//
// Each side is one head-to-head record. The verdicts come from the gate itself --
// run once per record with `--results <path> --json` -- rather than from a second
// judge written here, and the store state and the corpus digest come out of the
// record, so nothing about the pair is asserted by whoever runs it.
//
// EACH SIDE NEEDS ITS OWN SECOND RECORDING. The gate reads a speed row only when
// it can see two recordings of the SAME capture, so an arm passed without one is
// judged against whatever replicate happens to be published -- a different capture
// entirely -- and every speed row on that arm comes back NOT ENFORCEABLE. That is
// not a small hole: speed is twelve of the sixty criteria here, and their redeem
// path is precisely where a warm store would show up, so a pair without replicates
// is blind in the place it was built to look.
//
//   node bench/compression/store-effect.mjs \
//     --empty=<record.json> --empty-replicate=<second recording of the same capture> \
//     --warm=<record.json>  --warm-replicate=<second recording of the same capture>
// ---------------------------------------------------------------------------
const { fileURLToPath } = await import('node:url');
const { resolve } = await import('node:path');
const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  const fs = await import('node:fs');
  const { execFileSync } = await import('node:child_process');
  const { instrumentFingerprint } = await import('./ratchet.mjs');
  const args = process.argv.slice(2);
  const flag = (n) => args.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
  const emptyPath = flag('empty');
  const warmPath = flag('warm');
  const emptySecond = flag('empty-replicate');
  const warmSecond = flag('warm-replicate');
  if (emptyPath === undefined || warmPath === undefined) {
    console.error(
      'usage: node bench/compression/store-effect.mjs --empty=<record.json> --warm=<record.json>\n' +
        '       [--empty-replicate=<path> --warm-replicate=<path>], without which every ' +
        'speed row reads undecided'
    );
    process.exit(2);
  }
  // SAID OUT LOUD RATHER THAN LEFT TO THE READER TO NOTICE. A pair run without
  // replicates still reports sixty criteria and quietly decides forty-eight.
  for (const [side, second] of [
    ['empty', emptySecond],
    ['warm', warmSecond],
  ]) {
    if (second === undefined) {
      console.error(
        `warning: no --${side}-replicate, so the ${side} arm is judged against the published ` +
          'replicate of another capture and its speed rows will all read undecided'
      );
    }
  }
  const gate = resolve(fileURLToPath(import.meta.url), '..', 'must-win.check.mjs');
  const load = (label, p, second) => {
    const record = JSON.parse(fs.readFileSync(p, 'utf8'));
    // THE JUDGE'S OWN VERDICTS. `--json` prints them and exits non-zero while any
    // must-win is open, which is the normal state, so the status is not an error
    // here -- an unparseable stdout is.
    let stdout = '';
    try {
      stdout = execFileSync(
        process.execPath,
        [gate, '--results', p, '--json', ...(second === undefined ? [] : ['--replicate', second])],
        { encoding: 'utf8' }
      );
    } catch (e) {
      stdout = e.stdout ?? '';
    }
    let verdicts;
    try {
      verdicts = JSON.parse(stdout);
    } catch {
      console.error(`the gate produced no readable verdicts for ${p}`);
      process.exit(2);
    }
    return {
      label,
      fingerprint: instrumentFingerprint(record.capture?.theirsProvenance ?? null),
      commit: record.reproduction?.commit ?? record.commit ?? null,
      payloadsDigest: record.reproduction?.payloadsDigest ?? null,
      capture: record.capture?.dir ?? 'unrecorded',
      verdicts,
    };
  };
  const empty = load('empty-store', emptyPath, emptySecond);
  const warm = load('warm-store', warmPath, warmSecond);
  console.log(`empty-store: capture ${empty.capture}, ${empty.fingerprint}`);
  console.log(`warm-store:  capture ${warm.capture}, ${warm.fingerprint}`);
  const r = storeEffect({ empty, warm });
  if (r.refusal !== null) {
    console.error(`\nthis pair cannot measure the store: ${r.refusal}`);
    process.exit(1);
  }
  const s = r.summary;
  console.log(
    `\n${s.criteria} criteria paired: ${s.agreePass} hold from either store, ` +
      `${s.agreeFail} fail from either, ${s.storeDependent.length} turn on the store, ` +
      `${s.undecided.length} undecided.`
  );
  if (s.storeDependent.length) console.log(`\nTURNS ON THEIR STORE STATE:\n  ${s.storeDependent.join('\n  ')}`);
  if (s.undecided.length) console.log(`\nUNDECIDED ON ONE SIDE:\n  ${s.undecided.join('\n  ')}`);
  if (s.missing.length) console.log(`\nCOVERED BY ONE CAPTURE ONLY:\n  ${s.missing.join('\n  ')}`);
  for (const row of r.rows.filter((x) => x.pairing.startsWith('needs-'))) {
    console.log(`\n${row.name}/${row.criterion} (#${row.issue})`);
    console.log(`  from empty: ${row.onEmpty.detail}`);
    console.log(`  from warm:  ${row.onWarm.detail}`);
  }
  // A DEPENDENCY IS NOT A BUILD FAILURE, it is a fact about what may be claimed.
  process.exit(0);
}
