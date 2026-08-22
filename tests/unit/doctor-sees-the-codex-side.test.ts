import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// @ts-expect-error -- hooks-core ships as plain ESM with no type declarations.
import { probeCodex } from '../../hooks-core/doctor.mjs';

/**
 * The doctor ships inside a package that eleven clients install, and could see
 * exactly one of them: Claude Code.
 *
 * Issue #307 is a Codex user, and their report contained the two facts this
 * check exists to state. Their server was declared TWICE -- once by the enabled
 * plugin's .mcp.json, once by a hand-merged [mcp_servers.token-optimizer] block
 * -- and the config.toml declaration carried no startup timeout, so Codex
 * applied its documented default of 10 seconds to a cold start that does not
 * fit inside it (learn.chatgpt.com/docs/extend/mcp: "startup_timeout_sec --
 * Timeout (seconds) for the server to start. Default: 10").
 *
 * A server killed mid-handshake is reported by the client as a server that
 * registered no tools, which is the headline of the issue.
 */

/**
 * Codex keys a plugin `<name>@<marketplace>`. The reporter's machine said
 * `token-optimizer@token-optimizer`; the machine this was written on says
 * `token-optimizer@personal`. Only the name is ours to assume, so both spellings
 * are exercised below.
 */
const PLUGIN_ID = 'token-optimizer@token-optimizer';

let fixture: string;

/** A ~/.codex directory whose config.toml is exactly what we say it is. */
function givenCodexConfig(body: string): string {
  const home = join(fixture, '.codex');
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, 'config.toml'), body);
  return home;
}

const named = (checks: Array<{ name: string }>, name: string) =>
  checks.find((check) => check.name === name);

const SERVER_BLOCK = `
[mcp_servers.token-optimizer]
command = "npx"
args = ["-y", "@ooples/token-optimizer-mcp@latest"]
`;

const PLUGIN_BLOCK = `
[plugins."${PLUGIN_ID}"]
enabled = true
`;

beforeEach(() => {
  fixture = mkdtempSync(join(tmpdir(), 'doctor-codex-'));
});

afterEach(() => {
  rmSync(fixture, { recursive: true, force: true });
});

describe('when Codex is not installed', () => {
  it('says nothing at all, because reporting on absent software is noise', () => {
    expect(probeCodex({ codexHome: join(fixture, 'no-such-codex') })).toEqual([]);
  });
});

describe('the duplicate declaration the reporter had', () => {
  it('flags a server declared by both the plugin and config.toml', () => {
    const codexHome = givenCodexConfig(PLUGIN_BLOCK + SERVER_BLOCK);

    const check = named(probeCodex({ codexHome }), 'codex declares this server once');

    expect(check.pass).toBe(false);
    expect(check.detail).toContain('declared twice');
    expect(check.remedy).toContain('codex mcp remove token-optimizer');
  });

  it('is content with the plugin alone', () => {
    const codexHome = givenCodexConfig(PLUGIN_BLOCK);

    const check = named(probeCodex({ codexHome }), 'codex declares this server once');

    expect(check.pass).toBe(true);
    expect(check.detail).toContain('plugin');
  });

  it('is content with the config.toml block alone', () => {
    const codexHome = givenCodexConfig(SERVER_BLOCK);

    const check = named(probeCodex({ codexHome }), 'codex declares this server once');

    expect(check.pass).toBe(true);
  });

  it('finds the plugin whatever marketplace it was installed from', () => {
    // Live config on the machine this was written on: `@personal`, not
    // `@token-optimizer`. Matching the full id would have made this check
    // silently blind to a real, enabled plugin.
    const codexHome = givenCodexConfig(
      '[plugins."token-optimizer@personal"]\nenabled = true\n' + SERVER_BLOCK
    );

    const check = named(probeCodex({ codexHome }), 'codex declares this server once');

    expect(check.pass).toBe(false);
    expect(check.detail).toContain('token-optimizer@personal');
  });

  it('does not count a plugin that is present but disabled', () => {
    const codexHome = givenCodexConfig(
      `[plugins."${PLUGIN_ID}"]\nenabled = false\n` + SERVER_BLOCK
    );

    const check = named(probeCodex({ codexHome }), 'codex declares this server once');

    expect(check.pass).toBe(true);
  });

  it('says so plainly when Codex is installed but this server is not configured', () => {
    const codexHome = givenCodexConfig('[mcp_servers.something-else]\ncommand = "node"\n');

    const check = named(probeCodex({ codexHome }), 'codex knows about this server');

    expect(check.pass).toBe(true);
    expect(check.detail).toContain('not installed for Codex');
  });
});

describe('the startup budget Codex will actually apply', () => {
  it('fails a config.toml block with no startup_timeout_sec on it', () => {
    const codexHome = givenCodexConfig(SERVER_BLOCK);

    const check = named(probeCodex({ codexHome }), 'codex allows enough time to start');

    expect(check.pass).toBe(false);
    expect(check.detail).toContain('default of 10s');
    expect(check.remedy).toContain('startup_timeout_sec = 30');
  });

  it('passes when a budget is set, and reports the number', () => {
    const codexHome = givenCodexConfig(`${SERVER_BLOCK}startup_timeout_sec = 30\n`);

    const check = named(probeCodex({ codexHome }), 'codex allows enough time to start');

    expect(check.pass).toBe(true);
    expect(check.detail).toContain('30');
  });

  it('does not demand a timeout from a plugin-only install, which ships its own', () => {
    const codexHome = givenCodexConfig(PLUGIN_BLOCK);

    expect(named(probeCodex({ codexHome }), 'codex allows enough time to start')).toBeUndefined();
  });
});

describe('reading the table', () => {
  it('recognises the quoted spelling of the same table', () => {
    // TOML permits [mcp_servers."token-optimizer"] for the identical table.
    const codexHome = givenCodexConfig(
      '[mcp_servers."token-optimizer"]\ncommand = "npx"\nstartup_timeout_sec = 30\n'
    );

    const check = named(probeCodex({ codexHome }), 'codex allows enough time to start');

    expect(check?.pass).toBe(true);
  });

  it('stops at the next table, so a later server\'s timeout is not borrowed', () => {
    // The bug this guards: scanning the whole file would find the timeout
    // belonging to a DIFFERENT server and report ours as configured.
    const codexHome = givenCodexConfig(
      `${SERVER_BLOCK}\n[mcp_servers.other]\nstartup_timeout_sec = 30\n`
    );

    const check = named(probeCodex({ codexHome }), 'codex allows enough time to start');

    expect(check.pass).toBe(false);
  });

  it('ignores a table whose name merely starts the same way', () => {
    const codexHome = givenCodexConfig(
      '[mcp_servers.token-optimizer-fork]\ncommand = "npx"\n'
    );

    const check = named(probeCodex({ codexHome }), 'codex knows about this server');

    expect(check.pass).toBe(true);
    expect(check.detail).toContain('not installed for Codex');
  });
});
