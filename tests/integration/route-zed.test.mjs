/**
 * The one client that can be routed but cannot be routed automatically.
 *
 * Zed configures its assistant inside the editor, so an OpenAI-compatible provider there is a named
 * entry the user picks in the UI, with an endpoint and a model list only they know. That makes it
 * opt-in -- and everything about the opt-in has to be as reversible as the automatic path, because
 * this writes into a file the user owns and whose format we only partly control.
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  jest,
} from '@jest/globals';
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run, zedSettingsFile } from '../../scripts/route-client.mjs';

let home;
let zed;
let log;
let errors;

const read = () => JSON.parse(readFileSync(zed, 'utf8'));

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'route-zed-'));
  zed = join(home, 'zed', 'settings.json');
  mkdirSync(join(home, 'zed'), { recursive: true });
  process.env.TOKEN_OPTIMIZER_ZED_SETTINGS = zed;
  process.env.TOKEN_OPTIMIZER_HOME = join(home, '.token-optimizer');
  // A control port nothing listens on. Autostart being off stops a supervisor being STARTED, not an
  // already-running one from being found -- and a developer machine with one running turned the
  // "writes nothing when the route cannot be served" case into a real write.
  process.env.TOKEN_OPTIMIZER_PROXY_CONTROL_PORT = '1';
  log = [];
  errors = [];
  jest
    .spyOn(console, 'log')
    .mockImplementation((...args) => log.push(args.join(' ')));
  jest
    .spyOn(console, 'error')
    .mockImplementation((...args) => errors.push(args.join(' ')));
});

afterEach(() => {
  jest.restoreAllMocks();
  delete process.env.TOKEN_OPTIMIZER_ZED_SETTINGS;
  delete process.env.TOKEN_OPTIMIZER_HOME;
  delete process.env.TOKEN_OPTIMIZER_PROXY_CONTROL_PORT;
  rmSync(home, { recursive: true, force: true });
});

describe('token-optimizer-route zed', () => {
  it('uses the settings file it is pointed at', () => {
    expect(zedSettingsFile(process.env)).toBe(zed);
  });

  it('refuses to guess the endpoint or the model', async () => {
    writeFileSync(zed, '{}');
    expect(await run(['zed'])).toBe(2);
    // Naming the wrong upstream would deliver the user's credentials to a company they did not
    // choose, so this is a refusal rather than a default.
    expect(errors.join(' ')).toContain('neither can be guessed');
    expect(read()).toEqual({});
  });

  it('writes nothing when the route cannot be served', async () => {
    // Same rule as the automatic path: a settings entry naming a port nothing listens on is worse
    // than no entry at all. Autostart is off across the suite, so no route can be obtained here.
    writeFileSync(zed, JSON.stringify({ theme: 'One Dark' }));
    expect(
      await run([
        'zed',
        '--upstream',
        'https://api.openai.com/v1',
        '--model',
        'gpt-4o',
      ])
    ).toBe(1);
    expect(read()).toEqual({ theme: 'One Dark' });
  });

  it('removes only its own provider and leaves the rest of the file', async () => {
    writeFileSync(
      zed,
      JSON.stringify({
        theme: 'One Dark',
        language_models: {
          openai_compatible: {
            'token-optimizer': { api_url: 'http://127.0.0.1:1/v1' },
            'my-own-gateway': { api_url: 'https://gateway.example/v1' },
          },
        },
      })
    );
    expect(await run(['zed', '--remove'])).toBe(0);
    const after = read();
    expect(after.theme).toBe('One Dark');
    expect(
      after.language_models.openai_compatible['token-optimizer']
    ).toBeUndefined();
    expect(after.language_models.openai_compatible['my-own-gateway']).toEqual({
      api_url: 'https://gateway.example/v1',
    });
  });

  it('tidies the containers away when it was the only provider', async () => {
    writeFileSync(
      zed,
      JSON.stringify({
        theme: 'One Dark',
        language_models: {
          openai_compatible: { 'token-optimizer': { api_url: 'http://x/v1' } },
        },
      })
    );
    await run(['zed', '--remove']);
    expect(read()).toEqual({ theme: 'One Dark' });
  });

  it('says so, and changes nothing, when there is nothing of ours to remove', async () => {
    writeFileSync(zed, JSON.stringify({ theme: 'One Dark' }));
    expect(await run(['zed', '--remove'])).toBe(0);
    expect(log.join(' ')).toContain('nothing to remove');
    expect(read()).toEqual({ theme: 'One Dark' });
  });

  it('refuses a settings file with comments rather than deleting them', async () => {
    // Zed's settings file accepts comments and trailing commas; JSON.parse does not. Rewriting it
    // through a parser that cannot see a comment would silently delete the user's notes, so a file
    // we cannot read exactly is one we will not write.
    const original = '{\n  // my theme\n  "theme": "One Dark",\n}\n';
    writeFileSync(zed, original);
    expect(await run(['zed', '--remove'])).toBe(1);
    expect(errors.join(' ')).toContain('not plain JSON');
    expect(readFileSync(zed, 'utf8')).toBe(original);
  });

  it('backs the file up before changing it', async () => {
    writeFileSync(
      zed,
      JSON.stringify({
        language_models: { openai_compatible: { 'token-optimizer': {} } },
      })
    );
    await run(['zed', '--remove']);
    expect(existsSync(`${zed}.before-token-optimizer`)).toBe(true);
  });
});
