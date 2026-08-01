import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  parseSessionLog,
  resolveSessionLogPath,
} from '../../src/server/session-log-parser.js';

/**
 * The session tools looked for a file nothing writes.
 *
 * `get_session_stats`, `optimize_session` and `analyze_project_tokens` each
 * built `session-log-<id>.jsonl` by hand and reported "JSONL log not found".
 * Nothing in this package has ever written that file: the PowerShell hooks
 * append every tool call to `operations-<id>.csv`
 * (hooks/handlers/token-optimizer-orchestrator.ps1, header
 * `timestamp,toolName,tokens,metadata`).
 *
 * So on the machine this was found on -- five real sessions, 8,044 recorded
 * operations, 2.8 million tokens sitting in that directory -- all three
 * answered "No session files found. Ensure PowerShell hooks are configured."
 * Being told to fix the one thing that was already working is worse than a
 * crash, because it sends you somewhere there is nothing to find.
 *
 * The CSV below is a copy of the real header and row shape, including the BOM
 * PowerShell's `Out-File -Encoding UTF8` writes and the quoted metadata column
 * with commas in it.
 */

let dir: string;

const CSV =
  '\uFEFFtimestamp,toolName,tokens,metadata\n' +
  '2026-07-24 18:01:04,Write,5726,"filePath=C:\\Users\\me\\a.html"\n' +
  '2026-07-24 18:02:11,Read,1200,"filePath=C:\\Users\\me\\b.ts,lines=40"\n' +
  '2026-07-24 18:03:57,mcp__token-optimizer__smart_grep,300,""\n';

const JSONL =
  JSON.stringify({ type: 'session_start', timestamp: '2026-07-24 18:00:00' }) +
  '\n' +
  JSON.stringify({
    type: 'tool_call',
    timestamp: '2026-07-24 18:01:04',
    toolName: 'Write',
    estimatedTokens: 5726,
  }) +
  '\n' +
  JSON.stringify({ type: 'system_reminder', tokens: 900 }) +
  '\n';

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'sesslog-'));
  writeFileSync(join(dir, 'operations-abc123.csv'), CSV);
  writeFileSync(join(dir, 'session-log-def456.jsonl'), JSONL);
});

afterAll(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* */
  }
});

describe('finding a session log', () => {
  it('finds the operations-*.csv the hooks actually write', () => {
    const found = resolveSessionLogPath(dir, 'abc123');
    expect(found).not.toBeNull();
    expect(found).toMatch(/operations-abc123\.csv$/);
  });

  it('still finds a session-log-*.jsonl when one exists', () => {
    expect(resolveSessionLogPath(dir, 'def456')).toMatch(
      /session-log-def456\.jsonl$/
    );
  });

  it('returns null for a session with no log, rather than a path that does not exist', () => {
    // The old code returned a path unconditionally, so every caller needed its
    // own existsSync and every one of them phrased the failure differently.
    expect(resolveSessionLogPath(dir, 'nosuchsession')).toBeNull();
  });
});

describe('reading a CSV session log', () => {
  it('reads every operation', async () => {
    const { operations } = await parseSessionLog(
      join(dir, 'operations-abc123.csv')
    );
    expect(operations).toHaveLength(3);
    expect(operations.map((o) => o.toolName)).toEqual([
      'Write',
      'Read',
      'mcp__token-optimizer__smart_grep',
    ]);
  });

  it('sums the tokens', async () => {
    const { toolTokens } = await parseSessionLog(
      join(dir, 'operations-abc123.csv')
    );
    expect(toolTokens).toBe(5726 + 1200 + 300);
  });

  it('keeps a metadata field that contains commas intact', async () => {
    // Splitting naively on ',' truncates this at "b.ts" and shifts every later
    // column, so the row silently reports the wrong thing rather than failing.
    const { operations } = await parseSessionLog(
      join(dir, 'operations-abc123.csv')
    );
    expect(operations[1].metadata).toBe(
      'filePath=C:\\Users\\me\\b.ts,lines=40'
    );
  });

  it('survives the BOM PowerShell writes', async () => {
    const { operations } = await parseSessionLog(
      join(dir, 'operations-abc123.csv')
    );
    // A surviving BOM would corrupt the first header cell and lose the
    // timestamp column, dropping every row.
    expect(operations[0].timestamp).toBe('2026-07-24 18:01:04');
  });
});

describe('reading a JSONL session log', () => {
  it('still separates tool tokens from system-reminder tokens', async () => {
    const { operations, toolTokens, systemReminderTokens } =
      await parseSessionLog(join(dir, 'session-log-def456.jsonl'));
    expect(operations).toHaveLength(1);
    expect(toolTokens).toBe(5726);
    expect(systemReminderTokens).toBe(900);
  });
});
