/**
 * The SWE-bench A/B harness (bench/swebench): the parts that decide whether a
 * comparison is fair and whether its numbers mean what they say.
 */

import { describe, expect, test } from '@jest/globals';
import {
  ARMS,
  armEnv,
  BENCH_PORTS,
  costUnits,
  isShim,
  mcnemar,
  mcpConnected,
  pairedRatio,
  planId,
  resultEvent,
  runOrder,
  sampleInstances,
  stripTestChanges,
} from '../../bench/swebench/lib.mjs';

const instances = [];
for (const [repo, count] of [['django/django', 40], ['sympy/sympy', 10], ['psf/requests', 3]]) {
  for (let index = 0; index < count; index += 1) instances.push({ instance_id: `${repo.replace('/', '__')}-${index}`, repo });
}

describe('fairness', () => {
  test('a sample is reproducible from its seed and stratified across repositories', () => {
    const a = sampleInstances(instances, { n: 9, seed: 7 });
    const b = sampleInstances([...instances].reverse(), { n: 9, seed: 7 });
    expect(a.map((item) => item.instance_id)).toEqual(b.map((item) => item.instance_id));
    const repos = new Set(a.map((item) => item.repo));
    expect(repos.size).toBe(3);
    expect(a.filter((item) => item.repo === 'django/django').length).toBeLessThanOrEqual(4);
  });

  test('every instance runs in every arm, back to back, and neither arm always goes first', () => {
    const ids = instances.slice(0, 40).map((item) => item.instance_id);
    const order = runOrder(ids, ['control', 'token-optimizer'], { seed: 3 });
    expect(order).toHaveLength(80);
    for (let index = 0; index < order.length; index += 2) expect(order[index].instanceId).toBe(order[index + 1].instanceId);
    const controlFirst = order.filter((item, index) => index % 2 === 0 && item.arm === 'control').length;
    expect(controlFirst).toBeGreaterThan(8);
    expect(controlFirst).toBeLessThan(32);
  });

  test('the arm environment cannot route the control arm through the product', () => {
    const env = armEnv(
      {
        PATH: '/bin',
        ANTHROPIC_API_KEY: 'k',
        ANTHROPIC_BASE_URL: 'http://127.0.0.1:8787',
        TOKEN_OPTIMIZER_HOLDOUT: '0',
        CLAUDE_CODE_SESSION_ID: 'parent',
        CLAUDE_CONFIG_DIR: '/home/u/.claude',
      },
      { arm: 'control', configDir: '/tmp/run/config' }
    );
    expect(env).toEqual({
      PATH: '/bin',
      ANTHROPIC_API_KEY: 'k',
      CLAUDE_CONFIG_DIR: '/tmp/run/config',
      TOKEN_OPTIMIZER_EXPERIMENT_ARM: 'baseline',
      ENABLE_CLAUDEAI_MCP_SERVERS: 'false',
    });
  });

  test("the plugin arm runs its own proxy supervisor, never the machine's installed one", () => {
    const parent = { PATH: '/bin', TOKEN_OPTIMIZER_HOME: '/home/u/.token-optimizer', TOKEN_OPTIMIZER_PROXY_CONTROL_PORT: '16999' };
    const plugin = armEnv(parent, { arm: 'token-optimizer', configDir: '/c', productHome: '/work/home' });
    expect(plugin.TOKEN_OPTIMIZER_HOME).toBe('/work/home');
    expect(plugin.TOKEN_OPTIMIZER_PROXY_CONTROL_PORT).toBe(String(BENCH_PORTS.control));
    expect(plugin.TOKEN_OPTIMIZER_PROXY_ROUTE_BASE).toBe(String(BENCH_PORTS.routeBase));
    // Outside the installed defaults: control 16999, routes 17000-17999.
    expect(BENCH_PORTS.control).not.toBe(16999);
    expect(BENCH_PORTS.routeBase >= 18000 || BENCH_PORTS.routeBase + 1000 <= 17000).toBe(true);
    const control = armEnv(parent, { arm: 'control', configDir: '/c', productHome: '/work/home' });
    expect(control.TOKEN_OPTIMIZER_HOME).toBeUndefined();
    expect(control.TOKEN_OPTIMIZER_PROXY_CONTROL_PORT).toBeUndefined();
  });

  test('every arm passes an experiment arm the MCP server accepts', async () => {
    // The server exits on any other value (src/server/tool-profile.ts); the
    // first pilot lost its plugin arm to exactly that.
    const accepted = ['baseline', 'optimizer', 'retrieval', 'full'];
    for (const arm of Object.keys(ARMS)) {
      expect(accepted).toContain(armEnv({}, { arm, configDir: '/c' }).TOKEN_OPTIMIZER_EXPERIMENT_ARM);
    }
    expect(armEnv({}, { arm: 'token-optimizer', configDir: '/c' }).TOKEN_OPTIMIZER_EXPERIMENT_ARM).toBe('full');
    expect(() => armEnv({}, { arm: 'nope', configDir: '/c' })).toThrow(/unknown arm/);
    const { resolveExperimentArm } = await import('../../dist/server/tool-profile.js');
    for (const arm of Object.keys(ARMS)) {
      expect(() => resolveExperimentArm(armEnv({}, { arm, configDir: '/c' }).TOKEN_OPTIMIZER_EXPERIMENT_ARM)).not.toThrow();
    }
  });

  test('a launcher shim is never taken for the binary under test', () => {
    expect(isShim('C:\\Users\\u\\.token-optimizer\\bin\\claude.cmd')).toBe(true);
    expect(isShim('/usr/local/bin/claude.cmd')).toBe(true);
    expect(isShim('C:\\Users\\u\\.local\\bin\\claude.exe')).toBe(false);
  });

  test('a plan fingerprint changes with anything that changes the measurement', () => {
    const base = { dataset: 'verified', seed: 1, model: 'sonnet', order: [{ instanceId: 'a', arm: 'control', rep: 0 }] };
    expect(planId(base)).toBe(planId({ ...base }));
    expect(planId(base)).not.toBe(planId({ ...base, model: 'opus' }));
  });
});

describe('accounting', () => {
  test('cache-aware units weight reads, writes and output as billed', () => {
    expect(
      costUnits({
        input_tokens: 100,
        cache_read_input_tokens: 1000,
        cache_creation_input_tokens: 300,
        cache_creation: { ephemeral_1h_input_tokens: 100, ephemeral_5m_input_tokens: 200 },
        output_tokens: 10,
      })
    ).toBe(100 + 100 + 250 + 200 + 50);
  });

  test('the last result event is the run’s result, and a torn line is ignored', () => {
    const stream = ['{"type":"system","subtype":"init"}', '{"type":"result","total_cost_usd":1}', '{"type":"result","total_cost_usd":2}', '{"type":"resu'].join('\n');
    expect(resultEvent(stream).total_cost_usd).toBe(2);
    expect(resultEvent('')).toBeNull();
  });

  test('test-file hunks are dropped from the prediction, source hunks are kept', () => {
    const diff = [
      'diff --git a/src/app.py b/src/app.py\n+fix\n',
      'diff --git a/tests/test_app.py b/tests/test_app.py\n+test\n',
      'diff --git a/pkg/conftest.py b/pkg/conftest.py\n+x\n',
      'diff --git a/pkg/thing_test.py b/pkg/thing_test.py\n+x\n',
    ].join('');
    expect(stripTestChanges(diff)).toBe('diff --git a/src/app.py b/src/app.py\n+fix\n');
  });

  test('the MCP connection check reads the debug log', () => {
    expect(mcpConnected('[DEBUG] MCP server "plugin:token-optimizer:token-optimizer": Successfully connected')).toBe(true);
    expect(mcpConnected('[DEBUG] MCP server "plugin:token-optimizer:token-optimizer": Connection failed')).toBe(false);
  });
});

describe('statistics', () => {
  test('the paired ratio is the geometric mean, with an interval that contains it', () => {
    const pairs = [[1, 0.5], [2, 1], [4, 2], [8, 4], [3, 1.5]];
    const result = pairedRatio(pairs, { resamples: 2000 });
    expect(result.ratio).toBeCloseTo(0.5, 10);
    expect(result.low).toBeCloseTo(0.5, 10);
    expect(result.high).toBeCloseTo(0.5, 10);
    const noisy = pairedRatio([[1, 0.4], [1, 0.9], [1, 0.6], [1, 1.1], [1, 0.5]], { resamples: 2000 });
    expect(noisy.low).toBeLessThan(noisy.ratio);
    expect(noisy.high).toBeGreaterThan(noisy.ratio);
  });

  test('McNemar counts only discordant pairs', () => {
    const pairs = [[true, true], [false, false], [true, false], ...Array.from({ length: 9 }, () => [false, true])];
    const result = mcnemar(pairs);
    expect(result).toMatchObject({ onlyControl: 1, onlyTreatment: 9 });
    expect(result.p).toBeCloseTo((2 * (1 + 10)) / 1024, 10);
    expect(mcnemar([[true, true]]).p).toBe(1);
  });
});
