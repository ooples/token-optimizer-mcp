import { describe, it, expect } from '@jest/globals';
import {
  coldKey,
  enterColdGate,
  inFlightCount,
  coldGateEnabled,
} from '../../../src/proxy/cold-gate.js';

const first = (task: string, shared = 'listing') =>
  Buffer.from(
    JSON.stringify({
      tools: [{ name: 'Read' }],
      system: [{ type: 'text', text: 'sys' }],
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: shared },
            { type: 'text', text: task },
          ],
        },
      ],
    })
  );

describe('coldKey', () => {
  it('is the same for siblings that differ only in their task', () => {
    expect(coldKey(first('fix pricing'))).toBe(coldKey(first('fix ledger')));
    expect(coldKey(first('fix pricing'))).not.toBe(
      coldKey(first('fix pricing', 'other listing'))
    );
  });

  it('is null for a later turn of a conversation', () => {
    const later = JSON.parse(first('t').toString());
    later.messages.push(
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: 'go on' }
    );
    expect(coldKey(Buffer.from(JSON.stringify(later)))).toBeNull();
  });

  it('is null for a body too large to parse on this path', () => {
    expect(coldKey(first('t'), 10)).toBeNull();
  });
});

describe('enterColdGate', () => {
  it('lets the leader through at once and holds a sibling until the leader answers', async () => {
    const key = coldKey(first('a'));
    const leader = await enterColdGate(key, 5000);
    expect(leader.waitedMs).toBe(0);
    let followerDone = false;
    const follower = enterColdGate(key, 5000).then((g) => {
      followerDone = true;
      return g;
    });
    await new Promise((r) => setTimeout(r, 120));
    expect(followerDone).toBe(false);
    leader.release();
    const g = await follower;
    expect(followerDone).toBe(true);
    expect(g.waitedMs).toBeGreaterThanOrEqual(100);
    expect(inFlightCount()).toBe(0);
  });

  it('never holds a sibling past the cap when the leader never answers', async () => {
    const key = coldKey(first('hung', 'hung listing'));
    await enterColdGate(key, 150);
    const started = Date.now();
    const g = await enterColdGate(key, 150);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(g.waitedMs).toBeGreaterThanOrEqual(100);
  });

  it('passes a request with no key straight through', async () => {
    const g = await enterColdGate(null);
    expect(g.waitedMs).toBe(0);
  });

  it('TOKEN_OPTIMIZER_PROXY_COLD_GATE=0 turns it off', () => {
    expect(coldGateEnabled({})).toBe(true);
    expect(coldGateEnabled({ TOKEN_OPTIMIZER_PROXY_COLD_GATE: '0' })).toBe(
      false
    );
  });
});
