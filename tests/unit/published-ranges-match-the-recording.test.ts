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
 */

import { readFileSync } from 'fs';
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
}

interface Recording {
  encoding: string;
  recorded: string;
  claims: Record<string, Claim>;
}

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

describe('every published reduction range is the recorded one', () => {
  it('has a recording to check against', () => {
    expect(recorded.length).toBeGreaterThan(0);
    expect(recording.encoding).toBe('cl100k_base');
  });

  it('covers every tool the bench recorded', () => {
    const uncovered = recorded
      .map(([tool]) => tool)
      .filter((tool) => !(tool in DESCRIBED));
    expect(uncovered).toEqual([]);
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

      expect(description).toContain('Measured token reduction vs reading the file');
      expect(description).toContain(`${claim.first.text} first read`);
      expect(description).toContain(`${claim.repeated.text} repeated`);
      // The fixture count is what tells a reader how much the range rests on.
      const fixtures =
        claim.fixtures === 1 ? '1 fixture' : `${claim.fixtures} fixtures`;
      expect(description).toContain(`(bench/tools, ${fixtures})`);
    });
  }
});
