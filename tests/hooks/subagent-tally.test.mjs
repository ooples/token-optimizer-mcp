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
  fixedContextFinding,
  renderTally,
  subagentTally,
  subagentTranscripts,
  tallyTranscript,
} from '../../hooks-core/subagents.mjs';

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
