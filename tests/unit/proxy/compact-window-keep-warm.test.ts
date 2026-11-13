import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import {
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  mkdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyCompactWindow,
  compactWindowFromEnv,
  compactWindowRecordFile,
  legacyCompactWindowRecordFile,
  DEFAULT_COMPACT_WINDOW,
} from '../../../src/proxy/compact-window.js';
import {
  KeepWarm,
  pingBody,
  ttlOf,
  PING_MAX_TOKENS,
  MIN_PREFIX_BYTES,
  pingDelay,
  warmConversationKey,
} from '../../../src/proxy/keep-warm.js';

let home: string;
let env: NodeJS.ProcessEnv;
const settingsPath = () => join(home, '.claude', 'settings.json');
const read = () => JSON.parse(readFileSync(settingsPath(), 'utf8'));
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'compact-window-'));
  mkdirSync(join(home, '.claude'), { recursive: true });
  env = {
    TOKEN_OPTIMIZER_HOME: join(home, '.token-optimizer'),
    TOKEN_OPTIMIZER_SETTINGS: settingsPath(),
  };
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe('the compaction window (user decision: ~400k)', () => {
  it('writes 400k when the setting is absent, and keeps the rest of the file', () => {
    writeFileSync(settingsPath(), JSON.stringify({ env: { A: '1' } }));
    expect(applyCompactWindow(env)).toBe('written');
    expect(read()).toEqual({
      env: { A: '1' },
      autoCompactWindow: DEFAULT_COMPACT_WINDOW,
    });
    expect(applyCompactWindow(env)).toBe('unchanged');
  });

  it("never overrides the user's own value", () => {
    writeFileSync(
      settingsPath(),
      JSON.stringify({ autoCompactWindow: 700000 })
    );
    expect(applyCompactWindow(env)).toBe('user-owned');
    expect(read().autoCompactWindow).toBe(700000);
  });

  it('off takes back only the value we wrote', () => {
    writeFileSync(settingsPath(), JSON.stringify({}));
    applyCompactWindow(env);
    expect(
      applyCompactWindow({ ...env, TOKEN_OPTIMIZER_COMPACT_WINDOW: 'off' })
    ).toBe('removed');
    expect(read().autoCompactWindow).toBeUndefined();
    writeFileSync(
      settingsPath(),
      JSON.stringify({ autoCompactWindow: 500000 })
    );
    expect(
      applyCompactWindow({ ...env, TOKEN_OPTIMIZER_COMPACT_WINDOW: 'off' })
    ).toBe('disabled');
    expect(read().autoCompactWindow).toBe(500000);
  });

  it('a process with a private home leaves a record the usual install can find and take back', () => {
    writeFileSync(settingsPath(), JSON.stringify({}));
    const isolated = {
      ...env,
      TOKEN_OPTIMIZER_HOME: join(home, 'private-home'),
    };
    expect(applyCompactWindow(isolated)).toBe('written');
    expect(compactWindowRecordFile(isolated)).toBe(
      join(home, '.claude', 'token-optimizer-compact-window.json')
    );
    // The usual install, with its own home, owns it and can remove it.
    expect(
      applyCompactWindow({ ...env, TOKEN_OPTIMIZER_COMPACT_WINDOW: 'off' })
    ).toBe('removed');
    expect(read().autoCompactWindow).toBeUndefined();
    // Nothing left to record: no empty file stays in the client's folder.
    expect(existsSync(compactWindowRecordFile(env))).toBe(false);
  });

  it('a record an earlier version left in the home is read, then moved on the next write', () => {
    writeFileSync(
      settingsPath(),
      JSON.stringify({ autoCompactWindow: DEFAULT_COMPACT_WINDOW })
    );
    mkdirSync(join(home, '.token-optimizer'), { recursive: true });
    const other = join(home, 'elsewhere', 'settings.json');
    writeFileSync(
      legacyCompactWindowRecordFile(env),
      JSON.stringify({
        [settingsPath()]: { value: DEFAULT_COMPACT_WINDOW, writtenAt: 'x' },
        [other]: { value: DEFAULT_COMPACT_WINDOW, writtenAt: 'x' },
      })
    );
    expect(
      applyCompactWindow({ ...env, TOKEN_OPTIMIZER_COMPACT_WINDOW: 'off' })
    ).toBe('removed');
    expect(
      Object.keys(
        JSON.parse(readFileSync(legacyCompactWindowRecordFile(env), 'utf8'))
      )
    ).toEqual([other]);
  });

  it('accepts a token count, rejects nonsense', () => {
    expect(
      compactWindowFromEnv({ TOKEN_OPTIMIZER_COMPACT_WINDOW: '300k' })
    ).toBe(300000);
    expect(compactWindowFromEnv({ TOKEN_OPTIMIZER_COMPACT_WINDOW: '5' })).toBe(
      DEFAULT_COMPACT_WINDOW
    );
    expect(
      compactWindowFromEnv({ TOKEN_OPTIMIZER_COMPACT_WINDOW: '0' })
    ).toBeNull();
  });
});

describe('keep-warm', () => {
  const big = (ttl: string) =>
    Buffer.from(
      JSON.stringify({
        model: 'm',
        max_tokens: 128000,
        stream: true,
        system: [
          {
            type: 'text',
            text: 's',
            cache_control: { type: 'ephemeral', ttl },
          },
        ],
        messages: [{ role: 'user', content: 'x'.repeat(250_000) }],
      })
    );
  const target = (body: Buffer) => ({
    upstream: 'https://example.invalid',
    path: '/v1/messages',
    headers: { 'x-api-key': 'k' },
    body,
    ttlMs: 60,
  });

  it('reads the TTL the request asked for', () => {
    expect(ttlOf(big('1h'))).toBe(60 * 60 * 1000);
    expect(ttlOf(big('5m'))).toBe(5 * 60 * 1000);
  });

  it('pings with the same prompt, a few output tokens, no stream', () => {
    const body = big('1h');
    const ping = JSON.parse(pingBody(body)!.toString());
    const orig = JSON.parse(body.toString());
    expect(ping.max_tokens).toBe(PING_MAX_TOKENS);
    expect(ping.stream).toBe(false);
    expect(ping.system).toEqual(orig.system);
    expect(ping.messages).toEqual(orig.messages);
  });

  it('pings up to the cap, then stops; a newer real turn re-arms it', async () => {
    const sent: number[] = [];
    const warm = new KeepWarm({
      maxPings: 2,
      marginMs: 0,
      minPrefixBytes: 1000,
      sender: async () => {
        sent.push(Date.now());
        return {
          status: 200,
          json: { usage: { cache_read_input_tokens: 70000, output_tokens: 3 } },
        };
      },
    });
    warm.seen('k', { ...target(big('1h')), ttlMs: 1100 });
    await new Promise((r) => setTimeout(r, 3600));
    expect(sent.length).toBe(2);
    expect(warm.size()).toBe(0);
    warm.stop();
  });

  it('stops at once when a ping reads nothing back (the entry was already gone)', async () => {
    let n = 0;
    const warm = new KeepWarm({
      maxPings: 5,
      marginMs: 0,
      minPrefixBytes: 1000,
      sender: async () => {
        n++;
        return {
          status: 200,
          json: {
            usage: {
              cache_read_input_tokens: 0,
              cache_creation_input_tokens: 90000,
            },
          },
        };
      },
    });
    warm.seen('k', { ...target(big('5m')), ttlMs: 1100 });
    await new Promise((r) => setTimeout(r, 2600));
    expect(n).toBe(1);
    expect(warm.size()).toBe(0);
  });

  it('never holds a small conversation warm', () => {
    const warm = new KeepWarm({
      sender: async () => ({ status: 200, json: {} }),
    });
    warm.seen('k', target(Buffer.from('{"messages":[]}')));
    expect(warm.size()).toBe(0);
  });
});

describe('keep-warm knows when a cache has certainly expired', () => {
  it('only after the TTL plus slack, and never for an unknown conversation', () => {
    let now = 1_000_000;
    const warm = new KeepWarm({ minPrefixBytes: 10_000_000, now: () => now });
    const t = {
      upstream: 'https://example.invalid',
      path: '/v1/messages',
      headers: {},
      body: Buffer.from('{}'),
      ttlMs: 300_000,
    };
    expect(warm.expired('k')).toBe(false);
    warm.seen('k', t);
    now += 300_000 + 30_000;
    expect(warm.expired('k')).toBe(false);
    now += 60_000;
    expect(warm.expired('k')).toBe(true);
    warm.seen('k', t);
    expect(warm.expired('k')).toBe(false);
  });
});

describe('review fixes on #523', () => {
  it('does not ping a request with a fixed thinking budget, and still pings adaptive thinking', () => {
    const body = (thinking: object) =>
      Buffer.from(
        JSON.stringify({
          model: 'm',
          max_tokens: 64000,
          thinking,
          messages: [{ role: 'user', content: 'x' }],
        })
      );
    expect(
      pingBody(body({ type: 'enabled', budget_tokens: 16000 }))
    ).toBeNull();
    const adaptive = pingBody(body({ type: 'adaptive' }));
    expect(JSON.parse(adaptive!.toString()).thinking).toEqual({
      type: 'adaptive',
    });
  });

  it('TOKEN_OPTIMIZER_MODE=off removes the window we wrote', () => {
    writeFileSync(settingsPath(), JSON.stringify({}));
    expect(applyCompactWindow(env)).toBe('written');
    expect(compactWindowFromEnv({ TOKEN_OPTIMIZER_MODE: 'off' })).toBeNull();
    expect(applyCompactWindow({ ...env, TOKEN_OPTIMIZER_MODE: 'off' })).toBe(
      'removed'
    );
    expect(read().autoCompactWindow).toBeUndefined();
  });
});

describe('keep-warm for subagents (#567)', () => {
  it('spends the pings covering a 5-minute gap, not its first three minutes', () => {
    expect(pingDelay(5 * 60 * 1000)).toBe(270_000);
    expect(pingDelay(60 * 60 * 1000)).toBe(56 * 60 * 1000);
    expect(pingDelay(5 * 60 * 1000, 0)).toBe(300_000);
    expect(pingDelay(500, 0)).toBe(1000);
  });

  it('holds a typical subagent context warm', () => {
    const body = Buffer.from(
      JSON.stringify({
        messages: [{ role: 'user', content: 'x'.repeat(140_000) }],
      })
    );
    expect(body.length).toBeGreaterThanOrEqual(MIN_PREFIX_BYTES);
    const warm = new KeepWarm({
      sender: async () => ({ status: 200, json: {} }),
    });
    warm.seen('k', {
      upstream: 'https://example.invalid',
      path: '/v1/messages',
      headers: {},
      body,
      ttlMs: 300_000,
    });
    expect(warm.size()).toBe(1);
    warm.stop();
  });

  it('keys siblings of a fan-out apart, and one conversation the same on every turn', () => {
    const reminder = {
      type: 'text',
      text: '<system-reminder>CLAUDE.md</system-reminder>',
    };
    const agent = (task: string, more: unknown[] = []) => ({
      messages: [
        {
          role: 'user',
          content: [
            reminder,
            { type: 'text', text: task, cache_control: { type: 'ephemeral' } },
          ],
        },
        ...more,
      ],
    });
    const a = warmConversationKey(agent('audit the parser'), 'base');
    const b = warmConversationKey(agent('audit the lexer'), 'base');
    expect(a).not.toBe(b);
    const later = agent('audit the parser', [
      { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
      { role: 'user', content: 'next' },
    ]);
    // a moved cache marker is not part of the key
    (
      later.messages[0].content[1] as { cache_control?: unknown }
    ).cache_control = undefined;
    expect(warmConversationKey(later, 'base')).toBe(a);
    expect(warmConversationKey(agent('audit the parser'), 'other')).not.toBe(a);
    expect(
      warmConversationKey(
        { messages: [{ role: 'user', content: 'plain' }] },
        'base'
      )
    ).not.toBe(
      warmConversationKey(
        { messages: [{ role: 'user', content: 'other' }] },
        'base'
      )
    );
    expect(typeof warmConversationKey({}, 'base')).toBe('string');
  });

  it('holds each sibling warm on its own', () => {
    const warm = new KeepWarm({
      minPrefixBytes: 10,
      sender: async () => ({ status: 200, json: {} }),
    });
    const t = {
      upstream: 'https://example.invalid',
      path: '/v1/messages',
      headers: {},
      body: Buffer.from('x'.repeat(100)),
      ttlMs: 300_000,
    };
    warm.seen(
      warmConversationKey(
        { messages: [{ role: 'user', content: 'one' }] },
        'base'
      ),
      t
    );
    warm.seen(
      warmConversationKey(
        { messages: [{ role: 'user', content: 'two' }] },
        'base'
      ),
      t
    );
    expect(warm.size()).toBe(2);
    warm.stop();
  });
});
