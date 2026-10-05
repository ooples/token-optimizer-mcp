import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * THE METER READS A CREDENTIAL AND PRINTS A LINE, AND THOSE ARE TWO JOBS.
 *
 * The provenance line names where the token was found, which plan it belongs to
 * and whether it has expired. None of that is a secret. It used to be picked
 * off the same object that carried the access token, which is a shape that
 * stays safe only for as long as every later edit remembers which field is
 * which -- so static analysis was right to call the line a credential log even
 * though no credential was in it.
 *
 * The cases below pin the split. The control arms put a token the fixture
 * really holds in front of the same assertions, so a clean reading here is a
 * reading and not a test that would pass against an empty file.
 */

const TOKEN = 'sk-ant-oat01-NOT-A-REAL-TOKEN-FIXTURE-ONLY';

let dir;
let saved;
let meter;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'meter-token-'));
  writeFileSync(
    join(dir, '.credentials.json'),
    JSON.stringify({
      claudeAiOauth: {
        accessToken: TOKEN,
        // Deliberately in the past: EXPIRED is one of the things the line says,
        // and a line that never reaches that branch would not exercise it.
        expiresAt: Date.now() - 60_000,
        subscriptionType: 'max',
        rateLimitTier: 'default',
      },
    })
  );
  // The real home is never read and never written: the loader is pointed at the
  // temporary directory above, and both readers below only read.
  saved = {
    dir: process.env.CLAUDE_CONFIG_DIR,
    token: process.env.CLAUDE_CODE_OAUTH_TOKEN,
  };
  process.env.CLAUDE_CONFIG_DIR = dir;
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  meter = await import('../../bench/subscription/meter.mjs');
});

afterAll(() => {
  if (saved.dir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = saved.dir;
  if (saved.token !== undefined) process.env.CLAUDE_CODE_OAUTH_TOKEN = saved.token;
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('what the meter prints about a credential', () => {
  it('describes the credential without carrying it', () => {
    const described = meter.describeOAuth();
    // Pinned positively as well, so the absence below is the absence of the
    // token and not the absence of a description.
    expect(described.source).toBe(join(dir, '.credentials.json'));
    expect(described.subscriptionType).toBe('max');
    expect(described.rateLimitTier).toBe('default');
    expect(described.expired).toBe(true);
    expect(JSON.stringify(described)).not.toContain(TOKEN);
  });

  it('prints the provenance without the token in it', () => {
    const line = meter.provenanceLine(meter.describeOAuth());
    expect(line).not.toContain(TOKEN);
    expect(line).toContain('plan max');
    expect(line).toContain('tier default');
    expect(line).toContain('EXPIRED');
  });

  it('control: the token really is in the file these read', () => {
    // Without this, every assertion above would pass just as happily against a
    // credential file that held no token at all.
    expect(meter.readOAuthToken().token).toBe(TOKEN);
  });

  it('control: one object carrying both is what the split removed', () => {
    const both = { ...meter.describeOAuth(), ...meter.readOAuthToken() };
    expect(JSON.stringify(both)).toContain(TOKEN);
  });

  it('keeps nothing but the token on the value that has it', () => {
    expect(Object.keys(meter.readOAuthToken())).toEqual(['token']);
  });
});