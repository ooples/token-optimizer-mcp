/**
 * THE SCORER, CHECKED AGAINST ANSWERS FIXED BEFORE IT RAN.
 *
 * `capture.check.mjs` does this for layer 1 -- the path that PRODUCES the
 * numbers. This is layer 2: the path that SCORES them. Between the two there
 * was a gap that mattered, because their engine was already substitutable
 * through BENCH_KNOWN_ANSWER_ARMS while our column still came from a live
 * compressor. Half a comparison with a known answer is not a known answer: no
 * figure in the table had a value anyone could state in advance.
 *
 * `ours-engine.mjs` closes that, and this file spends it. Three stub profiles,
 * each with a different job:
 *
 *   identity  every arm returns its input. The zero of the instrument.
 *   lossy     the arms drop a stated number of identifiers. Ground truth for
 *             the retention columns, and the three arms deliberately disagree.
 *   mirror    our arms emit exactly their winning arm's bytes, so every paired
 *             figure must be IDENTICAL. This is the one property here that
 *             needs no fixture knowledge at all -- it catches a denominator
 *             taken before an envelope on one side, a token count estimated for
 *             one side and tokenised for the other, and an identifier set
 *             scraped from one side's output.
 *
 * FICTION IS ONLY EVER SCORED AGAINST FICTION. A stubbed capture is refused
 * unless our column is stubbed too, and no stubbed run may be recorded under
 * `results/`. Both refusals are exercised below rather than trusted.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { knownAnswerFixtures, IDENTIFIER_COUNT } from './fixtures.mjs';
import { reproducibilityRefusal } from '../reproducibility.mjs';
import { identifiers, scanIdentifiers } from '../identifiers.mjs';
import { DROP, ID_CHARS } from './ours-lossy.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..');
const RUN_THEIRS = join(REPO, 'bench', 'compression', 'headroom', 'run-theirs.py');
const ARMS = join(HERE, 'arms.py');
const SCORER = join(REPO, 'bench', 'compression', 'head-to-head.mjs');

let failures = 0;
const check = (ok, name, detail = '') => {
  if (ok) console.log(`  ok   ${name}${detail ? `  (${detail})` : ''}`);
  else {
    failures++;
    console.log(`  FAIL ${name}${detail ? `  (${detail})` : ''}`);
  }
};
// A CHECKER THAT CANNOT FAIL PASSES EVERYTHING. Proved, not assumed -- the
// same negative control capture.check.mjs arms, for the same reason.
{
  const before = failures;
  check(false, '(negative control -- this FAIL is expected)');
  if (failures !== before + 1) {
    console.log('  FAIL the checker does not count a failure; every result below is void');
    process.exit(1);
  }
  failures = before;
  console.log('  ok   the checker counts a failure when one is handed to it');
}

const tmp = mkdtempSync(join(tmpdir(), 'ka-scorer-'));
const pct = (s) => Number(String(s).replace('%', ''));
/** The record lists workloads as an array; every lookup below wants them by name. */
const byName = (rec) => Object.fromEntries(rec.workloads.map((w) => [w.name, w]));
const num = (s) => Number(s);

/** Run the scorer over `outDir` with a stub profile, and return the record. */
function score(profile, { mirrorDir, recordTo, extraEnv } = {}) {
  const at = recordTo ?? join(tmp, `rec-${profile}.json`);
  const env = {
    ...process.env,
    BENCH_KNOWN_ANSWER_OURS: join(HERE, `ours-${profile}.mjs`),
    ...extraEnv,
  };
  if (mirrorDir) env.BENCH_KA_MIRROR_DIR = mirrorDir;
  const run = spawnSync('node', [SCORER, join(tmp, 'out'), '--record', at], {
    encoding: 'utf8',
    env,
    maxBuffer: 64 * 1024 * 1024,
  });
  return { run, at };
}
try {
  // ---------------------------------------------------------- the KA capture
  const KA = knownAnswerFixtures();
  const natives = join(tmp, 'natives.json');
  writeFileSync(
    natives,
    JSON.stringify(Object.fromEntries(KA.map((f) => [f.name, f.native]))),
    'utf8'
  );
  const built = spawnSync('python', [RUN_THEIRS, '-', join(tmp, 'out'), '--extra', natives], {
    encoding: 'utf8',
    env: { ...process.env, BENCH_KNOWN_ANSWER_ARMS: ARMS },
    maxBuffer: 64 * 1024 * 1024,
  });
  if (built.status !== 0) {
    console.log(built.stdout, built.stderr);
    throw new Error('known-answer capture did not build; nothing below is meaningful');
  }

  // ------------------------------------------------------ the two refusals
  // Fiction may only be scored against fiction, and no fiction may be
  // published. Both are exercised, because a refusal that was never triggered
  // is a comment.
  console.log('\nrefusals (exercised, not trusted)');
  {
    const bare = spawnSync('node', [SCORER, join(tmp, 'out')], {
      encoding: 'utf8',
      env: Object.fromEntries(
        Object.entries(process.env).filter(([k]) => k !== 'BENCH_KNOWN_ANSWER_OURS')
      ),
      maxBuffer: 64 * 1024 * 1024,
    });
    check(
      bare.status === 2 && /stub arms/.test(bare.stderr),
      'a stubbed capture is refused when our column is real',
      `exit ${bare.status}`
    );

    const published = join(tmp, 'results', 'x.json');
    const { run } = score('identity', { recordTo: published });
    check(
      run.status === 2 && /refusing to record/.test(run.stderr),
      'a stubbed run refuses to write under results/',
      `exit ${run.status}`
    );
  }
  // ------------------------------------------------------- profile: identity
  // An engine that did nothing must be scored as having done nothing. A scorer
  // that reports anything but zero here is measuring its own envelope, its own
  // denominator or its own rounding, and every one of those has happened.
  console.log('\nprofile identity -- the zero of the instrument');
  const identity = (() => {
    const { run, at } = score('identity');
    check(run.status === 0 || run.status === 1, 'the scorer completes', `exit ${run.status}`);
    check(
      /KNOWN-ANSWER SCORER RUN/.test(run.stderr),
      'the run announces that our column is a stub'
    );
    const rec = JSON.parse(readFileSync(at, 'utf8'));
    check(
      typeof rec.stubOurs === 'string' && rec.stubOurs.includes('ours-identity'),
      'the record stamps which stub produced it',
      String(rec.stubOurs)
    );
    // THE REPRODUCTION BLOCK, on a record whose provenance is known because
    // this check produced it. reproducibility.check.mjs proves the gate refuses
    // a deficient block; what it cannot prove is that the scorer FILLS one in,
    // and a gate reading a field nothing writes passes every record forever.
    const rep = rec.reproduction ?? {};
    check(
      rep.node === process.versions.node &&
        /^[0-9]+[.][0-9]+[.][0-9]+/.test(String(rep.tiktoken)) &&
        rep.encoding === 'cl100k_base',
      'the record states the toolchain the token column was measured with',
      `node ${rep.node}, tiktoken ${rep.tiktoken}, ${rep.encoding}`
    );
    check(
      /^[0-9a-f]{16}$/.test(String(rep.payloadsDigest)) &&
        /^[0-9a-f]{16}$/.test(String(rep.theirsDigest)) &&
        rep.payloadsDigest !== rep.theirsDigest,
      'and digests the input it scored and the output it scored it against',
      `payloads ${rep.payloadsDigest}, theirs ${rep.theirsDigest}`
    );
    check(
      rep.speedPasses?.ours === 3 && rep.speedPasses?.theirs === 3,
      'and counts the speed passes on BOTH sides, which is what makes the verdict decidable',
      JSON.stringify(rep.speedPasses)
    );
    // A stub run is a measurement of nothing, so this record is not one a
    // reader should ever reproduce -- but the refusal it carries has to be
    // about the tree, not about a field the scorer forgot. The only reasons
    // allowed here are the ones this environment really has.
    check(
      rep.refusal === null || /(dirty|working tree was modified)/.test(String(rep.refusal)),
      'and any refusal it carries is about the tree, not a field left unfilled',
      String(rep.refusal)
    );
    // THE FIELD THAT SAYS WHOSE ENGINE RAN, AND THE VERSION THAT MUST NOT BE
    // THERE. This capture replaced every one of their arms with `arms.py`, so
    // their package was never imported -- and it stamped the installed version
    // regardless, which named an engine that produced none of the column and read
    // as recorded on any machine where the package happened to be installed. It
    // went unnoticed for the same reason it was wrong: on a machine WITHOUT the
    // package the field read 'unknown' and the gate called it missing, which is
    // the wrong diagnosis of the right problem.
    check(
      typeof rep.stubArms === 'string' && rep.stubArms.endsWith('arms.py'),
      'the record names the stub arms that stood in for their engine',
      String(rep.stubArms)
    );
    check(
      rep.headroomVersion === null,
      'and carries no competitor version, because no engine of theirs ran',
      String(rep.headroomVersion)
    );
    // BOTH DIRECTIONS, against the gate itself rather than a restatement of it.
    // An assertion that only ever sees the accepting case cannot tell a rule
    // apart from a rule that was deleted.
    check(
      reproducibilityRefusal({ ...rep, refusal: undefined }) === null ||
        /(dirty|working tree was modified)/.test(
          String(reproducibilityRefusal({ ...rep, refusal: undefined }))
        ),
      'the gate accepts this block as it stands',
      String(reproducibilityRefusal({ ...rep, refusal: undefined }))
    );
    check(
      /stub arms/.test(
        String(reproducibilityRefusal({ ...rep, headroomVersion: '0.37.0' }))
      ),
      'and refuses the same block the moment it claims one',
      String(reproducibilityRefusal({ ...rep, headroomVersion: '0.37.0' }))
    );
    // THE BODY ARM DOES NOT EXIST ON EVERY WORKLOAD, and the expected set says
    // so rather than the assertion being widened until it passes. `body` is
    // `compressBody` over a message list, and `ka-items` carries no `role`
    // anywhere by construction -- there is no conversation there to compress, so
    // the scorer reports `null`. That is the honest answer: an arm that never ran
    // printed as one that ran and saved nothing is a fabricated measurement, and
    // fabricated measurements are what this harness exists to catch. So the arms
    // demanded of each workload come from the fixture's own `kind`.
    const kindOf = new Map(KA.map((f) => [f.name, f.kind]));
    for (const w of rec.workloads) {
      const name = w.name;
      const arms = ['ours', 'preset', 'sub'];
      if (kindOf.get(name) === 'messages') arms.splice(1, 0, 'body');
      check(
        arms.every((a) => pct(w.chars[a]) === 0),
        `${name}: every arm saves 0.0% of characters`,
        // Named, not positional: an empty slot in a space-joined list of four
        // figures is two spaces, which is what this read as while the arm that
        // was missing went unnamed.
        arms.map((a) => `${a}=${w.chars[a]}`).join(' ')
      );
      check(
        pct(w.tokens.ours) === 0,
        `${name}: 0.0% of tokens, so the token column is not derived from the char column`,
        w.tokens.ours
      );
      const r = w.retention;
      check(
        r.recoverable === null,
        `${name}: the sinkless headline arm reports null, not a measured zero`,
        String(r.recoverable)
      );
      check(
        num(r.inContext) === num(r.ids) && num(r.reconstructible) === 0,
        `${name}: every identifier is literally present`,
        `${r.inContext}/${r.ids} in context, ${r.reconstructible} derived`
      );
    }
    // AND THE ABSENCE IS ASSERTED, not skipped. The loop above cannot catch a
    // scorer that stops running the body arm on an actual conversation, because
    // an arm missing from the record is an arm missing from `arms`. This is the
    // other direction too: a scorer that starts filling the slot in with a zero
    // fails right here.
    const sorted = (xs) => [...xs].sort().join(',');
    const absent = rec.workloads.filter((w) => w.chars.body === null).map((w) => w.name);
    const notConversations = KA.filter((f) => f.kind !== 'messages').map((f) => f.name);
    check(
      sorted(absent) === sorted(notConversations),
      'the body arm is absent on exactly the fixtures that are not conversations',
      `absent [${sorted(absent)}], not conversations [${sorted(notConversations)}]`
    );
    check(pct(rec.totals.chars.ours) === 0, 'totals: 0.0% of characters', rec.totals.chars.ours);
    check(pct(rec.totals.tokens.ours) === 0, 'totals: 0.0% of tokens', rec.totals.tokens.ours);
    return rec;
  })();
  // ------------------------------------------------------- the unpriced arm
  // ONE MISSING MEASUREMENT MUST NOT TAKE THIRTY WITH IT. `baseContextTokens`
  // is read off local agent transcripts, which a CI runner does not have and a
  // second developer has different ones of, and the harness used to exit 2
  // without it -- so every instrument in this file was unrunnable anywhere but
  // one laptop, and the published cost column was a figure only that laptop
  // could produce.
  //
  // Now the measurement is committed and the refusal is per figure. This runs
  // the scorer with the record pointed somewhere it is not, and checks both
  // halves: the cost figures are withheld AND SAID TO BE, and every figure
  // that does not rest on a price is byte-identical to the priced run.
  console.log('\nthe unpriced arm -- cost withheld, everything else scored');
  {
    const { run, at } = score('identity', {
      recordTo: join(tmp, 'rec-unpriced.json'),
      extraEnv: { BENCH_BASE_CONTEXT_RECORD: join(tmp, 'no-such-record.json') },
    });
    check(
      run.status === 0 || run.status === 1,
      'the scorer completes with no base-context record',
      `exit ${run.status}`
    );
    check(
      /WITHHELD: cost figures are not priced/.test(run.stderr),
      'and says on stderr that the cost figures are not priced',
      (run.stderr.split('\n').find((l) => /WITHHELD/.test(l)) ?? '').trim()
    );
    check(
      /session cost, effective input tokens: WITHHELD/.test(run.stdout),
      'and the cost section of the table says so where the figures would be'
    );
    const un = JSON.parse(readFileSync(at, 'utf8'));
    // BOTH DIRECTIONS. `cost === null` alone would pass against a scorer that
    // nulled the block on a priced run too, which is why the priced record is
    // asserted to carry one.
    check(
      un.workloads.length === identity.workloads.length &&
        un.workloads.every((w) => w.cost === null) &&
        identity.workloads.every((w) => w.cost !== null),
      'every workload records cost as null here and an object when priced',
      `${un.workloads.length} workloads`
    );
    check(
      un.workloads.every((w) => /no base-context record at/.test(String(w.costRefusal))) &&
        identity.workloads.every((w) => w.costRefusal === null),
      'and names the reason, which a zero could never do',
      String(un.workloads[0]?.costRefusal)
    );
    check(
      un.totals.cost === null &&
        /no base-context record at/.test(String(un.totals.costRefusal)) &&
        identity.totals.cost !== null,
      'the corpus total is withheld the same way',
      String(un.totals.costRefusal)
    );
    // AND THE REST OF THE RUN IS UNTOUCHED. This is the half that was lost
    // every time the harness exited: the char, token and retention columns do
    // not depend on base context at all, and they have to come out identical.
    const nonCost = (rec) =>
      JSON.stringify({
        chars: rec.totals.chars,
        tokens: rec.totals.tokens,
        workloads: rec.workloads.map((w) => [w.name, w.chars, w.tokens, w.retention]),
      });
    check(
      nonCost(un) === nonCost(identity) && nonCost(un).length > 100,
      'and every figure that does not rest on a price is identical to the priced run',
      `${nonCost(un).length} bytes compared`
    );
  }
  // ----------------------------------------------- the denominator, enumerated
  // `ids` is the denominator of every retention figure this project publishes,
  // so what is IN it is stated here by name rather than trusted as a count. On
  // ka-identifiers the fixture plants IDENTIFIER_COUNT tokens and the extractor
  // also admits two envelope values under the `keyed` rule -- the role name and
  // the user's turn. That is the rule behaving as written, and writing it down
  // is what makes a change to it visible instead of merely numerically different.
  console.log('\nthe retention denominator, by name');
  {
    const payloads = JSON.parse(readFileSync(join(tmp, 'out', 'payloads.json'), 'utf8'));
    const found = [...identifiers(payloads['ka-identifiers'])];
    const planted = found.filter((x) => /^KA-ID-\d{4}$/.test(x));
    const envelope = found.filter((x) => !/^KA-ID-\d{4}$/.test(x)).sort();
    check(
      planted.length === IDENTIFIER_COUNT,
      'every planted identifier is in the denominator',
      `${planted.length}/${IDENTIFIER_COUNT}`
    );
    check(
      JSON.stringify(envelope) === JSON.stringify(['Return every record.', 'assistant']),
      'and nothing else is, beyond the two envelope values the keyed rule admits',
      JSON.stringify(envelope)
    );
    // AND THE FLOOR MUST ACTUALLY EXCLUDE SOMETHING. Without this the exclusion
    // could be lowered to one character -- readmitting every short token as a
    // free substring match -- and every other assertion here would still hold,
    // because the denominator and the buckets would widen together. The mutation
    // battery found exactly that hole. ka-items scrapes `error`, five
    // characters, which is too short to score by `includes` and must be
    // reported rather than quietly counted.
    const items = byName(identity)['ka-items'].retention;
    const scraped = [...identifiers(payloads['ka-items'])];
    const short = scraped.filter((x) => x.length < 8);
    check(
      short.length > 0,
      'the fixture really does scrape an identifier too short to score',
      JSON.stringify(short)
    );
    check(
      num(items.unsafeIds) === short.length && num(items.ids) === scraped.length - short.length,
      'and it is excluded from the denominator and reported, not quietly counted',
      `ids ${items.ids}, unsafe ${items.unsafeIds}, scraped ${scraped.length}`
    );
    // AND A UNIT NO ARM COULD EVER BE CREDITED WITH KEEPING MUST BE DROPPED
    // *AND COUNTED*. ka-escaped quotes a path inside a longer string:
    // `JSON.parse` unescapes one level, so the unit holds one backslash where
    // the payload text holds two, and `includes` can never find it on any
    // output. 283 of 14,067 units were of this shape on the real capture and
    // every one of them was charged to every arm as a loss.
    //
    // THE COUNT IS ASSERTED, NOT JUST THE EXCLUSION, because a denominator
    // that quietly shrinks is the same defect as one that quietly holds
    // phantoms: without this the recorded field could be a hardcoded zero and
    // every other assertion here would still pass.
    const escaped = scanIdentifiers(payloads['ka-escaped']);
    const esc = byName(identity)['ka-escaped'].retention;
    check(
      escaped.phantoms.length > 0,
      'the fixture really does carry a unit absent from its own payload',
      JSON.stringify(escaped.phantoms)
    );
    check(
      num(esc.phantomIds) === escaped.phantoms.length,
      'and the record says how many were dropped, not merely a narrower total',
      `phantomIds ${esc.phantomIds} vs ${escaped.phantoms.length}`
    );
    check(
      num(esc.ids) + num(esc.unsafeIds) === escaped.units.size,
      'the denominator is what survived, with nothing else lost on the way',
      `ids ${esc.ids} + unsafe ${esc.unsafeIds} vs ${escaped.units.size}`
    );
    const w = byName(identity)['ka-identifiers'].retention;
    check(
      num(w.ids) === found.length,
      'the printed denominator is the set that was actually scored',
      `${w.ids} vs ${found.length}`
    );
  }

  // ---------------------------------------------------------- profile: lossy
  // Retention has never been checked against an arm whose losses were known in
  // advance -- only against whatever our engine happened to do, where "336
  // retained" is a number nobody can check. Here the loss is chosen.
  console.log('\nprofile lossy -- retention against a stated loss');
  {
    const { run, at } = score('lossy');
    check(run.status === 0 || run.status === 1, 'the scorer completes', `exit ${run.status}`);
    const rec = JSON.parse(readFileSync(at, 'utf8'));
    const w = byName(rec)['ka-identifiers'];
    const r = w.retention;
    check(
      num(r.inContext) === num(r.ids) - DROP,
      `exactly ${DROP} identifiers left the context`,
      `${r.inContext} of ${r.ids} remain`
    );
    check(
      num(r.subUnrecoverable) === 0,
      'the sub arm spilled every one it dropped, so nothing is unreachable',
      `subUnrecoverable ${r.subUnrecoverable}`
    );
    const before = num(w.payload);
    const expected = ((DROP * ID_CHARS) / before) * 100;
    check(
      Math.abs(pct(w.chars.ours) - expected) < 0.05,
      'the size saving is exactly the bytes the arm deleted',
      `${w.chars.ours} vs ${expected.toFixed(1)}% expected`
    );
    // THE THREE ARMS MUST DISAGREE, or a scorer that scored one arm three times
    // would look correct.
    check(
      pct(w.chars.preset) === 0 && pct(w.chars.ours) > 0,
      'the arm that loses nothing is scored differently from the arms that do',
      `preset ${w.chars.preset}, ours ${w.chars.ours}`
    );
  }
  // --------------------------------------------------------- profile: mirror
  // THE NULL-DIFFERENCE TEST. Our arms emit exactly their winning arm's bytes,
  // so every paired figure must come out identical -- not close, identical.
  // A residual here is the scorer treating one side differently from the other,
  // and that needs no ground truth to detect.
  //
  // The offload columns are deliberately NOT paired: theirs reads markers out
  // of their text, ours counts what our engine handed a spill sink, and given
  // the same marker text those two genuinely answer differently. That is a fact
  // about two products, not a scoring defect.
  console.log('\nprofile mirror -- paired figures must be identical');
  {
    const { run, at } = score('mirror', { mirrorDir: join(tmp, 'out') });
    check(run.status === 0 || run.status === 1, 'the scorer completes', `exit ${run.status}`);
    const rec = JSON.parse(readFileSync(at, 'utf8'));
    for (const w of rec.workloads) {
      const name = w.name;
      check(
        w.chars.ours === w.chars.theirs,
        `${name}: the same bytes score the same size saving on both sides`,
        `ours ${w.chars.ours}, theirs ${w.chars.theirs}`
      );
      check(
        w.tokens.ours === w.tokens.theirs,
        `${name}: and the same token saving, so one side is not being estimated`,
        `ours ${w.tokens.ours}, theirs ${w.tokens.theirs}`
      );
      check(
        num(w.retention.oursZeroTurn) === num(w.retention.theirsZeroTurn),
        `${name}: and the same identifiers survive on both sides`,
        `ours ${w.retention.oursZeroTurn}, theirs ${w.retention.theirsZeroTurn}`
      );
    }
    check(
      rec.totals.chars.ours === rec.totals.chars.theirs,
      'totals: no residual once every workload is summed',
      `ours ${rec.totals.chars.ours}, theirs ${rec.totals.chars.theirs}`
    );
    check(
      rec.totals.tokens.ours === rec.totals.tokens.theirs,
      'totals: and none in the token column',
      `ours ${rec.totals.tokens.ours}, theirs ${rec.totals.tokens.theirs}`
    );
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(
  failures === 0
    ? '\nthe scorer answers every question whose answer was fixed in advance'
    : `\n${failures} check(s) failed`
);
process.exit(failures === 0 ? 0 : 1);