/**
 * The four tools that shipped implemented and unreachable.
 *
 * knowledge_graph, sentiment_analysis, smart_workflow and anomaly_explainer
 * were each ~700-2000 lines of working implementation with a published
 * inputSchema, registered in no profile -- so the CallTool handler refused
 * every one of them by name, and not one had a test. Registering them is only
 * half the fix: a tool nobody has ever called is a tool nobody has ever seen
 * work. These drive each one through its real entry point, the same way the
 * server's dispatch does.
 *
 * smart_workflow gets the most attention here because it needed the most
 * repair: its schema offered eight operations while its class offered no entry
 * point at all, and six of those operations wanted a ParsedWorkflow that no
 * client could have written by hand.
 */
import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { CacheEngine } from '../../src/core/cache-engine.js';
import { TokenCounter } from '../../src/core/token-counter.js';
import { MetricsCollector } from '../../src/core/metrics.js';
import { getSmartWorkflowTool } from '../../src/tools/configuration/smart-workflow.js';
import { getKnowledgeGraphTool } from '../../src/tools/intelligence/knowledge-graph.js';
import { getSentimentAnalysisTool } from '../../src/tools/intelligence/sentiment-analysis.js';
import { runAnomalyExplainer } from '../../src/tools/intelligence/anomaly-explainer.js';
import { validateToolArgs } from '../../src/validation/validator.js';

const WORKFLOW = [
  'name: CI',
  'on:',
  '  push:',
  '    branches: [main]',
  '  workflow_dispatch:',
  'jobs:',
  '  build:',
  '    runs-on: ubuntu-latest',
  '    steps:',
  '      - uses: actions/checkout@v4',
  '      - name: Build',
  '        run: npm run build',
  '  publish:',
  '    runs-on: ubuntu-latest',
  '    needs: build',
  '    steps:',
  '      - name: Publish',
  '        run: npm publish',
  '        env:',
  '          NPM_TOKEN: ${{ secrets.NPM_TOKEN }}',
  '',
].join('\n');

let dir = '';
let cache: CacheEngine;
let tokenCounter: TokenCounter;
let metrics: MetricsCollector;
let workflowPath = '';

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'to-wired-tools-'));
  mkdirSync(join(dir, '.github', 'workflows'), { recursive: true });
  workflowPath = join(dir, '.github', 'workflows', 'ci.yml');
  writeFileSync(workflowPath, WORKFLOW);
  cache = new CacheEngine(join(dir, 'cache'), 10);
  tokenCounter = new TokenCounter();
  metrics = new MetricsCollector();
});

afterAll(() => {
  try {
    cache.close();
  } catch {
    // the temp directory goes either way
  }
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Windows reclaims it later
  }
});

describe('smart_workflow answers every operation it advertises', () => {
  const tool = () => getSmartWorkflowTool(cache, tokenCounter, metrics);

  it('parses the file and reports what it found', async () => {
    const result = await tool().run({
      operation: 'analyze',
      filePath: workflowPath,
    });
    expect(result.operation).toBe('analyze');
    expect(result.analysis?.workflow.name).toBe('CI');
    expect(result.analysis?.workflow.format).toBe('github');
    expect(result.analysis?.workflow.jobs.map((j) => j.id)).toEqual([
      'build',
      'publish',
    ]);
  });

  it('finds the workflow files under a project root', async () => {
    const result = await tool().run({
      operation: 'list-workflows',
      projectRoot: dir,
    });
    expect(result.workflows).toEqual([workflowPath]);
  });

  it('reaches the six graph operations from a path alone', async () => {
    // THE REASON THIS TOOL COULD NOT BE WIRED AS WRITTEN. Its schema said
    // these operations took a `parsedWorkflow` object, which is produced only
    // by an internal parse -- a client had no way to supply one, so six of the
    // eight advertised operations were unusable even in principle.
    const jobs = await tool().run({
      operation: 'get-jobs',
      filePath: workflowPath,
    });
    expect(jobs.jobs?.map((j) => j.id)).toEqual(['build', 'publish']);

    const triggers = await tool().run({
      operation: 'get-triggers',
      filePath: workflowPath,
    });
    expect(triggers.triggers?.map((t) => t.type).sort()).toEqual([
      'push',
      'workflow_dispatch',
    ]);

    const graph = await tool().run({
      operation: 'visualize',
      filePath: workflowPath,
    });
    expect(graph.dependencyGraph?.publish).toEqual(['build']);

    const secrets = await tool().run({
      operation: 'get-secrets',
      filePath: workflowPath,
    });
    expect(secrets.secrets).toEqual(['NPM_TOKEN']);

    const validated = await tool().run({
      operation: 'validate',
      filePath: workflowPath,
    });
    expect(validated.validationErrors).toEqual([]);

    const optimized = await tool().run({
      operation: 'optimize',
      filePath: workflowPath,
    });
    // Neither job caches anything, which is the suggestion this workflow earns.
    expect(optimized.optimizations?.map((o) => o.type)).toContain('caching');
  });

  it('reports a real fault in a broken workflow', async () => {
    // A POSITIVE CONTROL FOR validate. "no errors" on the good file above says
    // nothing unless the validator can produce one at all -- an empty array is
    // also what a validator that never ran would return.
    const broken = join(dir, '.github', 'workflows', 'broken.yml');
    writeFileSync(
      broken,
      ['name: Broken', 'on: push', 'jobs: {}', ''].join('\n')
    );

    const result = await tool().run({
      operation: 'validate',
      filePath: broken,
    });
    expect(result.validationErrors?.length).toBeGreaterThan(0);
  });

  it('accepts a workflow already parsed by an earlier call', async () => {
    const analyzed = await tool().run({
      operation: 'analyze',
      filePath: workflowPath,
    });
    const workflow = analyzed.analysis?.workflow;
    expect(workflow).toBeDefined();
    if (!workflow) return;

    const jobs = await tool().run({
      operation: 'get-jobs',
      parsedWorkflow: workflow,
    });
    expect(jobs.jobs?.map((j) => j.id)).toEqual(['build', 'publish']);
  });

  it('says what is missing instead of returning an empty answer', async () => {
    await expect(tool().run({ operation: 'get-jobs' })).rejects.toThrow(
      /needs a filePath or a parsedWorkflow/
    );
    await expect(tool().run({ operation: 'analyze' })).rejects.toThrow(
      /needs a filePath/
    );
  });
});

describe('knowledge_graph holds a graph across calls', () => {
  it('builds a graph and then queries it by id', async () => {
    const tool = getKnowledgeGraphTool(cache, tokenCounter, metrics);
    const built = await tool.run({
      operation: 'build-graph',
      graphId: 'wired-test',
      entities: [
        { id: 'a', type: 'service', properties: { name: 'api' } },
        { id: 'b', type: 'service', properties: { name: 'worker' } },
        { id: 'c', type: 'store', properties: { name: 'db' } },
      ],
      relations: [
        { from: 'a', to: 'b', type: 'calls' },
        { from: 'b', to: 'c', type: 'writes' },
      ],
    });
    expect(built.success).toBe(true);
    expect(built.data.graph?.nodeCount).toBe(3);
    expect(built.data.graph?.edgeCount).toBe(2);

    const paths = await tool.run({
      operation: 'find-paths',
      graphId: 'wired-test',
      sourceId: 'a',
      targetId: 'c',
    });
    expect(paths.success).toBe(true);
    expect(paths.data.paths?.[0]?.nodes).toEqual(['a', 'b', 'c']);
  });
});

describe('sentiment_analysis separates the two directions', () => {
  it('scores praise above complaint', async () => {
    const tool = getSentimentAnalysisTool(cache, tokenCounter, metrics);
    const good = await tool.run({
      operation: 'analyze-sentiment',
      text: 'This release is excellent, the fix works perfectly and I am happy.',
    });
    const bad = await tool.run({
      operation: 'analyze-sentiment',
      text: 'This release is terrible, the bug is awful and I am frustrated.',
    });

    expect(good.success).toBe(true);
    expect(bad.success).toBe(true);
    const goodScore = good.data.sentiment?.score ?? 0;
    const badScore = bad.data.sentiment?.score ?? 0;
    expect(goodScore).toBeGreaterThan(0);
    expect(badScore).toBeLessThan(0);
    expect(good.data.sentiment?.label).toBe('positive');
    expect(bad.data.sentiment?.label).toBe('negative');
  });
});

describe('anomaly_explainer explains a spike', () => {
  it('returns a summary and a ranked cause', async () => {
    const now = Date.now();
    const result = await runAnomalyExplainer({
      operation: 'explain',
      anomaly: {
        metric: 'p99_latency_ms',
        value: 2400,
        expectedValue: 180,
        deviation: 12.3,
        timestamp: now,
        severity: 'high',
      },
      historicalData: Array.from({ length: 24 }, (_, i) => ({
        timestamp: now - (24 - i) * 3_600_000,
        value: 180 + (i % 5),
      })),
      useCache: false,
    });

    expect(result.success).toBe(true);
    expect(result.data.explanation?.summary.length).toBeGreaterThan(0);
    expect(result.data.explanation?.rootCauses.length).toBeGreaterThan(0);
  });
});

describe('the validation boundary accepts the calls and refuses the rest', () => {
  // validateToolArgs throws "Unknown tool: X. No validation schema
  // available." for a name with no entry in toolSchemaMap, INSIDE a successful
  // JSON-RPC result. A missing schema therefore looks like a healthy call to
  // any harness that only inspects the error field -- which is why each of
  // these four needs its entry checked here and not only in tools/list.
  it.each([
    ['smart_workflow', { operation: 'get-jobs', filePath: 'x.yml' }],
    ['knowledge_graph', { operation: 'build-graph', entities: [] }],
    ['sentiment_analysis', { operation: 'analyze-sentiment', text: 'hi' }],
    ['anomaly_explainer', { operation: 'explain' }],
  ])('accepts a well-formed %s call', (name, args) => {
    expect(() => validateToolArgs(name, args)).not.toThrow();
  });

  it.each([
    'smart_workflow',
    'knowledge_graph',
    'sentiment_analysis',
    'anomaly_explainer',
  ])('refuses an operation %s does not have', (name) => {
    expect(() =>
      validateToolArgs(name, { operation: 'no-such-thing' })
    ).toThrow(/Invalid|invalid/);
  });
});
