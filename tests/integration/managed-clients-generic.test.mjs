/**
 * The seven clients beyond Claude, Codex and OpenCode.
 *
 * Compression being on by default is worth nothing if it only reaches the client this package was
 * first written for, so these tests are about the two ways the generic path can be wrong and say
 * nothing: a client that is silently left unrouted, and a client that is routed through the wrong
 * variable -- which looks identical from outside, because the CLI simply keeps talking to its
 * provider and no error is ever raised.
 *
 * Each case launches a fake client (a Node script named through `command`) that records the
 * environment and arguments it was handed, so what is asserted is what the real CLI would receive.
 */

import { describe, it, expect } from '@jest/globals';
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  rmSync,
  mkdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runClient } from '../../scripts/run-client.mjs';
import {
  launcherCommands,
  commandExists,
} from '../../scripts/managed-clients.mjs';

/** A fake client that dumps the environment and argv it was launched with. */
function recorder(dir) {
  const file = join(dir, 'launched.json');
  const script = join(dir, 'fake-client.mjs');
  writeFileSync(
    script,
    `import fs from 'node:fs';` +
      `fs.writeFileSync(${JSON.stringify(file)}, JSON.stringify({ env: process.env, argv: process.argv.slice(2) }));`
  );
  return { script, read: () => JSON.parse(readFileSync(file, 'utf8')) };
}

/** A launch environment with no inherited provider settings to confuse the result. */
function cleanEnv(extra = {}) {
  const env = {
    ...process.env,
    TOKEN_OPTIMIZER_PROXY: '1',
    TOKEN_OPTIMIZER_MODE: 'balanced',
  };
  for (const name of [
    'OPENAI_BASE_URL',
    'ANTHROPIC_BASE_URL',
    'GOOGLE_GEMINI_BASE_URL',
    'COPILOT_API_URL',
    'AMP_URL',
  ])
    delete env[name];
  return { ...env, ...extra };
}

async function launch(command, env) {
  const dir = mkdtempSync(join(tmpdir(), 'optimizer-generic-'));
  try {
    const fake = recorder(dir);
    const code = await runClient(command, [fake.script], {
      env,
      command: process.execPath,
    });
    return { code, ...fake.read() };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const loopback = /^http:\/\/127\.0\.0\.1:\d+/;

describe('managed launch beyond the first three clients', () => {
  it('leaves Gemini alone until its own variable names an endpoint', async () => {
    // CHANGED DELIBERATELY. This asserted that Gemini has one provider and could be routed by
    // default. It has three transports: a Gemini API key talks to generativelanguage.googleapis.com,
    // a Google login talks to the Code Assist endpoint through CODE_ASSIST_ENDPOINT, and Vertex
    // reads GOOGLE_VERTEX_BASE_URL. GOOGLE_GEMINI_BASE_URL governs only the first, so a default
    // would route API-key sessions and silently miss the other two.
    const launched = await launch('gemini', cleanEnv());
    expect(launched.code).toBe(0);
    expect(launched.env.GOOGLE_GEMINI_BASE_URL).toBeUndefined();
    // The identity the MCP server and hooks see has to be the client id, not the command.
    expect(launched.env.TOKEN_OPTIMIZER_CLIENT).toBe('gemini');
  }, 30_000);

  it('routes Gemini once its endpoint is known', async () => {
    const launched = await launch(
      'gemini',
      cleanEnv({
        GOOGLE_GEMINI_BASE_URL: 'https://generativelanguage.googleapis.com',
      })
    );
    expect(launched.env.GOOGLE_GEMINI_BASE_URL).toMatch(loopback);
  }, 30_000);

  it('never hands a non-Claude client Claude’s MCP flag', async () => {
    // --mcp-config is Claude Code's. Passing it to any other CLI turns a launch into a usage error,
    // so the user would experience "on by default" as their client refusing to start.
    const launched = await launch('gemini', cleanEnv());
    expect(launched.argv).not.toContain('--mcp-config');
    expect(launched.argv.filter((arg) => arg !== launched.argv[0])).toEqual([]);
  }, 30_000);

  it('leaves a multi-provider client alone when it has not said which provider it uses', async () => {
    // Crush, Droid, Qwen and Continue each choose a provider in their own configuration. Routing one
    // on a guess would forward its credentials to whichever company we guessed, so the fail-safe is
    // to change nothing.
    const launched = await launch('crush', cleanEnv());
    expect(launched.code).toBe(0);
    expect(launched.env.OPENAI_BASE_URL).toBeUndefined();
  }, 30_000);

  it('routes that same client once its endpoint is known', async () => {
    const launched = await launch(
      'crush',
      cleanEnv({ OPENAI_BASE_URL: 'https://gateway.example/v1' })
    );
    expect(launched.env.OPENAI_BASE_URL).toMatch(loopback);
    // The user's own path survives: the proxy is inserted in front of their gateway, not instead
    // of it.
    expect(launched.env.OPENAI_BASE_URL).toMatch(/\/v1$/);
  }, 30_000);

  it('routes Copilot through COPILOT_API_URL and not the OpenAI variable', async () => {
    // Copilot speaks an OpenAI-shaped API, which is exactly why the wrong variable here would look
    // plausible and change nothing about where its traffic goes.
    const launched = await launch(
      'copilot',
      cleanEnv({ COPILOT_API_URL: 'https://api.enterprise.example' })
    );
    expect(launched.env.COPILOT_API_URL).toMatch(loopback);
    expect(launched.env.OPENAI_BASE_URL).toBeUndefined();
  }, 30_000);

  it('knows Continue by its command, which is not its name', async () => {
    const launched = await launch(
      'cn',
      cleanEnv({ OPENAI_BASE_URL: 'https://gateway.example/v1' })
    );
    expect(launched.env.TOKEN_OPTIMIZER_CLIENT).toBe('continue');
    expect(launched.env.OPENAI_BASE_URL).toMatch(loopback);
  }, 30_000);

  it('does not treat a route we wrote earlier as an upstream to forward to', async () => {
    // A stale loopback value in the environment -- left by an earlier session -- would otherwise
    // make the proxy forward to itself, and the client would hang rather than fail.
    const launched = await launch(
      'gemini',
      cleanEnv({ GOOGLE_GEMINI_BASE_URL: 'http://127.0.0.1:45999' })
    );
    expect(launched.env.GOOGLE_GEMINI_BASE_URL).toMatch(loopback);
    expect(launched.env.GOOGLE_GEMINI_BASE_URL).not.toBe(
      'http://127.0.0.1:45999'
    );
  }, 30_000);

  it('refuses a command it does not manage instead of launching it', async () => {
    await expect(
      runClient('definitely-not-a-client', [], { env: cleanEnv() })
    ).rejects.toThrow(/does not support/);
  });
});

describe('which clients get a launcher', () => {
  it('wraps only commands that are actually installed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'optimizer-detect-'));
    try {
      const bin = join(dir, 'bin');
      mkdirSync(bin);
      writeFileSync(
        join(bin, process.platform === 'win32' ? 'qwen.cmd' : 'qwen'),
        ''
      );
      const env = { PATH: bin };
      expect(
        launcherCommands({
          env,
          platform: process.platform,
          directory: join(dir, 'ours'),
        })
      ).toEqual(['qwen']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not count its own launchers as an installed client', () => {
    // After the first activation our directory is on PATH holding exactly these names. Counting it
    // would make every client look installed from then on, and uninstalling one would never remove
    // its wrapper.
    const dir = mkdtempSync(join(tmpdir(), 'optimizer-detect-ours-'));
    try {
      writeFileSync(
        join(dir, process.platform === 'win32' ? 'qwen.cmd' : 'qwen'),
        ''
      );
      expect(
        commandExists('qwen', { env: { PATH: dir }, directory: dir })
      ).toBe(false);
      expect(launcherCommands({ env: { PATH: dir }, directory: dir })).toEqual(
        []
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('lets a user name the set when detection cannot see their install', () => {
    expect(
      launcherCommands({
        env: { PATH: '', TOKEN_OPTIMIZER_MANAGED_CLIENTS: 'all' },
      })
    ).toHaveLength(10);
    expect(
      launcherCommands({
        env: { PATH: '', TOKEN_OPTIMIZER_MANAGED_CLIENTS: 'amp, droid' },
      })
    ).toEqual(['droid', 'amp']);
  });
});
