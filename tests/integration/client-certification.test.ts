import { describe, expect, it } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

describe('fleet enforcement certification', () => {
  it('certifies a routing surface for every registered client', () => {
    const repoRoot = resolve(process.cwd());
    const result = spawnSync(
      process.execPath,
      ['scripts/certify-clients.mjs', '--json', '--no-version-check'],
      { cwd: repoRoot, encoding: 'utf8' }
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');

    const report = JSON.parse(result.stdout);
    expect(report.total).toBe(report.clients.length);
    expect(report.total).toBeGreaterThanOrEqual(16);
    expect(report.protocolPassed).toBe(report.total);
    expect(report.enforcementPassed).toBe(report.total);
    const native = report.clients.filter(
      (client: { enforcementContract: string }) =>
        client.enforcementContract === 'native-pre-execution-veto'
    );
    const rules = report.clients.filter(
      (client: { enforcementContract: string }) =>
        client.enforcementContract === 'mandatory-always-on-rules'
    );
    expect(native.length).toBeGreaterThan(0);
    expect(rules.length).toBeGreaterThan(0);
    expect(native.length + rules.length).toBe(report.total);
    expect(
      report.clients.every(
        (client: {
          enforcementCertified: boolean;
          enforcementSurface: string;
        }) => client.enforcementCertified && client.enforcementSurface
      )
    ).toBe(true);

    const gemini = report.clients.find(
      (client: { client: string }) => client.client === 'gemini'
    );
    expect(gemini.checkedFiles).toContain('hooks/hooks.json');
  });
});
