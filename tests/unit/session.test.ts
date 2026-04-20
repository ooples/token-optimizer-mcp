import { describe, it, expect } from '@jest/globals';
import { Session } from '../../src/core/session.js';
import { SessionManager } from '../../src/core/session-manager.js';
import { HeuristicTokenizer } from '../../src/core/tokenizers/heuristic-tokenizer.js';

describe('Session', () => {
  it('appends messages and tracks updatedAt', async () => {
    const session = new Session({ allowCharHeuristic: true });
    const before = session.updatedAt;
    await new Promise((r) => setTimeout(r, 5));
    session.addMessage('user', 'hi');
    expect(session.getHistory().length).toBe(1);
    expect(session.updatedAt).toBeGreaterThan(before);
  });

  it('compressHistory is a no-op under the budget', async () => {
    const session = new Session({
      maxTokens: 10_000,
      allowCharHeuristic: true,
    });
    session.addMessage('user', 'short');
    const before = session.getHistory().length;
    await session.compressHistory();
    expect(session.getHistory().length).toBe(before);
  });

  it('getHistoryTokenCount throws without a tokenizer when heuristic is off', async () => {
    const session = new Session();
    session.addMessage('user', 'hi');
    await expect(session.getHistoryTokenCount()).rejects.toThrow(
      /requires a tokenizer/
    );
  });

  it('clearFileContent removes the entry', () => {
    const session = new Session();
    session.setFileContent('a.ts', 'const x = 1;');
    session.clearFileContent('a.ts');
    expect(session.getFileContent('a.ts')).toBeUndefined();
  });

  it('compressHistory summarizes head when over budget', async () => {
    const tokenizer = new HeuristicTokenizer();
    const session = new Session({ maxTokens: 50, tokenizer });
    // Each long message is several hundred chars → easily over 50 tokens.
    for (let i = 0; i < 10; i++) {
      session.addMessage('user', 'a'.repeat(400) + ` turn=${i}`);
    }
    expect((await session.getHistoryTokenCount()) > 50).toBe(true);
    await session.compressHistory();
    const history = session.getHistory();
    expect(history[0].role).toBe('system');
    expect(history[0].content.startsWith('[summary')).toBe(true);
    expect(history.length).toBeLessThan(10);
  });

  it('snapshot round-trips', () => {
    const session = new Session({ maxTokens: 42 });
    session.addMessage('user', 'hello');
    session.setFileContent('a.ts', 'const x = 1;');
    const snapshot = session.toSnapshot();
    const restored = Session.fromSnapshot(snapshot);
    expect(restored.id).toBe(session.id);
    expect(restored.maxTokens).toBe(42);
    expect(restored.getFileContent('a.ts')).toBe('const x = 1;');
    expect(restored.getHistory()[0].content).toBe('hello');
  });
});

describe('SessionManager', () => {
  it('create/get/delete lifecycle', () => {
    const manager = new SessionManager();
    const session = manager.createSession();
    expect(manager.getSession(session.id)).toBe(session);
    expect(manager.deleteSession(session.id)).toBe(true);
    expect(manager.getSession(session.id)).toBeUndefined();
  });

  it('addMessage auto-compresses when over budget', async () => {
    const tokenizer = new HeuristicTokenizer();
    const manager = new SessionManager({ tokenizer, defaultMaxTokens: 30 });
    const session = manager.createSession();
    for (let i = 0; i < 8; i++) {
      await manager.addMessage(session.id, 'user', 'x'.repeat(300));
    }
    const history = session.getHistory();
    expect(history[0].content.startsWith('[summary')).toBe(true);
  });

  it('throws for unknown session ids', async () => {
    const manager = new SessionManager();
    await expect(manager.addMessage('bogus', 'user', 'hi')).rejects.toThrow();
  });
});
