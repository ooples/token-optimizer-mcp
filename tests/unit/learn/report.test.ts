/**
 * Writing into a file the tool does not own.
 *
 * Two rules decide whether this feature is welcome or deleted. Running it twice must
 * replace its own advice rather than append a second copy, because an instructions
 * file that grows every time a tool runs is one a user removes the tool over. And
 * nothing outside its markers may move: the rest of that file is the user's, and a
 * tool that rewrites a line of it has no way to give it back.
 */
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  BLOCK_END,
  BLOCK_START,
  describeAnalysis,
  renderRecommendations,
  writeRecommendations,
} from '../../../src/learn/report.js';
import {
  Confidence,
  FailureCategory,
  RecommendationTarget,
  type AnalysisResult,
  type Recommendation,
} from '../../../src/learn/models.js';

function rule(patch: Partial<Recommendation> = {}): Recommendation {
  return {
    target: RecommendationTarget.ContextFile,
    heading: 'Commands that keep failing',
    body: '`gh pr` failed 4 times.',
    category: FailureCategory.ExitCode,
    confidence: Confidence.Established,
    occurrences: 4,
    sessions: 3,
    wastedBytes: 2000,
    ...patch,
  };
}

function result(patch: Partial<AnalysisResult> = {}): AnalysisResult {
  return {
    agent: 'claude',
    project: {
      name: 'demo',
      projectPath: 'C:/src/demo',
      dataPath: 'C:/logs',
      sessionCount: 2,
    },
    sessions: 2,
    calls: 400,
    failures: 40,
    uncategorised: 4,
    unattributable: 6,
    recommendations: [rule()],
    unreadable: [],
    ...patch,
  };
}
describe('describeAnalysis', () => {
  it('states the limits of the reading alongside the findings', () => {
    // Both numbers bound how much of the result to believe, so a pass that could
    // attribute a tenth of what it read has to say so rather than look thorough.
    const lines = describeAnalysis(
      result({ unreadable: ['C:/logs/broken.jsonl'] })
    ).join('\n');
    expect(lines).toContain('2 session(s), 400 tool call(s), 40 failed');
    expect(lines).toContain('failure rate 10.0%');
    expect(lines).toContain('4 failure(s) could not be categorised');
    expect(lines).toContain('6 failure(s) ran in a chained command line');
    expect(lines).toContain('UNREADABLE: C:/logs/broken.jsonl');
  });

  it('says plainly when there is nothing to report', () => {
    const lines = describeAnalysis(
      result({ recommendations: [], uncategorised: 0, unattributable: 0 })
    );
    expect(lines.join('\n')).toContain(
      'nothing repeated often enough to be worth a rule'
    );
  });

  it('prints one heading over the findings that share it', () => {
    const lines = describeAnalysis(
      result({
        recommendations: [
          rule({ body: 'first' }),
          rule({ body: 'second' }),
          rule({ heading: 'Paths that are not there', body: 'third' }),
        ],
      })
    );
    expect(
      lines.filter((line) => line.trim() === 'Commands that keep failing')
    ).toHaveLength(1);
    expect(
      lines.filter((line) => line.trim() === 'Paths that are not there')
    ).toHaveLength(1);
  });

  it('marks thin evidence as thin, and one session as one session', () => {
    const [thin] = describeAnalysis(
      result({
        recommendations: [
          rule({ confidence: Confidence.Thin, sessions: 1, occurrences: 3 }),
        ],
      })
    ).slice(-1);
    expect(thin).toContain('(3 times in one session, thin evidence)');
  });
});

describe('writeRecommendations', () => {
  let directory = '';
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'learn-report-'));
  });
  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  const write = (options: { readonly dryRun?: boolean } = {}) =>
    writeRecommendations(directory, 'CLAUDE.md', result(), options);

  it('writes nothing unless it is asked to', async () => {
    const outcome = await write({ dryRun: true });
    expect(outcome.written).toBe(false);
    expect(outcome.content).toContain(BLOCK_START);
    expect(existsSync(join(directory, 'CLAUDE.md'))).toBe(false);
  });

  it('replaces its own block instead of appending a second one', async () => {
    await write();
    const second = await writeRecommendations(
      directory,
      'CLAUDE.md',
      result({ recommendations: [rule({ body: '`gh pr` failed 9 times.' })] })
    );
    expect(second.replaced).toBe(true);
    const text = readFileSync(join(directory, 'CLAUDE.md'), 'utf8');
    expect(text.split(BLOCK_START)).toHaveLength(2);
    expect(text.split(BLOCK_END)).toHaveLength(2);
    expect(text).toContain('failed 9 times');
    expect(text).not.toContain('failed 4 times');
  });

  it('leaves every line the user wrote exactly where it was', async () => {
    const own = [
      '# Project',
      '',
      'Run the tests with `npm test`.',
      '',
      '## Style',
      '',
      '- Tabs.',
      '',
    ].join('\n');
    const path = join(directory, 'CLAUDE.md');
    writeFileSync(path, own, 'utf8');
    await write();
    const after = readFileSync(path, 'utf8');
    expect(after.startsWith(own)).toBe(true);
    await write();
    const again = readFileSync(path, 'utf8');
    expect(again.startsWith(own)).toBe(true);
    expect(again.split(BLOCK_START)).toHaveLength(2);
  });

  it('does not rewrite a file that already says exactly this', async () => {
    await write();
    const second = await write();
    expect(second.unchanged).toBe(true);
    expect(second.written).toBe(false);
  });

  it('leaves no temporary file behind', async () => {
    await write();
    expect(existsSync(join(directory, 'CLAUDE.md.token-optimizer.tmp'))).toBe(
      false
    );
  });

  it('renders the block with a heading and the findings under it', () => {
    const rendered = renderRecommendations(result());
    expect(rendered).toContain('## What past sessions kept getting wrong');
    expect(rendered).toContain('### Commands that keep failing');
    expect(rendered).toContain(
      '- `gh pr` failed 4 times. _(4 times across 3 sessions)_'
    );
  });
});
