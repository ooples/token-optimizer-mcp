/**
 * The battery.
 *
 * THE ADVERSARIAL SET IS NOT DECORATION. This benchmark is written by the
 * authors of one of the tools it measures, so the only thing standing between
 * it and "the vendor picked tasks that suit them" is a set of families where
 * our own approach cannot possibly help -- declared as such, run every time,
 * and reported first.
 *
 * A cache, an index and a knowledge graph all pay off by REUSE. So the
 * adversarial families are the ones with nothing to reuse:
 *
 *   single-shot   one question, one answer, no second look at anything
 *   novel-repo    a codebase seen for the first time, used once
 *   generation    output invented rather than located, so no index helps
 *
 * If our arm does not lose, or at best draw, on these, the correct conclusion
 * is that the task is not actually adversarial and needs replacing -- not that
 * we have discovered something.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';

/** Reads a workspace file, returning '' rather than throwing on absence. */
const read = (dir, rel) => {
  try {
    return readFileSync(join(dir, rel), 'utf8');
  } catch {
    return '';
  }
};

const write = (dir, rel, text) => {
  const path = join(dir, rel);
  // `dirname`, not `join(path, '..')`. The two agree on ordinary input and
  // diverge on the edges -- a `rel` with a trailing separator makes `join`
  // resolve one level too high, silently creating the wrong directory and
  // writing the fixture outside the tree the verifier reads. Naming the parent
  // directly cannot go wrong that way.
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};

/**
 * REUSE-FRIENDLY: a multi-file debug loop.
 *
 * The family we measure worst on, and the one an index should help most: the
 * agent must find where a symbol lives, across several modules, more than once.
 */
export const debugPipeline = {
  id: 'debug-pipeline-py',
  family: 'debug',
  adversarial: false,
  tracks: ['cold', 'warm'],
  // REDESIGNED FOR LOWER PATH DEPENDENCE, on measured evidence.
  //
  // The first version ran 8 to 13 turns across 36 reps -- a 1.9x cost spread
  // with a long right tail -- and never converged to a 10% interval at n=12 on
  // either track. Note what the data did NOT show: the distribution is
  // 8 8 9x8 10x10 11x11 12 12 13x3, which is smooth and unimodal. I had twice
  // called this task bimodal, carrying that word over from THOL's similarly
  // named task without checking my own.
  //
  // The cause is discretionary exploration: cost tracks turns at corr 0.898,
  // and the necessary work here is about five turns, so anything from three to
  // eight further turns of looking around is pure variance. The lever is
  // therefore to shrink DISCRETION, not to shrink the task -- the bug must
  // still be found and fixed.
  //
  // Two changes, neither of which does the work for the agent: the failing
  // assertion now names the function it is testing, so discovering WHERE to
  // look is not itself a search; and the module is stated in the prompt. What
  // remains is the actual debugging -- reading `lstrip`, knowing it strips only
  // one side, and choosing `strip`.
  prompt:
    'Running `python -m pytest -q` fails one test in tests/test_pipeline.py, which exercises ' +
    '`normalise` in pipeline/clean.py. Fix the bug in that function so the test passes. ' +
    'Do not weaken, skip, or delete any test, and change no other file.',
  setup(dir) {
    write(dir, 'pipeline/parse.py', [
      'def parse_line(raw):',
      '    parts = raw.split(",")',
      '    return {"id": parts[0], "value": parts[1]}',
      '',
    ].join('\n'));
    // The bug: strips the wrong side, so trailing whitespace survives.
    write(dir, 'pipeline/clean.py', [
      'def normalise(record):',
      '    """Trim surrounding whitespace from the record value."""',
      '    record["value"] = record["value"].lstrip()',
      '    return record',
      '',
    ].join('\n'));
    write(dir, 'tests/test_pipeline.py', [
      'from pipeline.parse import parse_line',
      'from pipeline.clean import normalise',
      '',
      'def test_normalise_trims_both_sides():',
      '    got = normalise(parse_line("a,  b  "))["value"]',
      '    assert got == "b", f"normalise left {got!r}; expected both sides trimmed"',
      '',
    ].join('\n'));
  },
  checks: [
    {
      name: 'bug is actually fixed',
      weight: 3,
      run: (dir) => /\.strip\(\)/.test(read(dir, 'pipeline/clean.py')),
    },
    {
      // WEIGHTED HEAVILY AND DELIBERATELY. The cheapest way to make a suite
      // pass is to delete the test, and an agent under token pressure is more
      // likely to try it. If that earned full marks the benchmark would reward
      // the behaviour it exists to detect.
      //
      // CHECKED AS THREE INDEPENDENT FACTS, not as one source line. The previous
      // form matched the whole expression on a single line; redesigning the
      // fixture to a two-line `got = ...` / `assert got == ...` shape then made
      // the check unsatisfiable, and a PERFECTLY fixed workspace scored 0.571
      // for ten reps across two arms. Three separate verifiers in this file
      // have now been coupled to exact source text, so the rule is: assert the
      // facts that must hold, never the layout they happen to be written in.
      name: 'test still asserts the original behaviour',
      weight: 3,
      run: (dir) => {
        const src = read(dir, 'tests/test_pipeline.py');
        return (
          /normalise\s*\(\s*parse_line\s*\(/.test(src) && // still exercises both
          /"a,\s+b\s+"/.test(src) && // still uses the padded input
          /==\s*"b"/.test(src) // still demands both sides trimmed
        );
      },
    },
    {
      name: 'parser left intact',
      weight: 1,
      run: (dir) => /def parse_line/.test(read(dir, 'pipeline/parse.py')),
    },
  ],
};

/**
 * ADVERSARIAL: single-shot factual extraction.
 *
 * One file, read once, answered once. There is no second lookup for an index to
 * save and no prior session for a graph to remember, so any per-session setup
 * cost our product pays is pure loss here. That is exactly why it is in the set.
 */
export const singleShotExtract = {
  id: 'single-shot-extract',
  family: 'single-shot',
  adversarial: true,
  tracks: ['cold', 'warm'],
  prompt:
    'Read config/service.toml and write the value of the `timeout_ms` key, and nothing else, ' +
    'into ANSWER.txt at the repository root.',
  setup(dir) {
    write(dir, 'config/service.toml', [
      '[server]',
      'host = "0.0.0.0"',
      'port = 8080',
      'timeout_ms = 4500',
      'retries = 3',
      '',
    ].join('\n'));
  },
  checks: [
    { name: 'answer file exists', weight: 1, run: (dir) => existsSync(join(dir, 'ANSWER.txt')) },
    { name: 'answer is correct', weight: 3, run: (dir) => read(dir, 'ANSWER.txt').trim() === '4500' },
  ],
};

/**
 * ADVERSARIAL: pure generation.
 *
 * The output does not exist anywhere to be found, so nothing can be retrieved,
 * cached or indexed into place. Any mechanism that works by locating existing
 * code has nothing to contribute and only its overhead to charge.
 */
export const pureGeneration = {
  id: 'pure-generation',
  family: 'generation',
  adversarial: true,
  tracks: ['cold', 'warm'],
  prompt:
    'Create util/backoff.py containing a function `delays(attempts, base_ms)` that returns a list ' +
    'of exponential backoff delays in milliseconds, doubling from base_ms, capped at 30000.',
  setup(dir) {
    write(dir, 'README.md', '# scratch project\n');
  },
  checks: [
    { name: 'file created', weight: 1, run: (dir) => existsSync(join(dir, 'util/backoff.py')) },
    {
      name: 'function defined',
      weight: 1,
      run: (dir) => /def\s+delays\s*\(\s*attempts\s*,\s*base_ms\s*\)/.test(read(dir, 'util/backoff.py')),
    },
    {
      // A CHECK MUST ACCEPT EVERY CORRECT ANSWER, not the one the author had in
      // mind. This originally required `/(\*\s*2|<<\s*1|2\s*\*\*)/`, which does
      // NOT match `delay *= 2` -- the `=` sits between the `*` and the `2` -- so
      // the most idiomatic Python solution scored 2 of 4. Measured against the
      // control arm on eight reps, completion came out at 25%: vanilla Claude
      // Code writing correct, documented code and being marked wrong.
      //
      // That is the benchmark measuring its own verifier rather than the agent,
      // and it is the failure mode a syntactic check is most prone to. The
      // robust form is BEHAVIOURAL -- run the function and compare its output --
      // which is deliberately not done here because it would mean executing
      // agent-generated code on the host. Until the verifier can run inside the
      // sandbox, the regex must be generous about spelling and strict only
      // about the two facts that matter: it doubles, and it caps.
      name: 'doubles and caps',
      weight: 2,
      run: (dir) => {
        const src = read(dir, 'util/backoff.py');
        const caps = /30_?000/.test(src);
        const doubles = /(\*=\s*2|\*\s*2|2\s*\*\*|<<)/.test(src);
        return caps && doubles;
      },
    },
  ],
};

/**
 * REUSE-FRIENDLY: the same codebase, asked about repeatedly.
 *
 * The warm track's reason for existing. On the cold track this is one ordinary
 * comprehension task; run as part of a warm sequence it is the second and third
 * visit to a tree already indexed, which is the condition our product claims to
 * exploit and which the previous harness could not create.
 */
export const repeatComprehension = {
  id: 'repeat-comprehension',
  family: 'comprehension',
  adversarial: false,
  tracks: ['warm'],
  prompt:
    'Write to SYMBOLS.txt, one per line, the file path and line number where each of these is ' +
    'defined: parse_line, normalise. Use the form `name path:line`.',
  setup(dir) {
    debugPipeline.setup(dir);
  },
  checks: [
    { name: 'answer file exists', weight: 1, run: (dir) => existsSync(join(dir, 'SYMBOLS.txt')) },
    {
      name: 'parse_line located',
      weight: 2,
      run: (dir) => /parse_line\s+pipeline\/parse\.py:1\b/.test(read(dir, 'SYMBOLS.txt')),
    },
    {
      name: 'normalise located',
      weight: 2,
      run: (dir) => /normalise\s+pipeline\/clean\.py:1\b/.test(read(dir, 'SYMBOLS.txt')),
    },
  ],
};

/**
 * REUSE-FRIENDLY, AND THE ONLY TASK BIG ENOUGH TO TEST AN INDEX.
 *
 * WHY THIS EXISTS. The first full campaign concluded that the project index
 * bought nothing measurable -- and then the fixtures were measured: the largest
 * was THREE FILES, 342 bytes. An index over three files cannot save anything,
 * because the model can read the whole repository in one turn. That result was
 * a fact about the battery, not about the feature, and acting on it would have
 * retired a capability using an instrument incapable of detecting it.
 *
 * So this task generates a repository where locating a symbol is genuinely
 * work: eighty modules, each with several plausible functions, exactly one of
 * which contains the target. Without an index the agent must search; with one
 * it can be told where to go. If the seed does not pay HERE, that is a real
 * finding rather than an artefact of fixture size.
 *
 * Deterministic: the same eighty files every run, so the search difficulty is
 * identical across arms and reps.
 */
const MODULE_COUNT = 80;

export const needleInRepo = {
  id: 'needle-in-repo',
  family: 'locate',
  adversarial: false,
  tracks: ['cold', 'warm'],
  prompt:
    'There is a bug in the function `compute_settlement_fee`: it rounds the amount BEFORE ' +
    'applying the rate, which loses precision. Fix it so the rate is applied first and the ' +
    'result is rounded afterwards. Change nothing else.',
  setup(dir) {
    for (let i = 0; i < MODULE_COUNT; i++) {
      const name = `mod_${String(i).padStart(3, '0')}`;
      const lines = [
        `"""Module ${name}."""`,
        '',
        `def ${name}_load(raw):`,
        '    return [line.strip() for line in raw.splitlines() if line.strip()]',
        '',
        `def ${name}_summarise(rows):`,
        '    return {"count": len(rows)}',
        '',
      ];
      // The needle, in one module only, at a position that varies with nothing.
      if (i === 47) {
        lines.push(
          'def compute_settlement_fee(amount, rate):',
          '    """Fee for a settlement, in whole cents."""',
          '    return round(amount) * rate',
          ''
        );
      }
      write(dir, `pkg/${name}.py`, lines.join('\n'));
    }
    write(dir, 'README.md', '# ledger service\n\nSettlement and reporting helpers.\n');
  },
  checks: [
    {
      name: 'the fix is applied',
      weight: 3,
      run: (dir) => /return\s+round\s*\(\s*amount\s*\*\s*rate\s*\)/.test(read(dir, 'pkg/mod_047.py')),
    },
    {
      // The old expression must be GONE, not merely joined by a new one -- an
      // agent that adds a corrected line beside the broken one has not fixed it.
      name: 'the broken expression is gone',
      weight: 2,
      run: (dir) => !/round\s*\(\s*amount\s*\)\s*\*\s*rate/.test(read(dir, 'pkg/mod_047.py')),
    },
    {
      // Guards against the cheapest wrong answer: rewriting half the repository
      // until something matches.
      name: 'the rest of the repository is untouched',
      weight: 2,
      run: (dir) => {
        for (const i of [0, 12, 46, 48, 79]) {
          const name = `mod_${String(i).padStart(3, '0')}`;
          if (!new RegExp(`def ${name}_load`).test(read(dir, `pkg/${name}.py`))) return false;
        }
        return true;
      },
    },
  ],
};

/**
 * The golden solution for each task: what a correct agent would leave behind.
 *
 * THE DEFECT CLASS THIS CLOSES. Three verifiers in this file have shipped
 * coupled to exact source text -- a doubling regex that could not match
 * `delay *= 2`, and an assertion matcher that broke the moment its own fixture
 * was reformatted. Each cost a campaign: the second scored a PERFECTLY fixed
 * workspace at 0.571 for ten reps across two arms before anyone noticed, and
 * the only reason it was caught is that completion came back at 0%.
 *
 * A check can only be trusted if a known-correct answer passes it. So every
 * task declares how to produce one, and a test applies it and demands 1.000.
 * That converts "did I write the regex correctly" from a judgement into an
 * assertion, and it runs for free.
 */
/**
 * THE TASK THAT DECIDES WHETHER AN INDEX CAN PAY AT ALL.
 *
 * Built before the mechanism it is meant to justify, deliberately. Two previous
 * attempts failed to exercise the feature: fixtures of three files, then an
 * 81-file repo where naming the symbol reduced "find it" to one grep. Both
 * produced clean nulls that said nothing about the feature.
 *
 * WHAT AN INDEX CAN DO THAT GREP CANNOT. Grep returns matching TEXT: a widely
 * used helper's name appears once at its definition and once at every call
 * site, all mixed together and indistinguishable by line content. An index
 * knows which one is the DEFINITION. So the value case is not "where does this
 * string appear" -- grep answers that in one turn and cannot be beaten -- but
 * "which of these forty hits is the thing I need to edit".
 *
 * Here the target is called from forty other modules, so grepping its name
 * returns forty-one hits and the definition has to be picked out. If the
 * control arm does NOT spend extra turns on that, no index can help and the
 * mechanism should not be built. That check comes before the code.
 */
export const floodedSymbol = {
  id: 'flooded-symbol',
  family: 'locate',
  adversarial: false,
  tracks: ['cold', 'warm'],
  prompt:
    'The function `compute_settlement_fee` has a bug: it rounds the amount BEFORE applying the ' +
    'rate, which loses precision. Fix its DEFINITION so the rate is applied first and the result ' +
    'is rounded afterwards. Do not change any of its call sites.',
  setup(dir) {
    for (let i = 0; i < MODULE_COUNT; i++) {
      const name = `mod_${String(i).padStart(3, '0')}`;
      const lines = [`"""Module ${name}."""`, ''];

      if (i === 47) {
        lines.push(
          'def compute_settlement_fee(amount, rate):',
          '    """Fee for a settlement, in whole cents."""',
          '    return round(amount) * rate',
          ''
        );
      } else if (i % 2 === 0) {
        // FORTY CALL SITES. Each mentions the symbol by name, so a grep for it
        // returns forty-one hits of which exactly one is the definition.
        lines.push(
          `from pkg.mod_047 import compute_settlement_fee`,
          '',
          `def ${name}_settle(amount, rate):`,
          '    return compute_settlement_fee(amount, rate)',
          ''
        );
      } else {
        lines.push(`def ${name}_load(raw):`, '    return raw.splitlines()', '');
      }
      write(dir, `pkg/${name}.py`, lines.join('\n'));
    }
    write(dir, 'README.md', '# ledger service\n');
  },
  checks: [
    {
      name: 'the definition is fixed',
      weight: 3,
      run: (dir) => /return\s+round\s*\(\s*amount\s*\*\s*rate\s*\)/.test(read(dir, 'pkg/mod_047.py')),
    },
    {
      name: 'the broken expression is gone',
      weight: 2,
      run: (dir) => !/round\s*\(\s*amount\s*\)\s*\*\s*rate/.test(read(dir, 'pkg/mod_047.py')),
    },
    {
      // The instruction was explicit, and rewriting call sites is the obvious
      // wrong turn when a grep returns forty of them.
      name: 'call sites left alone',
      weight: 2,
      run: (dir) => {
        for (const i of [0, 12, 46, 48, 78]) {
          const name = `mod_${String(i).padStart(3, '0')}`;
          const src = read(dir, `pkg/${name}.py`);
          if (i % 2 === 0 && !/return compute_settlement_fee\(amount, rate\)/.test(src)) return false;
        }
        return true;
      },
    },
  ],
};

/**
 * THE TASK THAT CATCHES TERSENESS BUYING COST WITH COMPLETENESS.
 *
 * Every other task here has a CODE deliverable, so its verifier checks files.
 * The output-discipline block changes PROSE, which those tasks barely produce
 * -- meaning the most likely way it could do harm was invisible to the whole
 * battery. This closes that.
 *
 * The deliverable is an explanation, and the rubric is four concrete facts that
 * an explanation of this bug must contain. That makes the incentive exactly
 * right: an answer carrying all four facts in one terse sentence scores 1.000
 * and costs less than a rambling one, so brevity is rewarded -- while brevity
 * achieved by DROPPING a fact scores 0.4 and the ledger charges full price for
 * it. Cost per unit delivered then moves in the correct direction on its own,
 * with no separate quality metric to argue about.
 *
 * It is also the most sensitive test bed available for the block, because here
 * the deliverable IS output tokens rather than a file edit.
 */
export const explainFailure = {
  id: 'explain-failure',
  family: 'explain',
  adversarial: false,
  tracks: ['cold', 'warm'],
  prompt:
    'Do not change any code. Write to ANSWER.md a short explanation of why the test in ' +
    'tests/test_pipeline.py fails: name the function at fault, the file it lives in, the exact ' +
    'call that is wrong, and what the observable wrong behaviour is.',
  setup(dir) {
    debugPipeline.setup(dir);
  },
  checks: [
    {
      name: 'names the faulty function',
      weight: 2,
      run: (dir) => /\bnormalise\b/.test(read(dir, 'ANSWER.md')),
    },
    {
      // The heart of the explanation: not merely "it is wrong" but WHICH call.
      name: 'identifies lstrip as the wrong call',
      weight: 3,
      run: (dir) => /\blstrip\b/.test(read(dir, 'ANSWER.md')),
    },
    {
      name: 'states the observable behaviour',
      weight: 3,
      run: (dir) => {
        const src = read(dir, 'ANSWER.md').toLowerCase();
        // Trailing whitespace surviving, however it is phrased.
        return /trailing|right|end of|both sides/.test(src) && /whitespace|space/.test(src);
      },
    },
    {
      name: 'gives the file path',
      weight: 1,
      run: (dir) => /pipeline\/clean\.py/.test(read(dir, 'ANSWER.md')),
    },
    {
      // Guards the other direction: the task says explain, not fix. An arm that
      // edits the code has done different work and must not be scored as if it
      // answered the question.
      name: 'left the code alone',
      weight: 1,
      run: (dir) => /\.lstrip\(\)/.test(read(dir, 'pipeline/clean.py')),
    },
  ],
};

export const GOLDEN = {
  'debug-pipeline-py': (dir) =>
    write(dir, 'pipeline/clean.py', read(dir, 'pipeline/clean.py').replace('.lstrip()', '.strip()')),

  'single-shot-extract': (dir) => write(dir, 'ANSWER.txt', '4500\n'),

  'pure-generation': (dir) =>
    write(dir, 'util/backoff.py', [
      'MAX_DELAY_MS = 30000',
      '',
      'def delays(attempts, base_ms):',
      '    out = []',
      '    delay = base_ms',
      '    for _ in range(attempts):',
      '        out.append(min(delay, MAX_DELAY_MS))',
      '        delay *= 2',
      '    return out',
      '',
    ].join('\n')),

  'repeat-comprehension': (dir) =>
    write(dir, 'SYMBOLS.txt', 'parse_line pipeline/parse.py:1\nnormalise pipeline/clean.py:1\n'),

  // Terse and complete: all four facts, no padding. This is the answer the
  // rules file should produce, and it must score 1.000.
  'explain-failure': (dir) =>
    write(
      dir,
      'ANSWER.md',
      'normalise in pipeline/clean.py calls .lstrip(), which strips only the left side, ' +
        'so trailing whitespace survives and the value is "b  " instead of "b".\n'
    ),

  'flooded-symbol': (dir) =>
    write(
      dir,
      'pkg/mod_047.py',
      read(dir, 'pkg/mod_047.py').replace('return round(amount) * rate', 'return round(amount * rate)')
    ),

  'needle-in-repo': (dir) =>
    write(
      dir,
      'pkg/mod_047.py',
      read(dir, 'pkg/mod_047.py').replace('return round(amount) * rate', 'return round(amount * rate)')
    ),
};

export const TASKS = [
  explainFailure,
  floodedSymbol,
  debugPipeline,
  singleShotExtract,
  pureGeneration,
  repeatComprehension,
  needleInRepo,
];

/** The declared adversarial subset, which the report renders first. */
export const ADVERSARIAL = TASKS.filter((t) => t.adversarial);

/** Tasks eligible for a track. Warm sequences run in the order given here. */
export const forTrack = (track) => TASKS.filter((t) => t.tracks.includes(track));
