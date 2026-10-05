/**
 * The doctor says which copy is running, and how to replace it.
 *
 * The same defect as doctor-reports-telemetry-state.test.ts, pointed at the
 * version: `checkForUpdate` and `describeUpdate` can be right and still leave a
 * user reading the source to learn they are two releases behind the fix for the
 * bug they are diagnosing. This asserts the wiring, not the comparison.
 *
 * It must also not open a socket when consent says no. A person running the
 * doctor to find out whether this tool phones home is the last person to phone
 * home for, so the suppressed case asserts the fetcher was never called -- an
 * assertion on the printed reason alone would pass with the request still made.
 */
import { describe, it, expect } from '@jest/globals';
import { versionSection } from '../../../src/server/doctor-tool.js';

const env = (extra: Record<string, string> = {}): NodeJS.ProcessEnv =>
  ({ ...extra }) as NodeJS.ProcessEnv;

/** A fetcher that records each call, so "never asked" is testable. */
const counting = (
  version: string
): { fetcher: typeof fetch; calls: () => number } => {
  let calls = 0;
  const fetcher = (async () => {
    calls += 1;
    return {
      ok: true,
      status: 200,
      json: async () => ({ version }),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fetcher, calls: () => calls };
};

describe('the version block in the doctor report', () => {
  it('is headed and indented like the other blocks', async () => {
    const { fetcher } = counting('9999.0.0');
    const lines = await versionSection({ env: env(), fetcher });
    expect(lines[0]).toBe('');
    expect(lines[1]).toBe('Version');
    for (const line of lines.slice(2)) expect(line.startsWith('  ')).toBe(true);
  });

  it('names an upgrade when the registry has a newer release', async () => {
    const { fetcher } = counting('9999.0.0');
    const lines = await versionSection({ env: env(), fetcher });
    const body = lines.join('\n');
    expect(body).toContain('behind the published 9999.0.0');
  });

  it('asks nothing of the registry when DO_NOT_TRACK is set', async () => {
    const { fetcher, calls } = counting('9999.0.0');
    const lines = await versionSection({
      env: env({ DO_NOT_TRACK: '1' }),
      fetcher,
    });
    expect(calls()).toBe(0);
    expect(lines.join('\n')).toContain('DO_NOT_TRACK is set');
  });

  it('asks nothing when the update check is switched off by itself', async () => {
    const { fetcher, calls } = counting('9999.0.0');
    const lines = await versionSection({
      env: env({ TOKEN_OPTIMIZER_UPDATE_CHECK: '0' }),
      fetcher,
    });
    expect(calls()).toBe(0);
    expect(lines.join('\n')).toContain('unknown');
  });

  it('never claims current when the registry could not be reached', async () => {
    const fetcher = (async () => {
      throw new Error('getaddrinfo ENOTFOUND registry.npmjs.org');
    }) as unknown as typeof fetch;
    const body = (await versionSection({ env: env(), fetcher })).join('\n');
    expect(body).not.toContain('the published latest');
    expect(body).toContain('could not be reached');
  });
});