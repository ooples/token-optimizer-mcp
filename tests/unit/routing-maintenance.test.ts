import { describe, it, expect, jest, afterEach } from '@jest/globals';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startRoutingMaintenance } from '../../src/proxy/routing-maintenance.js';
import { controlPort } from '../../src/proxy/supervisor.js';

/*
 * ASKED FOR, NOT WRITTEN DOWN. The recovery guard compares the saved controlUrl against the port
 * the supervisor would bind now, so a literal here is a fixture that goes stale the moment the
 * default moves -- which is exactly what happened: this was written against 45710 and #428 moved
 * the default to 16999, below the range the kernel allocates outbound source ports from. The
 * guard then declined every recovery and the suite failed on four Node versions.
 */
const controlUrl = `http://127.0.0.1:${controlPort({})}`;

const homes: string[] = [];
const stops: (() => void)[] = [];
function fixture() {
  jest.useFakeTimers();
  const home = mkdtempSync(join(tmpdir(), 'routing-maintenance-'));
  homes.push(home);
  const path = join(home, 'settings.json');
  const env = { TOKEN_OPTIMIZER_HOME: home, TOKEN_OPTIMIZER_SETTINGS: path };
  writeFileSync(
    path,
    JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:12345' } })
  );
  writeFileSync(
    join(home, 'default-routing.json'),
    JSON.stringify({
      schema: 1,
      entries: {
        [path]: {
          variable: 'ANTHROPIC_BASE_URL',
          value: 'http://127.0.0.1:12345',
        },
      },
    })
  );
  return { home, path, env };
}
afterEach(() => {
  stops.splice(0).forEach((stop) => stop());
  jest.useRealTimers();
  homes
    .splice(0)
    .forEach((home) => rmSync(home, { recursive: true, force: true }));
});

describe('routing maintenance lifecycle', () => {
  it('recovers shared routes without a Claude installation and respects the proxy opt-out', async () => {
    const { env, home, path } = fixture();
    rmSync(path);
    rmSync(join(home, 'default-routing.json'));
    writeFileSync(
      join(home, 'proxy-supervisor.json'),
      JSON.stringify({
        schema: 1,
        controlUrl,
        routes: [{ upstream: 'https://gateway.example' }],
      })
    );
    const recover = jest.fn(async () => true);
    const maintain = jest.fn(async () => ({ status: 'no-client' as const }));
    stops.push(
      startRoutingMaintenance({ env, intervalMs: 100, recover, maintain }).stop
    );
    await jest.advanceTimersByTimeAsync(200);
    expect(recover).toHaveBeenCalledTimes(3);
    expect(maintain).toHaveBeenCalledTimes(1);
    Object.assign(env, { TOKEN_OPTIMIZER_PROXY: '0' });
    await jest.advanceTimersByTimeAsync(200);
    expect(recover).toHaveBeenCalledTimes(3);
  });
  it('retries after startup and transient errors, without overlapping slow attempts', async () => {
    const { env } = fixture();
    let release!: () => void;
    let calls = 0;
    const maintain = async () => {
      calls++;
      if (calls === 1)
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      if (calls === 2) throw new Error('transient error');
      return { status: 'unchanged' as const };
    };
    const { stop } = startRoutingMaintenance({ env, intervalMs: 100, maintain });
    stops.push(stop);
    await jest.advanceTimersByTimeAsync(1000);
    expect(calls).toBe(1);
    release();
    await jest.advanceTimersByTimeAsync(200);
    expect(calls).toBe(3);
    stop();
    await jest.advanceTimersByTimeAsync(1000);
    expect(calls).toBe(3);
  });

  it('leaves user endpoint changes and removed routing alone', async () => {
    const { env, path, home } = fixture();
    const maintain = jest.fn(async () => ({ status: 'unchanged' as const }));
    stops.push(startRoutingMaintenance({ env, intervalMs: 100, maintain }).stop);
    writeFileSync(
      path,
      JSON.stringify({
        env: { ANTHROPIC_BASE_URL: 'https://my-gateway.example' },
      })
    );
    await jest.advanceTimersByTimeAsync(300);
    expect(maintain).toHaveBeenCalledTimes(1);
    rmSync(join(home, 'default-routing.json'));
    await jest.advanceTimersByTimeAsync(300);
    expect(maintain).toHaveBeenCalledTimes(1);
  });

  it('does not schedule more work when stopped during recovery', async () => {
    const { env } = fixture();
    let release!: () => void;
    const maintain = jest.fn(async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { status: 'unchanged' as const };
    });
    const { stop } = startRoutingMaintenance({ env, intervalMs: 100, maintain });
    stops.push(stop);
    stop();
    release();
    await jest.advanceTimersByTimeAsync(1000);
    expect(maintain).toHaveBeenCalledTimes(1);
  });

  const deferring = () =>
    jest.fn(async (_env: NodeJS.ProcessEnv, options?: { switchTiming?: string }) =>
      options?.switchTiming === 'when-no-session'
        ? { status: 'deferred' as const, url: 'http://127.0.0.1:12345' }
        : { status: 'written' as const }
    );
  const begin = async (options: Parameters<typeof startRoutingMaintenance>[0]) => {
    const m = startRoutingMaintenance({ intervalMs: 100, parentPid: 4242, ...options });
    stops.push(m.stop);
    await jest.advanceTimersByTimeAsync(0);
    m.stop();
    return m;
  };

  it('prepares a new route at startup and hands the write to a committer at shutdown', async () => {
    const { env } = fixture();
    Object.assign(env, { CLAUDE_CODE_SESSION_ID: 'mine' });
    const maintain = deferring();
    const spawnCommit = jest.fn(() => true);
    const m = await begin({ env, maintain, spawnCommit });
    expect(maintain.mock.calls.map((call) => call[1]?.switchTiming)).toEqual(['when-no-session']);
    expect(spawnCommit).not.toHaveBeenCalled();
    expect(m.commitDeferred()).toBe(true);
    expect(spawnCommit).toHaveBeenCalledWith(env, { pids: [4242], sessionId: 'mine' });
    // Once, not again on a second shutdown path; and the server itself never writes.
    expect(m.commitDeferred()).toBe(false);
    expect(maintain).toHaveBeenCalledTimes(1);
  });

  it('has nothing to hand over when startup did not defer', async () => {
    const { env } = fixture();
    const maintain = jest.fn(async () => ({ status: 'unchanged' as const }));
    const spawnCommit = jest.fn(() => true);
    const m = await begin({ env, maintain, spawnCommit });
    expect(m.commitDeferred()).toBe(false);
    expect(spawnCommit).not.toHaveBeenCalled();
  });
});
