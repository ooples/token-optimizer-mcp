/**
 * A PUBLISHED RANGE HAS TO BE THE RECORDED ONE.
 *
 * Fourteen tool descriptions carry a measured reduction range, and nine of
 * them were stale at once: smart_pretty advertised "94-95%" for an operation
 * that cannot reduce anything, smart_security 74-75% against a recorded 48%,
 * smart_read "5-77% first read" against a recorded -137%. Nothing connected
 * the sentence a caller reads to `bench/tools/results/per-tool-reduction.json`,
 * so a figure stayed published until somebody happened to re-read it.
 *
 * This is that connection. `node bench/tools/reduction.mjs --record` writes the
 * readings down; this asserts that every tool with a recording states exactly
 * that range, and that every recorded tool is covered here at all -- a bench
 * case for a tool missing from the map below fails rather than going unchecked.
 *
 * AND THAT THE RECORDING IS OF THE CASES THAT EXIST NOW. The first version of
 * this file compared descriptions to the recording and nothing else, so growing
 * `CASES` from 28 readings to 36 left all 16 assertions green: eight new fixtures
 * were measuring nothing anybody would read, and six published ranges rested on
 * fewer fixtures than the bench now has. A recording is only evidence for the
 * cases it was taken over, so the per-tool fixture counts are compared with
 * `CASES` directly -- adding or removing a case now fails here until the bench is
 * re-recorded.
 */

import { readFileSync } from 'fs';
import { CASES, ENCODING_NAME } from '../../bench/tools/reduction.mjs';
import { MODEL } from '../../bench/compression/currency.mjs';
import { join } from 'path';
import {
  SMART_COMPLEXITY_TOOL_DEFINITION,
  SMART_EXPORTS_TOOL_DEFINITION,
  SMART_IMPORTS_TOOL_DEFINITION,
  SMART_REFACTOR_TOOL_DEFINITION,
  SMART_SYMBOLS_TOOL_DEFINITION,
  SMART_TYPESCRIPT_TOOL_DEFINITION,
} from '../../src/tools/code-analysis/analysis-tool-definitions.js';
import { SMART_DEPENDENCIES_TOOL_DEFINITION } from '../../src/tools/code-analysis/smart-dependencies.js';
import { SMART_SECURITY_TOOL_DEFINITION } from '../../src/tools/code-analysis/smart-security.js';
import { SMART_CONFIG_READ_TOOL_DEFINITION } from '../../src/tools/configuration/smart-config-read.js';
import { SMART_ENV_TOOL_DEFINITION } from '../../src/tools/configuration/smart-env.js';
import { SMART_PACKAGE_JSON_TOOL_DEFINITION } from '../../src/tools/configuration/smart-package-json.js';
import { SMART_TSCONFIG_TOOL_DEFINITION } from '../../src/tools/configuration/smart-tsconfig.js';
import { SMART_READ_TOOL_DEFINITION } from '../../src/tools/file-operations/smart-read.js';
import { SMART_PRETTY_TOOL_DEFINITION } from '../../src/tools/output-formatting/smart-pretty.js';

interface Claim {
  first: { lo: number; hi: number; text: string } | null;
  repeated: { lo: number; hi: number; text: string } | null;
  fixtures: number;
  samples: number;
}

interface Recording {
  encoding: string;
  recorded: string;
  stability: { passes: number; maxTokenSpread: number; drifting: unknown[] };
  claims: Record<string, Claim>;
}

/**
 * The fewest independent sweeps a published figure may rest on.
 *
 * Matches RECORD_PASSES in the bench. Three readings of identical inputs used to
 * disagree on 7 of 36 cases, and one disagreement had already moved a published
 * bracket from -31% to -30%, because the measured payloads carried wall-clock
 * fields. Those are gone and the readings are byte-identical now, which is what
 * makes the agreement check below a trip-wire rather than a tolerance: it is
 * expected never to fire, and a recording that cannot satisfy it is not evidence
 * for anything.
 */
const MIN_PASSES = 3;

const RECORD = join('bench', 'tools', 'results', 'per-tool-reduction.json');

/**
 * The served description for every tool the bench has a case for. Keyed by the
 * tool name the bench records, so a recording for a tool absent from here is a
 * failure and not a silent gap.
 */
const DESCRIBED: Record<string, { description: string }> = {
  smart_complexity: SMART_COMPLEXITY_TOOL_DEFINITION,
  smart_exports: SMART_EXPORTS_TOOL_DEFINITION,
  smart_imports: SMART_IMPORTS_TOOL_DEFINITION,
  smart_refactor: SMART_REFACTOR_TOOL_DEFINITION,
  smart_symbols: SMART_SYMBOLS_TOOL_DEFINITION,
  smart_typescript: SMART_TYPESCRIPT_TOOL_DEFINITION,
  smart_dependencies: SMART_DEPENDENCIES_TOOL_DEFINITION,
  smart_security: SMART_SECURITY_TOOL_DEFINITION,
  smart_config_read: SMART_CONFIG_READ_TOOL_DEFINITION,
  smart_env: SMART_ENV_TOOL_DEFINITION,
  smart_package_json: SMART_PACKAGE_JSON_TOOL_DEFINITION,
  smart_tsconfig: SMART_TSCONFIG_TOOL_DEFINITION,
  smart_read: SMART_READ_TOOL_DEFINITION,
  smart_pretty: SMART_PRETTY_TOOL_DEFINITION,
};

const recording = JSON.parse(readFileSync(RECORD, 'utf-8')) as Recording;
const recorded = Object.entries(recording.claims);

/** How many bench cases each tool has right now, which is what a recording owes. */
const casesPerTool = new Map<string, number>();
for (const { tool } of CASES as readonly { tool: string }[])
  casesPerTool.set(tool, (casesPerTool.get(tool) ?? 0) + 1);

describe('every published reduction range is the recorded one', () => {
  it('has a recording to check against', () => {
    expect(recorded.length).toBeGreaterThan(0);
    // THE CURRENCY THE CLAIM IS MADE IN, WHICH IS NOT OURS TO CHOOSE. Every
    // figure here was counted with tiktoken `cl100k_base` -- OpenAI's
    // tokenizer -- while the claim it supports is about what a Claude
    // subscription spends. The authority for that is Anthropic's own
    // `count_tokens`, which is what `bench/compression/currency.mjs` serves
    // from a recorded fixture so CI stays offline. The two encodings do not
    // differ by a constant: they split code and punctuation differently, so a
    // ratio taken under one is not preserved under the other, and a recording
    // left on the old scale is not comparable with the compression bench.
    expect(recording.encoding).toBe(`anthropic:${MODEL}`);
    // And the recording was written by the same counter this file imports, so
    // a currency change cannot land in one of the two places only.
    expect(recording.encoding).toBe(ENCODING_NAME);
  });

  it('rests on readings that reproduced', () => {
    expect(recording.stability.passes).toBeGreaterThanOrEqual(MIN_PASSES);
    // Zero, not 'small'. The quantity is deterministic, so any spread at all is
    // a field that varies between identical calls -- the defect, not its size.
    expect(recording.stability.maxTokenSpread).toBe(0);
    expect(recording.stability.drifting).toEqual([]);
    const thin = recorded
      .filter(([, claim]) => (claim.samples ?? 0) < MIN_PASSES)
      .map(([tool]) => tool);
    expect(thin).toEqual([]);
  });

  it('covers every tool the bench recorded', () => {
    const uncovered = recorded
      .map(([tool]) => tool)
      .filter((tool) => !(tool in DESCRIBED));
    expect(uncovered).toEqual([]);
  });

  it('has a recording for every tool the bench has a case for', () => {
    const unrecorded = [...casesPerTool.keys()].filter(
      (tool) => !(tool in recording.claims)
    );
    expect(unrecorded).toEqual([]);
  });

  it('was recorded over the cases that exist now', () => {
    // Keyed by tool so a failure names which one drifted, not just that one did.
    const recordedCounts = Object.fromEntries(
      recorded.map(([tool, claim]) => [tool, claim.fixtures])
    );
    expect(recordedCounts).toEqual(Object.fromEntries(casesPerTool));
  });

  for (const [tool, claim] of recorded) {
    it(`${tool} states its recorded range`, () => {
      const definition = DESCRIBED[tool];
      if (!definition) {
        throw new Error(
          `${tool} is recorded by the bench but has no description here`
        );
      }
      const { description } = definition;

      if (!claim.first || !claim.repeated) {
        // Every reading refused, so there is no range to publish -- and the
        // description must not carry one it cannot support.
        expect(description).not.toContain('Measured token reduction');
        return;
      }

      expect(description).toContain(
        'Measured token reduction vs reading the file'
      );
      expect(description).toContain(`${claim.first.text} first read`);
      expect(description).toContain(`${claim.repeated.text} repeated`);
      // The fixture count is what tells a reader how much the range rests on.
      const fixtures =
        claim.fixtures === 1 ? '1 fixture' : `${claim.fixtures} fixtures`;
      expect(description).toContain(`(bench/tools, ${fixtures})`);
    });
  }
});

describe('the bench asks every tool in the words it declares', () => {
  /*
   * A RECORDING GOES STALE IN SILENCE WHEN THE QUESTION STOPS PARSING.
   *
   * Every assertion above compares a description to the recording, and the
   * recording to the case list -- all three agreed while smart_typescript had
   * stopped answering. The bench sent it `cwd`, which its schema does not
   * declare; the key was ignored until unknown arguments became a refusal, and
   * then a fresh run printed NO MEASUREMENT for it while the published 85-86%
   * stayed green here, resting on a reading taken before the refusal existed.
   *
   * This is the cheap half of that gap: a key no schema declares is a question
   * the tool was never going to answer, and it is visible without running the
   * harness at all. The expensive half -- re-taking the readings -- is what
   * `node bench/tools/reduction.mjs --record` is for.
   */
  const FIXTURE = join('bench', 'tools', 'fixtures', 'probe.ts');

  const schemaOf = (tool: string): Record<string, unknown> => {
    const definition = DESCRIBED[tool] as
      | { inputSchema?: { properties?: Record<string, unknown> } }
      | undefined;
    return definition?.inputSchema?.properties ?? {};
  };

  for (const testCase of CASES as readonly {
    tool: string;
    fixture: string;
    args: (path: string) => Record<string, unknown>;
  }[]) {
    it(`${testCase.tool} (${testCase.fixture}) is asked only what its schema declares`, () => {
      const declared = schemaOf(testCase.tool);
      // A tool missing from DESCRIBED is already a failure above; here an empty
      // schema would silently excuse every key, so it is named rather than skipped.
      expect(Object.keys(declared).length).toBeGreaterThan(0);
      const undeclared = Object.keys(testCase.args(FIXTURE)).filter(
        (key) => !(key in declared)
      );
      expect(undeclared).toEqual([]);
    });
  }
});
