/**
 * The defect under test was not a wrong number, it was an absent one: the model
 * came from an env var nothing sets, so every analytics row recorded null and
 * 98.9% of the savings we could prove could not be priced. So these tests are
 * about where an id is allowed to come from.
 *
 * TWO MISTAKES HERE WOULD BE WORSE THAN THE BUG, and both are covered below. A
 * transcript routinely contains the literal text `"model": "..."` inside quoted
 * tool output and pasted config, so an id scraped out of the raw buffer would
 * attribute a saving to a model someone merely MENTIONED. And a session id is
 * concatenated into a path, so one that is not an allowlisted token must never
 * reach the filesystem.
 *
 * No test reads the real home. Both agent homes are redirected to a temp
 * directory, and the session-id variables the host sets for this very process
 * are cleared, so a test that resolved against the real transcript would be
 * reading the developer's own conversation.
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  resolveModel,
  resolveModelUncached,
  resetModelAttributionCache,
  MODEL_SOURCES,
} from '../../../src/server/model-attribution.js';

const TOUCHED = [
  'TOKEN_OPTIMIZER_MODEL',
  'TOKEN_OPTIMIZER_CLAUDE_HOME',
  'TOKEN_OPTIMIZER_CODEX_HOME',
  'TOKEN_OPTIMIZER_SESSION_ID',
  'CLAUDE_CODE_SESSION_ID',
  'CODEX_SESSION_ID',
] as const;

let saved: Record<string, string | undefined> = {};
let home = '';

/** Write a Claude Code transcript for `session` from raw JSONL lines. */
function claudeTranscript(session: string, lines: readonly string[]): void {
  const dir = join(home, '.claude', 'projects', 'C--some-project');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${session}.jsonl`), `${lines.join('\n')}\n`, 'utf8');
}

/** An assistant turn as Claude Code records it. */
function turn(model: string, text = 'some reply'): string {
  return JSON.stringify({ type: 'assistant', message: { model, content: [{ text }] } });
}

/** Write a Codex rollout for `session`, `daysAgo` days back. */
function codexRollout(session: string, lines: readonly string[], daysAgo = 0): void {
  const when = new Date(Date.now() - daysAgo * 86_400_000);
  const pad = (n: number) => String(n).padStart(2, '0');
  const dir = join(
    home,
    '.codex',
    'sessions',
    String(when.getFullYear()),
    pad(when.getMonth() + 1),
    pad(when.getDate())
  );
  mkdirSync(dir, { recursive: true });
  const stamp = `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}T09-00-00`;
  writeFileSync(join(dir, `rollout-${stamp}-${session}.jsonl`), `${lines.join('\n')}\n`, 'utf8');
}

beforeEach(() => {
  saved = {};
  for (const name of TOUCHED) {
    saved[name] = process.env[name];
    delete process.env[name];
  }
  home = mkdtempSync(join(tmpdir(), 'model-attribution-'));
  process.env.TOKEN_OPTIMIZER_CLAUDE_HOME = home;
  process.env.TOKEN_OPTIMIZER_CODEX_HOME = home;
  resetModelAttributionCache();
});

afterEach(() => {
  for (const name of TOUCHED) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
  resetModelAttributionCache();
  rmSync(home, { recursive: true, force: true });
});

describe('resolving the model from the client', () => {
  it('reads the exact model id off the newest assistant turn', async () => {
    process.env.CLAUDE_CODE_SESSION_ID = 'session-one';
    claudeTranscript('session-one', [turn('claude-sonnet-5'), turn('claude-opus-5')]);
    expect(await resolveModelUncached()).toEqual({
      model: 'claude-opus-5',
      source: MODEL_SOURCES.ClaudeCodeTranscript,
    });
  });

  it('prefers a declared model over the one the transcript names', async () => {
    process.env.CLAUDE_CODE_SESSION_ID = 'session-one';
    claudeTranscript('session-one', [turn('claude-opus-5')]);
    // The control: without the declaration the transcript answers, so this pair
    // shows the override winning rather than the transcript simply failing.
    expect((await resolveModelUncached()).model).toBe('claude-opus-5');
    process.env.TOKEN_OPTIMIZER_MODEL = 'gpt-5.6-sol';
    expect(await resolveModelUncached()).toEqual({
      model: 'gpt-5.6-sol',
      source: MODEL_SOURCES.Declared,
    });
  });

  it('skips the client bookkeeping marker and takes the real turn beneath it', async () => {
    process.env.CLAUDE_CODE_SESSION_ID = 'session-one';
    claudeTranscript('session-one', [
      turn('claude-opus-5'),
      JSON.stringify({ type: 'assistant', message: { model: '<synthetic>' } }),
    ]);
    expect((await resolveModelUncached()).model).toBe('claude-opus-5');
  });

  it('does not attribute a saving to a model id quoted inside a message', async () => {
    process.env.CLAUDE_CODE_SESSION_ID = 'session-one';
    // The newest record is a USER turn whose text contains the exact bytes a
    // buffer scan would latch onto. The assistant turn under it is the answer.
    claudeTranscript('session-one', [
      turn('claude-opus-5'),
      JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: [{ text: 'here is the config: {"model": "gpt-5.6-luna"}' }],
        },
      }),
    ]);
    const resolved = await resolveModelUncached();
    expect(resolved.model).toBe('claude-opus-5');
    expect(resolved.model).not.toBe('gpt-5.6-luna');
  });

  it('skips a torn trailing record rather than failing the read', async () => {
    process.env.CLAUDE_CODE_SESSION_ID = 'session-one';
    const lines = [turn('claude-opus-5'), '{"type":"assistant","message":{"mod'];
    claudeTranscript('session-one', lines);
    expect((await resolveModelUncached()).model).toBe('claude-opus-5');
  });

  it('grows the window past a record too large for the first one', async () => {
    process.env.CLAUDE_CODE_SESSION_ID = 'session-one';
    // 64KB is the first window; a 200KB tool result parked after the assistant
    // turn pushes it out of reach, and only the wider window finds it.
    const huge = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ text: 'x'.repeat(200_000) }] },
    });
    claudeTranscript('session-one', [turn('claude-opus-5'), huge]);
    expect(await resolveModelUncached()).toEqual({
      model: 'claude-opus-5',
      source: MODEL_SOURCES.ClaudeCodeTranscript,
    });
  });
});

describe('which session id is allowed to shape a path', () => {
  it('refuses a session id that is not an allowlisted token', async () => {
    // The control is the same transcript resolving under a legitimate id, so a
    // refusal here cannot be mistaken for the lookup being broken outright.
    process.env.CLAUDE_CODE_SESSION_ID = 'session-one';
    claudeTranscript('session-one', [turn('claude-opus-5')]);
    expect((await resolveModelUncached()).model).toBe('claude-opus-5');

    process.env.CLAUDE_CODE_SESSION_ID = '../../../../session-one';
    expect(await resolveModelUncached()).toEqual({ model: null, source: MODEL_SOURCES.None });
  });

  it('accepts the shared session id only when it names a real transcript', async () => {
    claudeTranscript('session-one', [turn('claude-opus-5')]);
    process.env.TOKEN_OPTIMIZER_SESSION_ID = 'a-hook-generated-id';
    expect((await resolveModelUncached()).source).toBe(MODEL_SOURCES.None);
    // Same variable, now holding the agent's own id: existence is what makes it
    // trustworthy, so the identical code path now answers.
    process.env.TOKEN_OPTIMIZER_SESSION_ID = 'session-one';
    expect(await resolveModelUncached()).toEqual({
      model: 'claude-opus-5',
      source: MODEL_SOURCES.ClaudeCodeTranscript,
    });
  });

  it('reports no model when no log on disk belongs to this session', async () => {
    process.env.CLAUDE_CODE_SESSION_ID = 'session-one';
    expect(await resolveModelUncached()).toEqual({ model: null, source: MODEL_SOURCES.None });
    claudeTranscript('session-one', [turn('claude-opus-5')]);
    expect((await resolveModelUncached()).model).toBe('claude-opus-5');
  });
});

describe('the codex rollout', () => {
  it('reads payload.model from the session meta', async () => {
    process.env.CODEX_SESSION_ID = 'rollout-session';
    codexRollout('rollout-session', [
      JSON.stringify({ type: 'session_meta', payload: { model: 'gpt-5.6-sol' } }),
    ]);
    expect(await resolveModelUncached()).toEqual({
      model: 'gpt-5.6-sol',
      source: MODEL_SOURCES.CodexRollout,
    });
  });

  it('matches the whole id suffix, not a filename that merely ends with it', async () => {
    process.env.CODEX_SESSION_ID = 'xyz';
    codexRollout('abcxyz', [
      JSON.stringify({ type: 'session_meta', payload: { model: 'gpt-5.6-luna' } }),
    ]);
    expect((await resolveModelUncached()).source).toBe(MODEL_SOURCES.None);
    // The control: the same tree with a rollout that really is this session's.
    codexRollout('xyz', [
      JSON.stringify({ type: 'session_meta', payload: { model: 'gpt-5.6-sol' } }),
    ]);
    expect((await resolveModelUncached()).model).toBe('gpt-5.6-sol');
  });

  it('stops looking once newer days crowd an old rollout out of the bound', async () => {
    process.env.CODEX_SESSION_ID = 'rollout-session';
    const meta = (model) =>
      JSON.stringify({ type: 'session_meta', payload: { model } });
    codexRollout('rollout-session', [meta('gpt-5.6-sol')], 30);
    // AN EXACT ID MATCH IS AUTHORITATIVE WHATEVER ITS DATE, so an old rollout
    // on its own is still this session's rollout and still answers. The bound
    // is on work, not on freshness.
    expect((await resolveModelUncached()).model).toBe('gpt-5.6-sol');

    // Three newer days of other sessions push it past the bound, and then it
    // genuinely cannot be reached -- which is the cost of not walking the whole
    // tree, stated here rather than left to be discovered.
    for (const daysAgo of [0, 1, 2]) {
      codexRollout(`other-${daysAgo}`, [meta('gpt-5.6-luna')], daysAgo);
    }
    expect((await resolveModelUncached()).source).toBe(MODEL_SOURCES.None);

    // The control: filed today, inside the bound, it is found again.
    codexRollout('rollout-session', [meta('gpt-5.6-terra')]);
    expect((await resolveModelUncached()).model).toBe('gpt-5.6-terra');
  });

  it('is consulted even when a claude transcript exists but names nothing', async () => {
    process.env.CLAUDE_CODE_SESSION_ID = 'session-one';
    process.env.CODEX_SESSION_ID = 'rollout-session';
    claudeTranscript('session-one', [JSON.stringify({ type: 'user', message: {} })]);
    codexRollout('rollout-session', [
      JSON.stringify({ type: 'session_meta', payload: { model: 'gpt-5.6-sol' } }),
    ]);
    expect(await resolveModelUncached()).toEqual({
      model: 'gpt-5.6-sol',
      source: MODEL_SOURCES.CodexRollout,
    });
  });
});

describe('caching', () => {
  it('reads once for a burst of calls and re-reads after the window', async () => {
    process.env.CLAUDE_CODE_SESSION_ID = 'session-one';
    claudeTranscript('session-one', [turn('claude-opus-5')]);
    expect((await resolveModel(1_000)).model).toBe('claude-opus-5');

    // An operator switches model mid-session. Within the window the cached
    // answer stands, which is the point of the cache; past it the new one wins.
    claudeTranscript('session-one', [turn('claude-sonnet-5')]);
    expect((await resolveModel(2_000)).model).toBe('claude-opus-5');
    expect((await resolveModel(10_000)).model).toBe('claude-sonnet-5');
  });

  it('survives a home that cannot be read at all', async () => {
    process.env.TOKEN_OPTIMIZER_CLAUDE_HOME = join(home, 'does', 'not', 'exist');
    process.env.TOKEN_OPTIMIZER_CODEX_HOME = join(home, 'does', 'not', 'exist');
    process.env.CLAUDE_CODE_SESSION_ID = 'session-one';
    expect((await resolveModel(1_000))).toEqual({ model: null, source: MODEL_SOURCES.None });
  });
});
