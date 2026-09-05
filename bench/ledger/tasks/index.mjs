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

/**
 * Builds a large, realistic Python module: `count` functions of ordinary shape,
 * with one of them carrying the planted defect.
 *
 * REAL SIZE IS THE POINT. Every task written before this one produced files of
 * 0.1-0.3 KB, and the optimizer's substitution threshold is ~25 KB -- so
 * outlining, bounding and re-read substitution never fired ONCE in any campaign
 * this harness has run. `assist` measuring identical to control was therefore
 * not a finding about the product; it was a battery in which the product's
 * mechanism could not activate. A 200 KB module is unremarkable in a real
 * repository; the 0.3 KB fixtures were the unrealistic ones.
 */
const bigModule = (count, defectAt) => {
  const out = [
    '"""Order processing helpers. Generated fixture: many small, similar functions."""',
    '',
  ];
  for (let i = 0; i < count; i++) {
    const bug = i === defectAt;
    out.push(
      `def rule_${String(i).padStart(4, '0')}(amount, rate):`,
      `    """Applies pricing rule ${i}.`,
      '',
      '    The rule multiplies the amount by the rate and rounds the result to',
      '    the nearest whole unit, because downstream ledgers store integers',
      '    and a fractional unit would be silently truncated there instead.',
      '    """',
      '    if amount < 0:',
      '        raise ValueError("amount must not be negative")',
      // The defect: rounds before multiplying, so the rate is applied to an
      // already-rounded amount. Same shape as every neighbour.
      bug ? '    return round(amount) * rate' : '    return round(amount * rate)',
      ''
    );
  }
  return out.join('\n');
};

/**
 * REUSE-FRIENDLY: one defect inside a genuinely large file.
 *
 * The first task in this battery where a whole-file read is expensive enough
 * that an outline of it is worth having. Nothing about the work is easier than
 * the small-file version -- the agent must still find the wrong line among
 * hundreds of near-identical ones and fix it.
 */
export const largeFileDefect = {
  id: 'large-file-defect',
  family: 'debug',
  adversarial: false,
  tracks: ['cold', 'warm'],
  prompt:
    'pkg/pricing.py contains one function that rounds before multiplying instead of after, so it ' +
    'returns the wrong price. Find it and fix that one function. Change nothing else.',
  setup(dir) {
    write(dir, 'pkg/pricing.py', bigModule(900, 617));
  },
  checks: [
    {
      name: 'the defect is fixed',
      weight: 3,
      run: (dir) => !/return round\(amount\) \* rate/.test(read(dir, 'pkg/pricing.py')),
    },
    {
      name: 'fixed by correcting it, not by deleting it',
      weight: 3,
      run: (dir) => {
        const src = read(dir, 'pkg/pricing.py');
        return /def rule_0617\(/.test(src) && /return round\(amount \* rate\)/.test(src);
      },
    },
    {
      // The cheapest wrong answer is to rewrite the whole file from a summary,
      // losing the other 899 functions. Charged as a failure.
      name: 'the rest of the module survived',
      weight: 2,
      run: (dir) => {
        const src = read(dir, 'pkg/pricing.py');
        return (src.match(/^def rule_\d{4}\(/gm) || []).length === 900;
      },
    },
  ],
};

/**
 * REUSE-FRIENDLY: a command whose output is far larger than its answer.
 *
 * A test run that prints thousands of passing lines and one failure is the most
 * ordinary thing in a real session, and it is the case a rules file cannot
 * touch: the tokens arrive as tool RESULT, not as anything the model chose to
 * write. Bounding what comes back is the whole mechanism, and until this task
 * existed the battery contained nothing that produced a large tool result.
 */
export const noisyCommand = {
  id: 'noisy-command',
  family: 'debug',
  adversarial: false,
  tracks: ['cold', 'warm'],
  // THE COMMAND IS MANDATED, for two separate reasons. Discretion is variance:
  // the debug task's 1.9x cost spread came from agents choosing how much to
  // look around, so a task that leaves the command open measures exploration
  // style rather than the mechanism. And `-q` would defeat the task's whole
  // purpose -- pytest's quiet mode prints a dot per test and names the failure
  // in a two-line summary, which is a small tool result. `-v` prints a line per
  // test, which is what a developer actually runs when they want to see which
  // test failed, and is the large tool result this task exists to produce.
  prompt:
    'Run `python -m pytest -v tests/` . Exactly one test fails. Write the name of the failing ' +
    'test function, and nothing else, into ANSWER.txt at the repository root.',
  setup(dir) {
    // 600 passing tests and one failure: the output is long, the answer is one
    // line, and finding it does not require the rest.
    for (let f = 0; f < 12; f++) {
      const lines = ['import pytest', ''];
      for (let i = 0; i < 50; i++) {
        const n = f * 50 + i;
        const fails = n === 431;
        lines.push(
          `def test_case_${String(n).padStart(4, '0')}():`,
          `    # Exercises pricing rule ${n} against its recorded expectation.`,
          `    assert ${fails ? '2 + 2 == 5' : '2 + 2 == 4'}`,
          ''
        );
      }
      write(dir, `tests/test_block_${String(f).padStart(2, '0')}.py`, lines.join('\n'));
    }
  },
  checks: [
    { name: 'answer file exists', weight: 1, run: (dir) => existsSync(join(dir, 'ANSWER.txt')) },
    {
      name: 'names the failing test',
      weight: 3,
      run: (dir) => /test_case_0431/.test(read(dir, 'ANSWER.txt')),
    },
    {
      // Naming every test, or pasting the log, is not an answer.
      name: 'answered with the one name, not the whole log',
      weight: 2,
      run: (dir) => {
        const a = read(dir, 'ANSWER.txt');
        return a.trim().length > 0 && (a.match(/test_case_\d{4}/g) || []).length === 1;
      },
    },
    {
      name: 'no test was weakened to make it pass',
      weight: 2,
      run: (dir) => /2 \+ 2 == 5/.test(read(dir, 'tests/test_block_08.py')),
    },
  ],
};

/**
 * ADVERSARIAL: a large file that must genuinely be read in full, with the
 * strategy choice removed.
 *
 * THE COUNTERWEIGHT THIS BATTERY NEEDS, and the second attempt at it. Every
 * function must change, so an outline is useless, a bounded read is missing
 * exactly the information required, and any substitution is paid and then has to
 * be undone. If our arm does not lose here, the task is not doing its job.
 *
 * WHY THE MESSAGE CARRIES THE FUNCTION'S OWN NAME. The previous version asked
 * for one uniform replacement across 120 functions, which left the agent a
 * choice: 120 targeted edits, or a single find/replace, or one whole-file
 * rewrite. Those cost wildly different amounts, and the spread is not noise that
 * more reps can average away -- at n=30 the interval was [0.962, 1.395], about
 * 43% wide, and the task was excluded from every headline as UNRESOLVED. It had
 * the right direction and unusable precision.
 *
 * Requiring `rule_0007: ...` inside rule_0007 makes every replacement distinct,
 * so no single find/replace can do it and the dominant cost -- emitting 120
 * unique strings -- is the same whichever route the agent takes. The strategy
 * choice is gone; the adversarial property is untouched.
 *
 * RENAMED, NOT EDITED IN PLACE. Rows for `whole-file-transform` exist in
 * largecontext.jsonl, postfix*.jsonl and competitors-v1.jsonl. Keeping the id
 * while changing what the task asks would leave one name meaning two different
 * experiments, and the build key does not protect a reader who compares task ids
 * across stores.
 */
export const wholeFileRetitle = {
  id: 'whole-file-retitle',
  family: 'generation',
  adversarial: true,
  tracks: ['cold', 'warm'],
  prompt:
    'Every function in pkg/rules.py raises ValueError("amount must not be negative"). Change each ' +
    'of those messages to "NAME: amount must be zero or greater", where NAME is the name of the ' +
    'function the message is inside -- so rule_0007 raises ValueError("rule_0007: amount must be ' +
    'zero or greater"). Change nothing else.',
  setup(dir) {
    write(dir, 'pkg/rules.py', bigModule(120, -1));
  },
  checks: [
    {
      // THE ONE THAT MAKES THE TASK WHAT IT IS. Counting occurrences would pass
      // a file where every message says the same name, which is precisely the
      // uniform edit this design exists to rule out -- so each message is
      // checked against the function it is actually inside.
      name: 'every message carries its own function name',
      weight: 4,
      run: (dir) => {
        // PER FUNCTION, NOT AGGREGATE COUNTS. Review raised this and the premise
        // deserved testing rather than agreement: the aggregate form here did
        // already reject the specific cheat described, because `matched` only
        // increments when a message equals its ENCLOSING function's name -- a
        // file whose messages all say `rule_0119` scored 0.50, as did one
        // stacking 120 valid messages inside rule_0119.
        //
        // But `matched === 120` is still a count, and a count can be reached by
        // routes a per-function check forbids: duplicates inside one function
        // offsetting a function with none. Requiring each of rule_0000..rule_0119
        // to exist exactly once and carry exactly one matching message removes
        // the whole class instead of the instance, which is worth doing even
        // though the instance was already covered.
        const src = read(dir, 'pkg/rules.py');
        const seen = new Map();
        let current = null;
        for (const line of src.split('\n')) {
          const def = line.match(/^def\s+(rule_\d{4})\s*\(/);
          if (def) {
            current = def[1];
            const entry = seen.get(current) || { defs: 0, msgs: 0 };
            entry.defs += 1;
            seen.set(current, entry);
            continue;
          }
          // Generous about quoting and spacing, strict about the two facts that
          // matter: the function's own name, and the new wording.
          const msg = line.match(/raise\s+ValueError\(\s*['"]([^'"]*)['"]\s*\)/);
          if (msg && current && msg[1] === `${current}: amount must be zero or greater`) {
            const entry = seen.get(current);
            if (entry) entry.msgs += 1;
          }
        }
        if (seen.size !== 120) return false;
        for (let i = 0; i < 120; i += 1) {
          const entry = seen.get(`rule_${String(i).padStart(4, '0')}`);
          if (!entry || entry.defs !== 1 || entry.msgs !== 1) return false;
        }
        return true;
      },
    },
    {
      name: 'none of the old messages remain',
      weight: 2,
      run: (dir) => !/amount must not be negative/.test(read(dir, 'pkg/rules.py')),
    },
    {
      name: 'the functions themselves survived',
      weight: 2,
      run: (dir) => (read(dir, 'pkg/rules.py').match(/^def rule_\d{4}\(/gm) || []).length === 120,
    },
  ],
};

/**
 * ADVERSARIAL: nothing to read, in a repo far too large to read.
 *
 * THE BIAS CONTROL THIS BATTERY WAS MISSING, and it exists because the other
 * adversarial task does not converge. With `whole-file-transform` excluded from
 * the headline, the large-context aggregate carried the harness's own
 * `NO ADVERSARIAL TASKS RESOLVED` warning: every remaining task was one our
 * mechanism is designed to win, which is exactly the shape of a rigged battery.
 *
 * WHY THIS ONE SHOULD CONVERGE WHERE THE OTHER DOES NOT. The transform task
 * leaves the agent a strategy choice -- 120 targeted edits or one rewrite -- and
 * the two cost wildly different amounts, so its interval stays wide however many
 * reps are bought. Here the deliverable is a single small file fixed by the
 * spec, so there is one sensible strategy and the cost is close to the same
 * every run.
 *
 * WHY IT IS ADVERSARIAL RATHER THAN MERELY NEUTRAL. The answer exists nowhere in
 * the tree, so retrieval, outlining and substitution have nothing to offer and
 * only their overhead to charge -- while the tree is large enough (1,200
 * generated functions) that any indexing or seeding we do has real work to get
 * through first. That is the honest question for a large-context product: does
 * it pay for machinery it cannot use? If our arm WINS here, this battery is
 * measuring something other than the mechanism, and the task should be made
 * harder.
 */
export const generationAmidBulk = {
  id: 'generation-amid-bulk',
  family: 'generation',
  adversarial: true,
  tracks: ['cold', 'warm'],
  prompt:
    'Create util/retry_budget.py containing a function `budget(total_ms, attempts)` that returns a ' +
    'list of per-attempt time budgets in milliseconds. The first attempt gets half of total_ms, and ' +
    "each attempt after that gets half of the previous attempt's budget, with a floor of 250 ms. " +
    'Return exactly `attempts` entries. The code already in pkg/ is unrelated to this task and ' +
    'does not need to be read. Do not modify any existing file.',
  setup(dir) {
    write(dir, 'README.md', '# order service\n');
    // Large, and entirely beside the point. The bulk IS the treatment being
    // controlled for: it is what makes indexing and seeding expensive without
    // making them useful.
    //
    // THE PROMPT TELLS THE AGENT NOT TO BOTHER READING IT, AND THAT DOES NOT
    // WEAKEN THE TREATMENT. Our overhead here is paid by the session-start seed,
    // which indexes the tree before the agent has decided anything; what the
    // agent then chooses to explore is not what this task is measuring. Leaving
    // the choice open only added variance: at n=12 the arms measured CV 26.7%
    // (ours-rules) and 34.7% (assist), projecting to a +/-17% interval at n=30 --
    // the band where whole-file-transform sits UNRESOLVED, not the +/-7% where
    // large-file-defect resolves. Removing a discretionary choice the task never
    // intended to measure buys precision without buying a different question.
    write(dir, 'pkg/pricing_bulk.py', bigModule(900, -1));
    write(dir, 'pkg/rules_bulk.py', bigModule(300, -1));
  },
  checks: [
    {
      name: 'file created',
      weight: 1,
      run: (dir) => existsSync(join(dir, 'util/retry_budget.py')),
    },
    {
      name: 'function defined',
      weight: 1,
      run: (dir) =>
        /def\s+budget\s*\(\s*total_ms\s*,\s*attempts\s*\)/.test(read(dir, 'util/retry_budget.py')),
    },
    {
      // STRICT ONLY ABOUT THE TWO FACTS THAT MATTER, generous about spelling --
      // the rule the `pure-generation` verifier had to learn the hard way, where
      // a check that missed `delay *= 2` scored correct code 2 of 4 and dragged
      // the control arm to 25% completion. It halves, and it floors at 250.
      name: 'halves and floors',
      weight: 2,
      run: (dir) => {
        const src = read(dir, 'util/retry_budget.py');
        const floors = /250/.test(src);
        const halves = /(\/\/?=?\s*2|\*\s*0?\.5|>>=?\s*1)/.test(src);
        return floors && halves;
      },
    },
    {
      // The bulk must survive. An agent that "helpfully" rewrites the fixture has
      // not done this task, and without this check that would still score full
      // marks.
      name: 'the irrelevant bulk was left alone',
      weight: 1,
      run: (dir) =>
        (read(dir, 'pkg/pricing_bulk.py').match(/^def rule_\d{4}\(/gm) || []).length === 900,
    },
  ],
};


export const GOLDEN = {
  // Terse, correct, and it leaves the bulk alone -- the answer this task is
  // scored against, which must come out at 1.000.
  'generation-amid-bulk': (dir) =>
    write(dir, 'util/retry_budget.py', [
      'FLOOR_MS = 250',
      '',
      'def budget(total_ms, attempts):',
      '    out = []',
      '    share = total_ms / 2',
      '    for _ in range(attempts):',
      '        out.append(max(FLOOR_MS, share))',
      '        share /= 2',
      '    return out',
      '',
    ].join('\n')),

  'large-file-defect': (dir) =>
    write(
      dir,
      'pkg/pricing.py',
      read(dir, 'pkg/pricing.py').replace('return round(amount) * rate', 'return round(amount * rate)')
    ),

  'noisy-command': (dir) => write(dir, 'ANSWER.txt', 'test_case_0431\n'),

  // Tracks the enclosing function so each message gets ITS OWN name. A single
  // regex cannot express this answer, which is exactly the property the task was
  // redesigned to have -- if the golden solution could be a find/replace, the
  // agent's cheapest route would be one too and the strategy spread would be
  // back.
  'whole-file-retitle': (dir) => {
    let current = null;
    const out = read(dir, 'pkg/rules.py')
      .split('\n')
      .map((line) => {
        const def = line.match(/^def\s+(rule_\d{4})\s*\(/);
        if (def) {
          current = def[1];
          return line;
        }
        if (current && line.includes('amount must not be negative')) {
          return line.replace(
            'amount must not be negative',
            `${current}: amount must be zero or greater`
          );
        }
        return line;
      })
      .join('\n');
    write(dir, 'pkg/rules.py', out);
  },

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
  // The large-context battery. Added because measurement showed 74.7% of spend
  // is on the input side -- cache_read alone is 58.2% -- which no rules file
  // can reach, while every task above produces files of 0.1-0.3 KB and so
  // could never exercise the mechanism that does reach it.
  largeFileDefect,
  noisyCommand,
  // Replaces whole-file-transform, which was adversarial but never converged.
  wholeFileRetitle,
  // The bias control for the large-context set. Added last, after the aggregate
  // was found to rest on three tasks our mechanism is built to win.
  generationAmidBulk,

];

/** The declared adversarial subset, which the report renders first. */
export const ADVERSARIAL = TASKS.filter((t) => t.adversarial);

/** Tasks eligible for a track. Warm sequences run in the order given here. */
export const forTrack = (track) => TASKS.filter((t) => t.tracks.includes(track));
