/**
 * THE CAPTURE PATH, CHECKED AGAINST ANSWERS FIXED BEFORE IT RAN.
 *
 * WHY THIS FILE EXISTS. Every other check in this directory tests scoring
 * arithmetic on synthetic totals -- offload.check, cost-model.check,
 * base-context.check, cost-split.check all feed numbers to a pure function and
 * assert what comes back. None of them touches the path that PRODUCES those
 * numbers: exporting a fixture, handing it to an engine, recording what came
 * back. That path had no tests at all, and it is where every defect of the past
 * week actually lived -- a carrier that flattened a conversation and moved one
 * workload's figure by 200x, an arm selection that silently preferred offload,
 * a no-op that was published as the competitor achieving nothing.
 *
 * Hardening the tested half while the untested half produced the headline is
 * how "the testing is stronger now" kept being true and worthless at once.
 *
 * HOW IT WORKS. `run-theirs.py` is driven for real -- its shape routing, budget
 * sweep, scoring, arm selection, provenance and trip-wire all execute -- but
 * the innermost engine call is replaced by arms whose output is a closed-form
 * function of their input (see arms.py). So every figure the capture publishes
 * has a value computable here with arithmetic, and a mismatch is a harness bug
 * with no second explanation available. No network, no HeadRoom install, no
 * CCR store: a failure here is never a drifted capture.
 *
 * Usage: node bench/compression/known-answer/capture.check.mjs
 */

import { spawnSync } from 'node:child_process';
import { deflateSync } from 'node:zlib';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isOffloading } from '../offload.mjs';
import { stubbedCaptureRefusal } from '../capture-guard.mjs';
import { fixtures } from '../fixtures.mjs';
import {
  IDENTIFIER_COUNT,
  REPEAT_BLOCK_BYTES,
  REPEAT_COPIES,
  knownAnswerFixtures,
} from './fixtures.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..');
const RUN_THEIRS = join(REPO, 'bench', 'compression', 'headroom', 'run-theirs.py');
const ARMS = join(HERE, 'arms.py');
const EXPORT = join(REPO, 'bench', 'compression', 'export-payloads.mjs');

let failures = 0;
const check = (ok, name, detail = '') => {
  if (ok) console.log(`  ok   ${name}${detail ? `  (${detail})` : ''}`);
  else {
    failures++;
    console.log(`  FAIL ${name}${detail ? `  (${detail})` : ''}`);
  }
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// THE CHECKER ITSELF GETS A POSITIVE CONTROL, for the same reason the trip-wire
// does: a checker that cannot fail proves nothing by passing.
{
  const before = failures;
  const say = console.log;
  console.log = () => {};
  check(false, 'self-test');
  console.log = say;
  if (failures !== before + 1) {
    console.log('  FAIL the checker does not count a failure; every result below is void');
    process.exit(1);
  }
  failures = before;
  console.log('  ok   the checker counts a failure when one is handed to it');
}

const tmp = mkdtempSync(join(tmpdir(), 'ka-capture-'));
const KA = knownAnswerFixtures();

try {
  // ---------------------------------------------------------------- premises
  // The two entropy fixtures are the foundation of layer 2's false-saving
  // detector, so their premises are verified rather than asserted in a comment.
  // `deflate` is the witness: it is a general-purpose lossless coder, so what
  // it achieves is a lower bound on the redundancy that actually exists.
  console.log('\nfixture premises (verified, not assumed)');
  {
    const inc = KA.find((f) => f.name === 'ka-incompressible');
    const text = inc.native[0].content;
    const ratio = deflateSync(Buffer.from(text)).length / text.length;
    // 6 bits per byte by construction => ~0.75 bytes of information per byte.
    check(
      ratio > 0.7 && ratio <= 1.05,
      'ka-incompressible really has no redundant structure to find',
      `deflate ${(ratio * 100).toFixed(1)}% of original, expected ~75%`
    );

    const rep = KA.find((f) => f.name === 'ka-repeated');
    const rtext = rep.native[0].content;
    const rratio = deflateSync(Buffer.from(rtext)).length / rtext.length;
    check(
      rratio < 0.1,
      'ka-repeated really is almost entirely redundant',
      `deflate ${(rratio * 100).toFixed(1)}% of original`
    );
    check(
      rtext.length === (REPEAT_BLOCK_BYTES + 1) * REPEAT_COPIES,
      'ka-repeated holds exactly the copies it claims',
      `${rtext.length} bytes`
    );

    const idf = KA.find((f) => f.name === 'ka-identifiers');
    const blob = JSON.stringify(idf.native);
    const once = idf.ids.filter(
      (id) => blob.split(id).length - 1 === 1
    ).length;
    check(
      once === IDENTIFIER_COUNT,
      'ka-identifiers holds each of its tokens exactly once',
      `${once}/${IDENTIFIER_COUNT}`
    );
  }

  // ------------------------------------------------------- the known-answer run
  const natives = join(tmp, 'natives.json');
  writeFileSync(
    natives,
    JSON.stringify(Object.fromEntries(KA.map((f) => [f.name, f.native]))),
    'utf8'
  );

  const outDir = join(tmp, 'out');
  const run = spawnSync(
    'python',
    [RUN_THEIRS, '-', outDir, '--extra', natives],
    { encoding: 'utf8', env: { ...process.env, BENCH_KNOWN_ANSWER_ARMS: ARMS } }
  );

  console.log('\ncapture path, driven by arms with closed-form output');
  check(run.status === 0, 'the capture completes', `exit ${run.status}`);
  if (run.status !== 0) {
    console.log(run.stdout);
    console.log(run.stderr);
    throw new Error('known-answer capture did not run; nothing below is meaningful');
  }

  const payloads = JSON.parse(readFileSync(join(outDir, 'payloads.json'), 'utf8'));
  const theirs = JSON.parse(readFileSync(join(outDir, 'theirs.json'), 'utf8'));
  const prov = theirs.__provenance__;

  check(
    typeof prov.stubArms === 'string' && prov.stubArms.length > 0,
    'the capture stamps itself as stubbed, so it can never be read as a result',
    prov.stubArms ? 'stubArms set' : 'stubArms EMPTY'
  );
  check(
    KA.every((f) => theirs[f.name]),
    'every workload handed in comes back out',
    `${KA.filter((f) => theirs[f.name]).length}/${KA.length}`
  );

  for (const f of KA) {
    const t = theirs[f.name];
    if (!t) continue;
    const payload = payloads[f.name];
    console.log(`\n  ${f.name}`);

    // The denominator every ratio is divided by must be the bytes our side is
    // scored on. A drift here rescales every published figure at once.
    check(
      t.before === payload.length,
      'the before-size is the length of the payload our side compresses',
      `${t.before} vs ${payload.length}`
    );
    check(
      t.beforeTokens === Math.max(1, Math.floor(t.before / 4)),
      'tokens are tokens, not characters',
      `${t.beforeTokens} for ${t.before} chars`
    );

    // Closed-form arm outputs.
    check(
      t.armTexts['ka-identity'] === payload,
      'the identity arm was handed exactly the payload, byte for byte'
    );
    check(
      t.armTexts['ka-half'] === payload.slice(0, Math.floor(payload.length / 2)),
      'the halving arm returned exactly half, so its ratio is arithmetic',
      `${t.armTexts['ka-half'].length} of ${payload.length}`
    );
    check(
      isOffloading(t.armTexts['ka-offload']),
      'the offload arm is recognised as offload and not as compression'
    );

    // Selection and publication must follow from those outputs.
    const ratios = Object.fromEntries(
      Object.keys(t.armTexts).map((label) => [
        label,
        t.armTexts[label].length / t.armBeforeTexts[label].length,
      ])
    );
    const argmin = Object.keys(ratios).reduce((a, b) =>
      ratios[b] < ratios[a] ? b : a
    );
    check(
      t.arm === argmin && t.arm === 'ka-offload',
      'the published arm is the smallest-ratio arm',
      `${t.arm}, argmin ${argmin}`
    );
    check(
      t.after === Math.round(t.before * ratios[t.arm]),
      'the published after-size is the winner ratio applied to the before-size',
      `${t.after} vs ${Math.round(t.before * ratios[t.arm])}`
    );
    check(
      t.afterTokens === Math.max(1, Math.round(t.beforeTokens * ratios[t.arm])),
      'after-tokens follow the same ratio as after-chars'
    );

    // EVERY PUBLISHED PER-ARM SIZE, RE-DERIVED FROM THE TEXTS BESIDE IT.
    // `arms` is a rescaled ratio, not a byte count, so it can drift from the
    // texts it claims to summarise without anything looking wrong -- and the
    // drift that matters is the denominator. The pipeline arms are scored
    // against the tool_result envelope THIS HARNESS added, not against the raw
    // payload; charge them the raw payload instead and every one of their
    // conversation ratios moves, in our favour, silently. Recomputing each arm
    // from `armTexts` over `armBeforeTexts` is the only thing that sees it.
    const wrong = Object.keys(t.armTexts).filter(
      (label) => t.arms[label] !== Math.round(ratios[label] * t.before)
    );
    check(
      wrong.length === 0,
      "each arm's published size is its own texts' ratio, on its own denominator",
      wrong.length ? wrong.join(',') : `${Object.keys(t.armTexts).length} arms agree`
    );
    check(
      t.armBeforeTexts['ka-identity'] === payload,
      'a text arm is scored against the payload, with no envelope added'
    );

    // AN ARM THAT PRODUCED NOTHING MUST BE ABSENT, NOT SCORED AS A NO-OP.
    // Recording a crash or a decline at ratio 1.0 is a fabricated measurement
    // that reads, every time, as the competitor achieving nothing on that
    // workload. This project has shipped that error before.
    const pipelineLabels = Object.keys(t.armTexts).filter((l) => l.startsWith('pipeline@'));
    if (f.pipelineDeclines) {
      check(
        pipelineLabels.length === 0,
        'an engine that declined is absent from the arms, not recorded at 1.0',
        `${pipelineLabels.length} pipeline arms recorded`
      );
      check(
        Object.keys(t.arms).length === Object.keys(t.armTexts).length,
        'and the scored arms are exactly the arms that produced text',
        `${Object.keys(t.arms).length} scored, ${Object.keys(t.armTexts).length} with text`
      );
      continue;
    }
    if (f.armRaises) {
      check(
        !(f.armRaises in t.armTexts) && !(f.armRaises in t.arms),
        `an arm that threw (${f.armRaises}) is absent from the arms`,
        Object.keys(t.arms).join(',')
      );
      check(
        typeof t.notes?.[f.armRaises] === 'string' &&
          t.notes[f.armRaises].includes('RuntimeError'),
        'and its exception is recorded rather than swallowed',
        t.notes?.[f.armRaises] ?? 'no note'
      );
    } else {
      check(
        t.armTexts['ka-fragile'] === payload.slice(0, Math.floor(payload.length / 4)),
        'the quarter arm returned exactly a quarter'
      );
    }

    // THE CARRIER. `arms.py:apply` is an identity, so this field holds the exact
    // shape the harness handed the engine. The bug that cost a week is visible
    // here and nowhere else -- it never changed a single one of the sizes above.
    const fed = JSON.parse(t.armTexts['pipeline@1.00']);
    const wrapped = JSON.stringify(fed).includes('"tool_result"');
    if (f.kind === 'messages') {
      check(
        same(fed, f.native),
        'a conversation reaches the engine as itself, unwrapped and unreordered',
        `${fed.length} messages in, ${f.native.length} out`
      );
      check(
        !wrapped,
        'and is never stuffed inside a synthetic tool_result -- the 200x bug'
      );
    } else {
      check(
        Array.isArray(fed) && fed.length === 3 && wrapped,
        'a tool output reaches the engine in the three-message envelope a proxy sends',
        `${fed.length} messages`
      );
      const block = fed[2]?.content?.[0];
      check(
        block?.type === 'tool_result' && block.content === payload,
        'with the payload intact inside it, neither truncated nor re-encoded'
      );
      check(!same(fed, f.native), 'and is not passed through as if it were a conversation');
    }
  }

  // ------------------------------------------------------------- the trip-wire
  console.log('\ninert-arm trip-wire, both directions');
  const inert = prov.inertArms;
  check(
    inert['ka-identity']?.returnedInputUnchanged === KA.length &&
      inert['ka-identity']?.ranOn === KA.length,
    'an arm that returns its input is counted on every workload',
    `${inert['ka-identity']?.returnedInputUnchanged}/${inert['ka-identity']?.ranOn}`
  );
  check(
    run.stdout.includes('WARNING: arm ka-identity'),
    'and says so out loud, rather than publishing the silence as a win'
  );
  check(
    inert['ka-half']?.returnedInputUnchanged === 0,
    'an arm that really reduced is NOT counted inert -- the negative control',
    `${inert['ka-half']?.returnedInputUnchanged} of ${inert['ka-half']?.ranOn}`
  );
  check(
    !run.stdout.includes('WARNING: arm ka-half'),
    'and draws no warning'
  );
  // `ranOn` is the denominator of the whole trip-wire. If a workload where the
  // arm never produced anything were counted in it, the ratio would be diluted
  // and a fully inert arm could slip under the 50% threshold unreported.
  check(
    inert['ka-fragile']?.ranOn === KA.length - 1,
    'an arm that threw is left out of its own trip-wire denominator',
    `${inert['ka-fragile']?.ranOn} of ${KA.length} workloads`
  );
  check(
    inert['pipeline@1.00']?.ranOn === KA.length - 1,
    'and so is an engine that declined',
    `${inert['pipeline@1.00']?.ranOn} of ${KA.length} workloads`
  );

  // --------------------------------------------------------- refusal controls
  // A guard that has never been seen to fire is a guard nobody has tested.
  console.log('\nrefusals (each must fail, and fail loudly)');
  {
    const flatDir = join(tmp, 'flat');
    const flat = spawnSync(
      'python',
      [RUN_THEIRS, '-', flatDir, '--extra', join(outDir, 'payloads.json')],
      { encoding: 'utf8', env: { ...process.env, BENCH_KNOWN_ANSWER_ARMS: ARMS } }
    );
    const said = `${flat.stdout}${flat.stderr}`;
    check(flat.status !== 0, 'a conversation flattened to text is refused', `exit ${flat.status}`);
    check(said.includes('flattened to text'), 'with a message naming the cause');
    check(
      !existsSync(join(flatDir, 'theirs.json')),
      'and writes no capture, so the bad shape cannot be scored by accident'
    );
  }
  {
    // The stamp is only worth writing if something reads it. A stub capture is
    // a complete, well-formed, entirely fictional result set; if the scorer
    // would accept one, this whole rig becomes a way to manufacture a win.
    check(
      (stubbedCaptureRefusal(theirs, 'd') ?? '').includes('stub arms'),
      'a stubbed capture is refused by the guard'
    );
    check(
      stubbedCaptureRefusal({ __provenance__: { stubArms: null } }) === null &&
        stubbedCaptureRefusal({}) === null,
      'and a real capture is not -- the guard is not simply always refusing'
    );

    // THE WIRING, WHICH IS A SEPARATE CLAIM FROM THE GUARD WORKING. Running the
    // scorer needs tiktoken and a built dist/, which a clean CI checkout of
    // this job does not have. Rather than skip the case there -- a skipped case
    // is invisible in a count of passes -- the weaker source-level assertion is
    // made instead, and which one ran is printed.
    const scorer = join(REPO, 'bench', 'compression', 'head-to-head.mjs');
    if (existsSync(join(REPO, 'dist', 'compress', 'router.js'))) {
      const scored = spawnSync('node', [scorer, outDir], { encoding: 'utf8' });
      const said = `${scored.stdout}${scored.stderr}`;
      check(
        scored.status !== 0 && said.includes('stub arms'),
        'and the scorer, actually run, exits rather than publishing it',
        `exit ${scored.status}`
      );
    } else {
      const src = readFileSync(scorer, 'utf8');
      check(
        src.includes('stubbedCaptureRefusal(theirs') && src.includes('process.exit(2)'),
        'and the scorer calls the guard (source-level: dist/ absent, so it was not run)'
      );
    }
  }
  {
    const emptyDir = join(tmp, 'empty');
    const empty = spawnSync('python', [RUN_THEIRS, '-', emptyDir], { encoding: 'utf8' });
    check(empty.status !== 0, 'a run with no workloads at all is refused', `exit ${empty.status}`);
    check(
      !existsSync(join(emptyDir, 'theirs.json')),
      'and writes no capture'
    );
  }

  // ------------------------------------------------- the real corpus's export
  // The one part of the capture path the stub arms cannot reach: our twelve
  // fixtures must leave `fixtures.mjs` in the shape their engine reads as a
  // conversation. This is the step that, done wrong, produced the flattened
  // captures in the first place.
  console.log('\nexport of the real corpus');
  {
    const exported = join(tmp, 'real.json');
    const ex = spawnSync('node', [EXPORT, exported], { encoding: 'utf8' });
    check(ex.status === 0, 'the exporter runs', `exit ${ex.status}`);
    if (ex.status === 0) {
      const got = JSON.parse(readFileSync(exported, 'utf8'));
      const ours = fixtures();
      check(
        Object.keys(got).length === ours.length,
        'every fixture is exported',
        `${Object.keys(got).length} of ${ours.length}`
      );
      const mismatched = ours.filter((f) => !same(got[f.name], f.request?.messages));
      check(
        mismatched.length === 0,
        'each one exported as its own message list, unaltered',
        mismatched.length ? mismatched.map((f) => f.name).join(', ') : 'all identical'
      );
      const notLists = Object.entries(got).filter(
        ([, m]) => !Array.isArray(m) || !m.length || !m.every((x) => typeof x?.role === 'string')
      );
      check(
        notLists.length === 0,
        'and in a shape their `is_messages` routes to the conversation path',
        notLists.length ? notLists.map(([n]) => n).join(', ') : 'all message lists'
      );
    }
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(failures === 0 ? '\nall checks pass' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
