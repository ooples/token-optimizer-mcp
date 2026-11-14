/**
 * The agent ledger and the subagent cache-TTL setting it decides (#567).
 *
 * The rule under test: write `subagentPromptCacheTtl: "1h"` only when this
 * machine's own agents show 1h is cheaper, never over a value the user (or the
 * environment) set, never on a file that does not parse, exactly once, and undo
 * only what was written.
 */

import { describe, expect, test } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  agentRow,
  applySubagentTtl,
  describeSubagentTtl,
  readLedger,
  recordAgent,
  ttlDecision,
  ttlOwner,
  ttlRecordPath,
  undoSubagentTtl,
} from '../../src/hooks-core/agent-ledger.mjs';
import { tallyTranscript } from '../../src/hooks-core/subagents.mjs';

const repo = join(fileURLToPath(import.meta.url), '..', '..', '..');

/** A transcript of `turns` requests `gapSeconds` apart, written at the 5m tier. */
function transcript({ turns = 10, gapSeconds = 600, prompt = 40_000 } = {}) {
  const start = Date.parse('2026-11-12T00:00:00Z');
  const lines = [];
  let prev = 0;
  for (let i = 0; i < turns; i++) {
    const cached = prompt + i * 1_000;
    const expired = i === 0 || gapSeconds > 300;
    const write = expired ? cached : cached - prev;
    lines.push(
      JSON.stringify({
        type: 'assistant',
        timestamp: new Date(start + i * gapSeconds * 1000).toISOString(),
        message: {
          id: `m${i}`,
          usage: {
            input_tokens: 3,
            cache_creation_input_tokens: write,
            cache_read_input_tokens: expired ? 0 : prev,
            cache_creation: { ephemeral_5m_input_tokens: write, ephemeral_1h_input_tokens: 0 },
            output_tokens: 40,
          },
        },
      })
    );
    prev = cached;
  }
  return lines.join('\n');
}

const slowRow = () => agentRow(tallyTranscript(transcript({ gapSeconds: 600 })), { now: Date.now() });
const fastRow = () => agentRow(tallyTranscript(transcript({ gapSeconds: 30 })), { now: Date.now() });

function sandbox(settings) {
  const dir = mkdtempSync(join(tmpdir(), 'agent-ledger-'));
  const env = { TOKEN_OPTIMIZER_HOME: join(dir, 'home') };
  const settingsPath = join(dir, 'settings.json');
  if (settings !== undefined) writeFileSync(settingsPath, typeof settings === 'string' ? settings : JSON.stringify(settings));
  return { dir, env, settingsPath };
}

const read = (path) => JSON.parse(readFileSync(path, 'utf8'));

describe('ttlDecision', () => {
  test('recommends 1h when slow agents dominate', () => {
    const d = ttlDecision([slowRow(), slowRow(), slowRow()]);
    expect(d.recommend).toBe('1h');
    expect(d.share).toBeGreaterThan(0.3);
  });

  test('withholds when agents never wait long enough for 1h to pay', () => {
    expect(ttlDecision([fastRow(), fastRow(), fastRow()]).recommend).toBeNull();
  });

  test('one odd agent cannot flip the setting', () => {
    expect(ttlDecision([slowRow()]).recommend).toBeNull();
  });

  test('rows already written at 1h are not evidence about 5m', () => {
    const rows = [slowRow(), slowRow(), slowRow()].map((r) => ({ ...r, write1h: r.write5m, write5m: 0 }));
    expect(ttlDecision(rows).agents).toBe(0);
  });
});

describe('the ledger', () => {
  test('rows round-trip, malformed lines are skipped, old rows age out', () => {
    const { env } = sandbox();
    recordAgent(slowRow(), env);
    recordAgent({ ...slowRow(), at: Date.now() - 40 * 24 * 3600 * 1000 }, env);
    const path = join(env.TOKEN_OPTIMIZER_HOME, 'agents.jsonl');
    writeFileSync(path, `${readFileSync(path, 'utf8')}not json\n`);
    expect(readLedger(env)).toHaveLength(1);
  });
});

describe('applySubagentTtl', () => {
  const evidence = () => [slowRow(), slowRow(), slowRow()];

  test('writes 1h with a byte-exact backup and keeps every other setting', () => {
    const original = '{\n  "model": "opus",\n  "env": { "X": "1" }\n}';
    const { env, settingsPath } = sandbox(original);
    const result = applySubagentTtl(settingsPath, { env, rows: evidence() });
    expect(result.written).toBe(true);
    expect(read(settingsPath)).toEqual({ model: 'opus', env: { X: '1' }, subagentPromptCacheTtl: '1h' });
    expect(readFileSync(result.backup, 'utf8')).toBe(original);
    expect(read(ttlRecordPath(env)).evidence.agents).toBe(3);
  });

  test('creates the settings file when there is none', () => {
    const { env, settingsPath } = sandbox();
    expect(applySubagentTtl(settingsPath, { env, rows: evidence() }).written).toBe(true);
    expect(read(settingsPath)).toEqual({ subagentPromptCacheTtl: '1h' });
  });

  test('never over a value the user set, including 5m', () => {
    const { env, settingsPath } = sandbox({ subagentPromptCacheTtl: '5m' });
    expect(applySubagentTtl(settingsPath, { env, rows: evidence() }).written).toBe(false);
    expect(read(settingsPath).subagentPromptCacheTtl).toBe('5m');
  });

  test('never when the environment variable decides', () => {
    const { env, settingsPath } = sandbox({});
    const withVar = { ...env, CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL: '5m' };
    expect(applySubagentTtl(settingsPath, { env: withVar, rows: evidence() }).reason).toBe('already set in environment');
    expect(ttlOwner({}, withVar)).toBe('environment');
  });

  test('never on a file it cannot parse', () => {
    const { env, settingsPath } = sandbox('{ "model": "opus", // comment\n}');
    expect(applySubagentTtl(settingsPath, { env, rows: evidence() }).written).toBe(false);
    expect(readFileSync(settingsPath, 'utf8')).toContain('// comment');
  });

  test('not without evidence, and not when opted out', () => {
    const { env, settingsPath } = sandbox({});
    expect(applySubagentTtl(settingsPath, { env, rows: [fastRow(), fastRow(), fastRow()] }).written).toBe(false);
    const off = { ...env, TOKEN_OPTIMIZER_SUBAGENT_CACHE_TTL: 'off' };
    expect(applySubagentTtl(settingsPath, { env: off, rows: evidence() }).written).toBe(false);
    expect(read(settingsPath)).toEqual({});
  });

  test('written once: a key the user removed by hand is not written back', () => {
    const { env, settingsPath } = sandbox({});
    applySubagentTtl(settingsPath, { env, rows: evidence() });
    writeFileSync(settingsPath, '{}');
    expect(applySubagentTtl(settingsPath, { env, rows: evidence() }).written).toBe(false);
    expect(read(settingsPath)).toEqual({});
  });
});

describe('undoSubagentTtl', () => {
  const evidence = () => [slowRow(), slowRow(), slowRow()];

  test('removes what was written, and it is not written again', () => {
    const { env, settingsPath } = sandbox({ model: 'opus' });
    applySubagentTtl(settingsPath, { env, rows: evidence() });
    expect(undoSubagentTtl({ env }).undone).toBe(true);
    expect(read(settingsPath)).toEqual({ model: 'opus' });
    expect(applySubagentTtl(settingsPath, { env, rows: evidence() }).written).toBe(false);
  });

  test('leaves a value the user has changed since', () => {
    const { env, settingsPath } = sandbox({});
    applySubagentTtl(settingsPath, { env, rows: evidence() });
    writeFileSync(settingsPath, JSON.stringify({ subagentPromptCacheTtl: '5m' }));
    expect(undoSubagentTtl({ env }).undone).toBe(false);
    expect(read(settingsPath).subagentPromptCacheTtl).toBe('5m');
  });

  test('nothing to undo when nothing was written', () => {
    const { env } = sandbox({});
    expect(undoSubagentTtl({ env }).undone).toBe(false);
  });
});

describe('the SubagentStop hook, end to end', () => {
  function runHook(payload, env) {
    return spawnSync(process.execPath, [join(repo, 'src', 'plugin', 'hooks', 'subagent-stop.mjs')], {
      input: JSON.stringify(payload),
      encoding: 'utf8',
      env: { ...process.env, ...env, TOKEN_OPTIMIZER_MODE: '' },
      timeout: 30_000,
    });
  }

  function session(dir, agents) {
    const sessionPath = join(dir, 'sess.jsonl');
    writeFileSync(sessionPath, '{}\n');
    const sub = join(dir, 'sess', 'subagents');
    mkdirSync(sub, { recursive: true });
    agents.forEach((text, i) => writeFileSync(join(sub, `agent-a${i}.jsonl`), text));
    return sessionPath;
  }

  test('records each finished agent, prints nothing, and sets 1h on the third slow agent', () => {
    const { dir, env, settingsPath } = sandbox({ model: 'opus' });
    const hookEnv = { ...env, TOKEN_OPTIMIZER_SETTINGS: settingsPath, TOKEN_OPTIMIZER_STATE_DIR: join(dir, 'state') };
    const sessionPath = session(dir, [transcript(), transcript(), transcript()]);
    for (let i = 0; i < 3; i++) {
      // agent_transcript_path is sometimes empty: the hook finds the file by id.
      const run = runHook(
        { hook_event_name: 'SubagentStop', session_id: 's1', transcript_path: sessionPath, agent_id: `a${i}`, agent_transcript_path: '' },
        hookEnv
      );
      expect(run.status).toBe(0);
      expect(run.stdout).toBe('');
      expect(read(settingsPath).subagentPromptCacheTtl).toBe(i < 2 ? undefined : '1h');
    }
    expect(readLedger(env).map((r) => r.agentId)).toEqual(['a0', 'a1', 'a2']);
  });

  test('a garbage payload exits 0 and writes nothing', () => {
    const { dir, env, settingsPath } = sandbox({});
    const run = spawnSync(process.execPath, [join(repo, 'src', 'plugin', 'hooks', 'subagent-stop.mjs')], {
      input: 'not json',
      encoding: 'utf8',
      env: { ...process.env, ...env, TOKEN_OPTIMIZER_SETTINGS: settingsPath, TOKEN_OPTIMIZER_STATE_DIR: join(dir, 'state') },
    });
    expect(run.status).toBe(0);
    expect(run.stdout).toBe('');
    expect(existsSync(join(env.TOKEN_OPTIMIZER_HOME, 'agents.jsonl'))).toBe(false);
  });
});

describe('describeSubagentTtl (doctor)', () => {
  const evidence = () => [slowRow(), slowRow(), slowRow()];

  test('names who owns the value and how to take ours back', () => {
    const { env, settingsPath } = sandbox({});
    expect(describeSubagentTtl(settingsPath, env)).toMatch(/5-minute default; token-optimizer sets 1h once/);
    expect(describeSubagentTtl(settingsPath, { ...env, TOKEN_OPTIMIZER_SUBAGENT_CACHE_TTL: 'off' })).toMatch(/=off keeps it/);
    applySubagentTtl(settingsPath, { env, rows: evidence() });
    const ours = describeSubagentTtl(settingsPath, env);
    expect(ours).toMatch(/^subagent cache TTL 1h, written by token-optimizer on \d{4}-\d\d-\d\d/);
    expect(ours).toContain('token-optimizer-uninstall --apply');
    writeFileSync(settingsPath, JSON.stringify({ subagentPromptCacheTtl: '5m' }));
    expect(describeSubagentTtl(settingsPath, env)).toMatch(/TTL 5m, set in .*\(yours/);
    writeFileSync(settingsPath, '{}');
    expect(describeSubagentTtl(settingsPath, env)).toMatch(/removed since, so it is never written again/);
    expect(describeSubagentTtl(settingsPath, { ...env, CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL: '1h' })).toMatch(
      /TTL 1h, set by CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL/
    );
  });

  test('an undone write reads as the default', () => {
    const { env, settingsPath } = sandbox({});
    applySubagentTtl(settingsPath, { env, rows: evidence() });
    expect(undoSubagentTtl({ env }).undone).toBe(true);
    expect(describeSubagentTtl(settingsPath, env)).toMatch(/5-minute default; token-optimizer wrote 1h once/);
  });
});
