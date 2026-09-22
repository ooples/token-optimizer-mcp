import { describe, it, expect, jest, afterEach } from '@jest/globals';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startRoutingMaintenance } from '../../src/proxy/routing-maintenance.js';

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
        controlUrl: 'http://127.0.0.1:45710',
        routes: [{ upstream: 'https://gateway.example' }],
      })
    );
    const recover = jest.fn(async () => true);
    const maintain = jest.fn(async () => ({ status: 'no-client' as const }));
    stops.push(
      startRoutingMaintenance({ env, intervalMs: 100, recover, maintain })
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
    const stop = startRoutingMaintenance({ env, intervalMs: 100, maintain });
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
    stops.push(startRoutingMaintenance({ env, intervalMs: 100, maintain }));
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
    const stop = startRoutingMaintenance({ env, intervalMs: 100, maintain });
    stops.push(stop);
    stop();
    release();
    await jest.advanceTimersByTimeAsync(1000);
    expect(maintain).toHaveBeenCalledTimes(1);
  });
});
