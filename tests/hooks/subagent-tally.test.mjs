/**
 * Subagent accounting: what each agent cost, and how much was fixed context.
 *
 * Shapes are taken from real Claude Code subagent transcripts (2026-10-20): an
 * `api-request-blob` entry carries the first request's text blocks, assistant
 * entries carry `message.usage`, a message streamed as several entries repeats
 * the same usage, and `agent-*.meta.json` names the agent.
 */

import { describe, expect, test } from '@jest/globals';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  cacheTtlFinding,
  expiryRewrites,
  fixedContextFinding,
  renderTally,
  replayTtl,
  subagentTally,
  subagentTranscripts,
  tallyTranscript,
} from '../../src/hooks-core/subagents.mjs';

const usage = (read, write, out) => ({
  input_tokens: 2,
  cache_creation_input_tokens: write,
  cache_read_input_tokens: read,
  output_tokens: out,
});

/** An agent whose first turn carries `base` tokens and which runs `turns` turns. */
function agentLines({ base = 56_000, turns = 5, toolChars = 4_000 } = {}) {
  const lines = [
    { type: 'user', message: { role: 'user', content: 'task' } },
    {
      type: 'api-request-blob',
      message: {
        content: [
          { type: 'text', text: `<system-reminder>Contents of C:/u/.claude/memory/MEMORY.md\n${'m'.repeat(18_000)}` },
          { type: 'text', text: `The following tools just became available ${'t'.repeat(47_000)}` },
          { type: 'text', text: 'short' },
        ],
      },
    },
  ];
  for (let i = 0; i < turns; i++) {
    const msg = { id: `msg_${i}`, usage: i === 0 ? usage(24_000, base - 24_002, 10) : usage(base + i * 100, 300, 20) };
    // Streamed as two entries with the same id: counted once.
    lines.push({ type: 'assistant', message: { ...msg, content: [{ type: 'thinking' }] } });
    lines.push({ type: 'assistant', message: { ...msg, content: [{ type: 'tool_use' }] } });
    lines.push({ type: 'user', message: { content: [{ type: 'tool_result', content: 'x'.repeat(toolChars) }] } });
  }
  return lines.map((l) => JSON.stringify(l)).join('\n');
}

function session({ agents = 3 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'tally-'));
  const transcript = join(dir, 'sess.jsonl');
  writeFileSync(transcript, '{}\n');
  const sub = join(dir, 'sess', 'subagents', 'workflows', 'wf_1');
  mkdirSync(sub, { recursive: true });
  for (let i = 0; i < agents; i++) {
    writeFileSync(join(sub, `agent-a${i}.jsonl`), agentLines({ turns: 3 + i }));
    writeFileSync(join(sub, `agent-a${i}.meta.json`), JSON.stringify({ description: `worker-${i}`, model: 'opus' }));
  }
  return transcript;
}

describe('tallyTranscript', () => {
  test('counts each assistant message once, however many entries stream it', () => {
    const t = tallyTranscript(agentLines({ turns: 4 }));
    expect(t.turns).toBe(4);
    expect(t.output).toBe(10 + 3 * 20);
  });

  test('the first turn is the base context', () => {
    expect(tallyTranscript(agentLines({ base: 56_000 })).baseContext).toBe(56_000);
  });

  test('tool output is measured, and is small beside the baseline', () => {
    const t = tallyTranscript(agentLines({ turns: 5, toolChars: 4_000 }));
    expect(t.toolOutput).toBeGreaterThan(4_000);
    expect(t.toolOutput).toBeLessThan(t.cacheRead / 10);
  });

  test('the fixed blocks are named and sized, largest first; short blocks are not listed', () => {
    const { fixedBlocks } = tallyTranscript(agentLines());
    expect(fixedBlocks.map((b) => b.label)).toEqual([
      'deferred-tool names and MCP instructions',
      'memory/instructions file MEMORY.md',
    ]);
    expect(fixedBlocks[0].tokens).toBeGreaterThan(fixedBlocks[1].tokens);
  });

  test('garbage lines are skipped, not thrown on', () => {
    expect(tallyTranscript('not json\n{bad\n').turns).toBe(0);
  });
});

describe('subagentTally over a session', () => {
  test('finds nested workflow agents and labels them from their meta', () => {
    const transcript = session({ agents: 3 });
    expect(subagentTranscripts(transcript)).toHaveLength(3);
    const agents = subagentTally(transcript);
    expect(agents.map((a) => a.label).sort()).toEqual(['worker-0', 'worker-1', 'worker-2']);
    // Most expensive first: the agent with the most turns.
    expect(agents[0].label).toBe('worker-2');
  });

  test('a session with no subagents tallies nothing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tally-none-'));
    expect(subagentTally(join(dir, 'x.jsonl'))).toEqual([]);
    expect(subagentTally(null)).toEqual([]);
  });
});

describe('the audit finding', () => {
  test('prices the re-reads of the baseline and says what to remove', () => {
    const agents = subagentTally(session({ agents: 3 }));
    const finding = fixedContextFinding(agents);

    // 3 agents, 3/4/5 turns, 56k base: (2 + 3 + 4) x 56k re-read.
    expect(finding.costPerSession).toBe(9 * 56_000);
    expect(finding.id).toBe('subagent-fixed-context');
    expect(finding.title).toContain('deferred-tool names');
    expect(finding.title).toContain('MEMORY.md');
  });

  test('is withheld when the re-reads are trivial', () => {
    const agents = [{ label: 'a', turns: 1, baseContext: 56_000, cacheRead: 0, cacheWrite: 56_000, input: 2, output: 5, toolOutput: 0, fixedBlocks: [] }];
    expect(fixedContextFinding(agents)).toBeNull();
    expect(fixedContextFinding([])).toBeNull();
  });

  test('the table lists every agent with its turns and base', () => {
    const text = renderTally(subagentTally(session({ agents: 2 })));
    expect(text).toContain('worker-0');
    expect(text).toContain('worker-1');
    expect(text).toContain('56k');
  });
});

/**
 * An agent of `turns` requests on a ~`prompt`-token prefix that grows 1k a turn,
 * `gapSeconds` apart, written at the 5m tier the way Claude Code writes subagents:
 * every gap over five minutes re-writes the whole prefix.
 */
function timedAgent({ turns = 10, gapSeconds = 600, prompt = 40_000 } = {}) {
  const lines = [];
  const start = Date.parse('2026-11-12T00:00:00Z');
  let prevCached = 0;
  for (let i = 0; i < turns; i++) {
    const cached = prompt + i * 1_000;
    const expired = i === 0 || gapSeconds > 300;
    const write = expired ? cached : cached - prevCached;
    const read = expired ? 0 : prevCached;
    lines.push({
      type: 'assistant',
      timestamp: new Date(start + i * gapSeconds * 1000).toISOString(),
      message: {
        id: `m${i}`,
        usage: {
          input_tokens: 3,
          cache_creation_input_tokens: write,
          cache_read_input_tokens: read,
          cache_creation: { ephemeral_5m_input_tokens: write, ephemeral_1h_input_tokens: 0 },
          output_tokens: 50,
        },
      },
    });
    prevCached = cached;
  }
  return tallyTranscript(lines.map((l) => JSON.stringify(l)).join('\n'));
}

describe('cache TTL tiers', () => {
  test('writes are split by tier, and a record with no split counts as 5m', () => {
    const t = timedAgent({ turns: 3 });
    expect(t.write5m).toBe(t.cacheWrite);
    expect(t.write1h).toBe(0);
    expect(tallyTranscript(agentLines({ turns: 2 })).write5m).toBeGreaterThan(0);
  });

  test('expiry after a long gap is counted, and a short gap is not', () => {
    const slow = timedAgent({ turns: 5, gapSeconds: 600 });
    expect(expiryRewrites(slow.requests, '5m').count).toBe(4);
    expect(expiryRewrites(slow.requests, '1h').count).toBe(0);
    const fast = timedAgent({ turns: 5, gapSeconds: 30 });
    expect(expiryRewrites(fast.requests, '5m').count).toBe(0);
  });

  test('the replay prices a slow agent cheaper at 1h and a fast one cheaper at 5m', () => {
    const slow = timedAgent({ gapSeconds: 600 }).requests;
    expect(replayTtl(slow, '1h')).toBeLessThan(replayTtl(slow, '5m'));
    const fast = timedAgent({ gapSeconds: 30 }).requests;
    expect(replayTtl(fast, '5m')).toBeLessThan(replayTtl(fast, '1h'));
  });

  test('a prefix rewritten within the TTL is a write at both tiers (#568 review)', () => {
    // minute 4 re-wrote the whole prefix though nothing had expired; minute 10 is a real gap
    const requests = [0, 4, 10].map((m) => ({ at: m * 60_000, cached: 100_000, read: 0, input: 0 }));
    expect(replayTtl(requests, '5m')).toBe(375_000);
    expect(replayTtl(requests, '1h')).toBe(410_000);
    // the same requests reading the prefix as expected: the model's prices
    const kept = requests.map((r, i) => ({ ...r, read: i === 1 ? 100_000 : 0 }));
    expect(replayTtl(kept, '5m')).toBe(260_000);
    expect(replayTtl(kept, '1h')).toBe(220_000);
    // a partial change: only the part past the common prefix is written
    const partial = requests.slice(0, 2).map((r, i) => ({ ...r, read: i ? 40_000 : 0 }));
    expect(replayTtl(partial, '5m')).toBe(125_000 + 75_000 + 4_000);
  });

  test('the 5m replay reproduces what the transcript recorded', () => {
    const t = timedAgent({ gapSeconds: 600 });
    const recorded = 1.25 * t.cacheWrite + 0.1 * t.cacheRead + t.input;
    expect(Math.abs(replayTtl(t.requests, '5m') - recorded)).toBeLessThan(2);
  });

  test('recommends 1h for agents that wait on long tool calls', () => {
    const finding = cacheTtlFinding([timedAgent({ gapSeconds: 600 }), timedAgent({ gapSeconds: 900 })]);
    expect(finding.id).toBe('subagent-cache-ttl');
    expect(finding.remedy).toEqual({ setting: 'subagentPromptCacheTtl', value: '1h' });
    expect(finding.title).toContain('expired 18 times');
    expect(finding.savingShare).toBeGreaterThan(0.3);
  });

  test('never recommends 1h when it would cost more', () => {
    expect(cacheTtlFinding([timedAgent({ gapSeconds: 30 })])).toBeNull();
  });

  test('is withheld when the agents already write 1h', () => {
    const a = timedAgent({ gapSeconds: 600 });
    expect(cacheTtlFinding([{ ...a, write1h: a.write5m, write5m: 0 }])).toBeNull();
    expect(cacheTtlFinding([])).toBeNull();
  });
});
