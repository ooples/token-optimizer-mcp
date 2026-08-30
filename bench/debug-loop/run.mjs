/**
 * A debug loop, measured locally, for nothing.
 *
 * WHY THIS EXISTS. Debug loops are the family that decides the ranking: ours
 * measured 1.248 against tokenade's 0.611, and closing that gap alone moves the
 * aggregate from 0.928 to 0.811. The only harness that could tell us anything
 * about it was THOL -- ~$13 and an hour per screen -- which is far too coarse a
 * loop to design against. This runs the same shape locally, deterministically,
 * and free.
 *
 * IT MEASURES THE PREMISE BEFORE THE FIX. The proposed lever is deduplication:
 * a debug loop reruns a suite and each run dumps a wall of output that is
 * *nearly identical* to the last one. "Nearly" is doing all the work in that
 * sentence, and nobody had measured it. If consecutive runs share 95% of their
 * lines, dedup is the lever. If they share 40%, it is not, and bounding is all
 * there is. So the first number this prints is redundancy, not savings.
 *
 * REAL OUTPUT, NOT A SYNTHETIC WALL. Whoever writes the fixture chooses the
 * redundancy, and then the measurement just reports back the assumption it was
 * given. So this drives the repository's own jest against a real source file it
 * temporarily breaks, and reads the real failures.
 *
 * WHAT THE NUMBERS DO NOT SAY, and three hazards for whoever implements this:
 *
 *   1. DEDUP CAN HIDE A PERSISTENT FAILURE. If run 2 fails exactly as run 1
 *      did, every FAIL line is "repeated" and dedup omits all of them -- and a
 *      model reading "[963 lines identical, omitted]" may conclude the suite
 *      now passes. That is the same class of error as a pipeline swallowing a
 *      non-zero exit: it does not cost tokens, it costs correctness, and it
 *      stops the debugging. Any real implementation must always retain the
 *      verdict lines, however many times they repeat.
 *   2. OUR BOUND IS TAIL-ONLY; THE CLIENT'S IS NOT. The client truncates from
 *      the middle and keeps the head, where a jest run lists WHICH suites
 *      failed. An 8 KB tail is cheaper and can still be worse for the model.
 *      Cost is not the only axis, and this harness only measures cost.
 *   3. ONE FIXTURE, ONE PROJECT, ONE LOOP SHAPE. Redundancy near 94% is what
 *      THIS suite does when THIS file breaks. A loop that edits between runs in
 *      a way that shifts line numbers would repeat far less.
 *
 * THE SOURCE FILE IS RESTORED IN A `finally`, AND VERIFIED BY HASH. A harness
 * that edits real source has to be paranoid: an earlier benchmark in this
 * project pointed a write-capable tool at the repository root and overwrote
 * package.json.
 */
import { spawnSync } from 'node:child_process';
import {
  readFileSync,
  writeFileSync,
  mkdtempSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { compact } from '../../hooks-core/compact.mjs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const say = (line) => writeSync(1, `${line}\n`);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The client's own cap on Bash output: 30,000 characters, max 150,000. */
const CLIENT_CAP_CHARS = 30_000;

/** The subject: a small module with a focused suite that fails loudly. */
const SOURCE = join(ROOT, 'hooks-core', 'redact.mjs');
const SUITE = process.env.DEBUG_LOOP_SUITE || 'tests/hooks/redact.test.mjs';

/**
 * A debug loop as an agent actually produces one: a first failure, an edit that
 * turns out to change nothing, a partial fix that moves which assertions fail,
 * and the real fix. Each mutation is a single replacement in the real source.
 *
 * THE SECOND ITERATION IS THE ONE THAT WAS MISSING. The first version of this
 * file went broken -> partial -> fixed, three runs that never produced the same
 * output twice -- and a loop that never repeats itself cannot show what
 * compaction is for. An edit that leaves the tests failing exactly as they were
 * is one of the most common things that happens in a real loop, and it is
 * precisely the case where the previous run's output can be left out.
 *
 * It is also the case a naive dedup gets catastrophically wrong, by eliding the
 * unchanged failure and leaving the model to read the silence as success --
 * which is why `compact` never touches the ending.
 */
const ITERATIONS = [
  { label: 'broken', from: "let out = String(text ?? '');", to: "let out = '';" },
  {
    // A different edit with the SAME observable outcome: still empty, so every
    // assertion fails exactly as it did a moment ago.
    label: 'no-op edit',
    from: "let out = String(text ?? '');",
    to: "let out = String('');",
  },
  {
    label: 'partial fix',
    from: "let out = String(text ?? '');",
    to: "let out = String(text ?? '').slice(0, 4);",
  },
  { label: 'fixed', from: null, to: null },
];

/**
 * BOTH STREAMS, EVERY RUN. The first version returned only stdout when the
 * suite passed and stdout+stderr when it failed, so the passing iteration was
 * measured on a different quantity from the failing ones -- and jest writes its
 * report to stderr, which is exactly the wall of output a debug loop pays for.
 * A measurement whose input changes shape between arms is not a measurement.
 *
 * `spawnSync` rather than `execFileSync` because it does not throw on a
 * non-zero exit: a failing suite is the NORMAL case here, not an error. Only a
 * failure to spawn at all is worth throwing for.
 */
function runSuite(env = {}) {
  const result = spawnSync(
    process.execPath,
    [
      '--experimental-vm-modules',
      join('node_modules', 'jest', 'bin', 'jest.js'),
      SUITE,
    ],
    {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 180_000,
      env: { ...process.env, ...env },
    }
  );
  if (result.error) throw result.error;
  return `${result.stdout ?? ''}${result.stderr ?? ''}`;
}

/**
 * Two transforms, kept apart because only ONE of them is shippable.
 *
 * `stripColour` is now a BACKSTOP, not the mechanism: the wrapper asks for no
 * colour at the source, so these escapes are usually gone before the harness
 * sees them. It removes ANSI escapes. They are pure presentation -- a model
 * gains nothing from them -- and they are not a rounding error: a real failing
 * `jest tests/hooks` run measured 67,634 bytes containing 3,080 ANSI sequences,
 * so stripping alone removes 22.5% of the output. Safe, free, and it applies to
 * every coloured command rather than only to tests.
 *
 * `maskTimings` is NOT shippable and is used only to decide whether two lines
 * are "the same line": a run prints `(3 ms)` where the last printed `(4 ms)`,
 * and treating those as different would understate redundancy and make dedup
 * look worse than it is. Masking real timings in what the MODEL sees would
 * discard content it may want, so it never reaches an arm's output. Measured
 * worth 0.2% as a saving -- noise there, load-bearing as a comparison key.
 *
 * An earlier version of this file applied BOTH to the dedup arms and NEITHER to
 * the control arms, silently crediting dedup with a saving no arm performed.
 */
/**
 * How the client itself truncates: from the MIDDLE, keeping head and tail.
 *
 * Read out of the client binary, which carries both the marker format
 * `\n\n... [N characters truncated] ...\n\n` and the string `truncate-middle`.
 * Modelling it as a tail cut -- which this harness did at first -- understates
 * the baseline's quality, because the head of a failing jest run holds the FAIL
 * list while the tail holds the summary, and middle truncation keeps both.
 *
 * It also carries a warning for our own bound, which is tail-only: against a
 * baseline that preserves the head, an 8 KB tail can be WORSE for the model
 * even while being cheaper. Cost is not the only axis.
 */
function truncateMiddle(text, cap) {
  if (text.length <= cap) return text;
  const marker = `\n\n... [${text.length - cap} characters truncated] ...\n\n`;
  const half = Math.max(0, Math.floor((cap - marker.length) / 2));
  return text.slice(0, half) + marker + text.slice(text.length - half);
}

/**
 * The head+tail byte bound production applies, modelled honestly.
 *
 * BYTES, because the shell's `head -c` / `tail -c` count bytes; slicing
 * characters would model a bigger budget than the command really gets on any
 * multibyte output. And head+tail rather than a tail, because that is what
 * `boundedRewrite` emits -- the client's own truncation keeps both ends, so a
 * tail-only model would misrepresent both production and the baseline.
 */
function boundBytes(text, maxBytes) {
  const buffer = Buffer.from(text, 'utf8');
  if (buffer.length <= maxBytes) return text;

  // NO MARKER, AND THE HALVES SUM TO maxBytes. `boundedRewrite` emits the head
  // bytes and then the tail bytes and nothing else -- the shell has no way to
  // announce what it dropped -- and its two stages sum to the bound rather than
  // each being half of it. A marker here would charge the bounded arm for tokens
  // production never sends, and two floored halves would model a smaller budget
  // than the shell applies on any odd value.
  //
  // Checked against the real wrapper rather than reasoned about: at maxBytes of
  // 1, 2, 3, 7, 101 and 8000, this function and the shell pipeline return
  // byte-identical strings.
  const headBytes = Math.max(1, Math.ceil(maxBytes / 2));
  const tailBytes = Math.max(0, maxBytes - headBytes);

  return (
    buffer.subarray(0, headBytes).toString('utf8') +
    (tailBytes ? buffer.subarray(buffer.length - tailBytes).toString('utf8') : '')
  );
}

const stripColour = (text) => text.replace(/\x1b\[[0-9;]*m/g, '');
const maskTimings = (text) =>
  text.replace(/\d+(\.\d+)?\s*m?s\b/g, 'Xms').replace(/\(\d+ ms\)/g, '(Xms)');

/** Comparison keys, not output: timings masked so re-runs line up. */
const lines = (text) => maskTimings(stripColour(text)).split('\n');

const main = async () => {
  const { TokenCounter } = await import(
    `file:///${join(ROOT, 'dist', 'core', 'token-counter.js').replace(/\\/g, '/')}`
  );
  const counter = new TokenCounter();
  const { boundedRewrite } = await import(
    `file:///${join(ROOT, 'hooks-core', 'rewrite.mjs').replace(/\\/g, '/')}`
  );
  const bound = boundedRewrite('jest').maxBytes;

  const original = readFileSync(SOURCE, 'utf8');
  const originalHash = createHash('sha256').update(original).digest('hex');
  const scratch = mkdtempSync(join(tmpdir(), 'debug-loop-'));
  writeFileSync(join(scratch, 'source.bak'), original);

  const captures = [];
  try {
    for (const step of ITERATIONS) {
      if (step.from) {
        if (!original.includes(step.from)) {
          throw new Error(`fixture drift: source no longer contains ${step.from}`);
        }
        writeFileSync(SOURCE, original.replace(step.from, step.to));
      } else {
        writeFileSync(SOURCE, original);
      }
      // TWICE, BECAUSE THE ARMS ARE NOT LOOKING AT THE SAME STREAM ANY MORE.
      // The wrapper now asks for no colour at the source, so what production
      // bounds is a genuinely different byte stream -- not the coloured one with
      // the escapes modelled away afterwards. `raw` must keep the coloured run,
      // because that is what the client receives with no hook in the way.
      captures.push({
        label: step.label,
        coloured: runSuite(),
        plain: runSuite({ NO_COLOR: '1', FORCE_COLOR: '0' }),
      });
    }
  } finally {
    writeFileSync(SOURCE, original);
    const restored = createHash('sha256')
      .update(readFileSync(SOURCE, 'utf8'))
      .digest('hex');
    if (restored !== originalHash) {
      say(`RESTORE FAILED -- source backup is at ${join(scratch, 'source.bak')}`);
      process.exit(1);
    }
    rmSync(scratch, { recursive: true, force: true });
  }

  /* ---------------------------------------------------- the premise */

  say('');
  say('REDUNDANCY between consecutive runs (the premise dedup rests on)');
  say('');
  say('iteration'.padEnd(16) + 'lines'.padStart(8) + 'repeated'.padStart(10) + 'new'.padStart(8) + '   % repeated');
  say('-'.repeat(62));

  let previous = null;
  // `compacted` is the SHIPPED function, imported rather than modelled. The
  // previous arms modelled an unrestricted line dedup, which is not what we
  // ship and never will be: eliding every repeated line takes the failure of a
  // test that failed identically twice, and the model reads that as "fixed".
  // `unsafeDedup` is kept alongside it purely as the ceiling that design would
  // reach, so the price of the safety rails is visible rather than assumed.
  const arms = { raw: 0, control: 0, bounded: 0, compacted: 0, unsafeDedup: 0 };
  let previousPlain = '';

  for (const capture of captures) {
    const current = lines(capture.plain);
    const seen = previous ? new Set(previous) : new Set();
    const repeated = previous ? current.filter((l) => seen.has(l)).length : 0;
    const fresh = current.length - repeated;

    say(
      capture.label.padEnd(16) +
        String(current.length).padStart(8) +
        String(repeated).padStart(10) +
        String(fresh).padStart(8) +
        `   ${previous ? ((repeated / current.length) * 100).toFixed(1) + '%' : '-'}`
    );

    // EVERY ARM MEASURES THE SAME BASE TEXT. An earlier version of this file
    // built the dedup arms from normalised lines while control and bounded used
    // the raw capture -- so dedup was silently credited with stripping ANSI
    // colour and masking timings, work no arm had actually done. The comparison
    // has to isolate each arm's OWN transform or it flatters whichever arm the
    // author happened to normalise.
    //
    // `raw` is kept as a separate row precisely so the normalisation saving is
    // visible rather than smuggled into one arm.
    // No longer a model of anything: this IS what the command emits under the
    // wrapper. `stripColour` remains only as a belt-and-braces pass for a tool
    // that ignores NO_COLOR, and for jest it now removes nothing.
    const base = stripColour(capture.plain);
    // Emitted lines keep their real timings; only the comparison KEY is masked.
    const emitLines = base.split('\n');

    // raw: exactly what the client delivers with no hook in the way -- the
    // coloured run, at the client's own cap.
    const raw = truncateMiddle(capture.coloured, CLIENT_CAP_CHARS);
    // control: colour asked away at the source and NOTHING else -- no bound.
    // This row is now a real production step rather than a hypothetical, and it
    // is what the colour suppression is worth on its own.
    const control = truncateMiddle(base, CLIENT_CAP_CHARS);
    // bounded: what production ACTUALLY does, which is not what this arm used
    // to model. `boundedRewrite` does not strip ANSI, and it now keeps the head
    // AND the tail rather than the tail alone. Modelling it as a colour-stripped
    // tail credited the bounded arm with the 36% that stripping is worth on its
    // own -- the same arm-asymmetry defect this file already had once, in the
    // dedup arms, and missed here.
    //
    // Byte-based, not character-based, because `head -c`/`tail -c` count bytes:
    // on multibyte output a character slice would model a larger budget than
    // the shell actually applies.
    const bounded = boundBytes(base, bound);
    // compacted: what production now does. The real function, so this row cannot
    // drift from the shipped behaviour the way a modelled arm can.
    const compacted = compact(base, { previous: previousPlain, maxBytes: bound });

    // unsafeDedup: the ceiling the rails cost us. Every repeated line dropped,
    // including a failure that repeated -- which is why it is a reference point
    // and not a candidate.
    const unsafeDedup = previous
      ? boundBytes(
          `[${repeated} lines identical to the previous run, omitted]\n` +
            emitLines.filter((_line, i) => !seen.has(current[i])).join('\n'),
          bound
        )
      : boundBytes(base, bound);

    arms.raw += counter.count(raw).tokens;
    arms.control += counter.count(control).tokens;
    arms.bounded += counter.count(bounded).tokens;
    arms.compacted += counter.count(compacted).tokens;
    arms.unsafeDedup += counter.count(unsafeDedup).tokens;

    previous = current;
    previousPlain = base;
  }

  /* ------------------------------------------------------- the arms */

  say('');
  say('TOKENS reaching the model across the whole loop');
  say('');
  say('arm'.padEnd(28) + 'tokens'.padStart(10) + '   vs raw');
  say('-'.repeat(56));
  for (const [name, tokens] of Object.entries(arms)) {
    const ratio = tokens / arms.raw;
    say(
      name.padEnd(28) +
        String(tokens).padStart(10) +
        `   ${ratio.toFixed(3)}${name === 'raw' ? '' : ratio < 1 ? ' better' : ' WORSE'}`
    );
  }
  say('');
  say(
    `raw = the client's own ${CLIENT_CAP_CHARS}-char MIDDLE truncation, ANSI included; ` +
      `control = same, colour stripped; bounded = ${bound} bytes head+tail, colour KEPT; ` +
      `deduped = new lines only; combined = both.`
  );
  say(
    'raw -> control is ANSI stripping alone: presentation, safe, free, and'
  );
  say('available to every arm. Timings are masked only to compare lines.');
  say('This is one loop on one suite. It is a design instrument, not a result.');
};

main().catch((error) => {
  writeSync(2, `FAILED ${error?.stack || error}\n`);
  process.exit(1);
});
