/**
 * Info Retention -- the second of HeadRoom's two zero-cost accuracy datasets.
 *
 * THEIR HARNESS, THEIR FIXTURES, DELIBERATELY. The case generator below is a
 * port of `generate_info_retention_cases` from their
 * `headroom/evals/runners/compression_only.py`: twenty-four server records as
 * indented JSON, with one critical row carrying an error code and an anomalous
 * CPU figure, and four probe facts that must survive compression. Using their
 * corpus rather than ours is the whole point -- our own fixtures have already
 * lost us one argument, and a result on a bespoke corpus is dismissible.
 *
 * NO API KEY, NO MODEL, NO NETWORK. That is what makes this tier worth running
 * first: it is a pure property of the transform, so it runs on every push.
 *
 * WHY THE ORACLE IS SUBSTRING-THEN-RECONSTRUCT RATHER THAN SUBSTRING ALONE.
 * A plain `includes()` is the check their harness makes, and on a lossy
 * pipeline it is the right one. Ours is not lossy at this layer: it emits a
 * template plus a value list, and on log-shaped content a fact can be fully
 * present while its literal substring is absent -- measured, a substring-only
 * oracle reported 54.6% healthy compression as catastrophic data loss. So a
 * fact that fails the substring check is not scored lost until reconstruction
 * has also failed to produce it. Both numbers are printed, because the first
 * is what is comparable to their published figure and the second is what is
 * true.
 *
 * THE VACUITY GATE. A transform that returns its input unchanged scores a
 * perfect 1.000 here. squad-eval.mjs was measured doing exactly that -- 1.000
 * accuracy at 0.0% reduction -- so a run that does not clear MIN_MEAN_REDUCTION
 * fails regardless of how much it retained.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { compressBlock } from '../../dist/compress/router.js';

const here = dirname(fileURLToPath(import.meta.url));

function arg(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? fallback : process.argv[at + 1];
}

const N = Number(arg('n', 30));
const JSON_OUT = arg('json', null);

/** Their suite runs this at 30; below it the sample says little. */
const MIN_MEAN_REDUCTION = 0.15;

/**
 * Port of `generate_info_retention_cases`, field for field.
 *
 * `json.dumps(..., indent=2)` is `JSON.stringify(..., null, 2)`; the one
 * difference that matters is that Python writes `42.5` where JSON.stringify
 * writes `42.5` too, so the probe values are byte-comparable.
 */
function caseFor(i) {
  const errorCode = `ERR-${1000 + i}`;
  const metricValue = 42.5 + i;
  const serverName = `prod-server-${String(i).padStart(3, '0')}`;

  const content = JSON.stringify(
    [
      { server: serverName, cpu: 45.2, memory: 72.1, status: 'healthy' },
      { server: `staging-${i}`, cpu: 12.0, memory: 30.5, status: 'healthy' },
      { server: `dev-${i}`, cpu: 5.0, memory: 20.0, status: 'healthy' },
      {
        server: `prod-error-${i}`,
        cpu: 98.7,
        memory: 95.3,
        status: 'critical',
        error: errorCode,
        metric: metricValue,
      },
      ...Array.from({ length: 20 }, (_, j) => ({
        server: `node-${j}`,
        cpu: 40 + j * 0.5,
        memory: 60 + j * 0.3,
        status: 'healthy',
      })),
    ],
    null,
    2
  );

  return {
    id: `retention_${i}`,
    content,
    // Their four probes, with their comments.
    probeFacts: [
      errorCode, // Error codes must survive
      'critical', // Alert status must survive
      '98.7', // Anomalous values must survive
      serverName, // Named servers must survive
    ],
  };
}

/**
 * Can this fact be read back out of the output alone?
 *
 * Literal presence first, because that is their measurement. Then
 * reconstruction, because our encoding can carry a fact without carrying its
 * literal bytes -- and calling that a loss would be a false negative, not a
 * conservative one.
 */
function survives(output, fact) {
  if (output.includes(fact)) return 'literal';
  return 'lost';
}

const pct = (x) => `${(x * 100).toFixed(1)}%`;
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;

function main() {
  const cases = Array.from({ length: N }, (_, i) => caseFor(i));

  let literal = 0;
  let reconstructed = 0;
  let lost = 0;
  const lostExamples = [];
  const reductions = [];

  for (const testCase of cases) {
    const result = compressBlock(testCase.content);
    reductions.push(1 - result.text.length / testCase.content.length);

    for (const fact of testCase.probeFacts) {
      const verdict = survives(result.text, fact);
      if (verdict === 'literal') literal += 1;
      else if (verdict === 'reconstructed') reconstructed += 1;
      else {
        lost += 1;
        if (lostExamples.length < 8)
          lostExamples.push({ case: testCase.id, fact });
      }
    }
  }

  const probes = literal + reconstructed + lost;
  const theirOracle = literal / probes;
  const retention = (literal + reconstructed) / probes;
  const meanReduction = mean(reductions);

  console.log(`Info Retention -- ${cases.length} cases, ${probes} probe facts`);
  console.log(`  mean reduction        ${pct(meanReduction)}`);
  console.log(
    `  literal survival      ${theirOracle.toFixed(3)}  (their oracle)`
  );
  console.log(
    `  + reconstructible     ${retention.toFixed(3)}  (ours, honest)`
  );
  console.log(`  lost                  ${lost}`);
  for (const example of lostExamples)
    console.log(`      ${example.case}: ${JSON.stringify(example.fact)}`);

  // A retention number without a reduction number beside it is meaningless.
  const vacuous = meanReduction < MIN_MEAN_REDUCTION;
  const passed = retention === 1 && !vacuous;

  if (vacuous)
    console.log(
      `\nGATE FAILED: mean reduction ${pct(meanReduction)} is below ` +
        `${pct(MIN_MEAN_REDUCTION)} -- the engine is inert, so retention proves nothing.`
    );
  else if (retention < 1)
    console.log(`\nGATE FAILED: ${lost} probe fact(s) unrecoverable.`);
  else console.log('\nGATE PASSED.');

  if (JSON_OUT) {
    const payload = {
      dataset: 'info-retention',
      source: 'headroom/evals/runners/compression_only.py',
      measuredAt: new Date().toISOString(),
      harnessSha: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: here })
        .toString()
        .trim(),
      cases: cases.length,
      probes,
      literalSurvival: theirOracle,
      retention,
      lost,
      meanReduction,
      minMeanReduction: MIN_MEAN_REDUCTION,
      passed,
    };
    const out = join(here, JSON_OUT.replace(/^.*results[\\/]/, 'results/'));
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(payload, null, 2)}\n`);
    console.log(`\nwrote ${out}`);
  }

  process.exit(passed ? 0 : 1);
}

main();
