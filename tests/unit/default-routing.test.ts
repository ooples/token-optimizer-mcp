/**
 * Writing to a file the user owns.
 *
 * This is the only mechanism here that changes configuration outside our own directory, and the
 * failure it can cause is total: a settings file naming a dead port leaves Claude Code unable to
 * reach Anthropic at all. So these tests are about the guarantees that make it safe to switch on --
 * never written unless the route was really served, always removable back to exactly what was there,
 * and removed by the same code path the moment the route cannot be served again.
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
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
import {
  applyDefaultRouting,
  removeDefaultRouting,
  readRoutingManifest,
  claudeSettingsFile,
  defaultRoutingAllowed,
} from '../../src/proxy/default-routing.js';

let home;
let settings;
let env;
const served = 'http://127.0.0.1:45712';
const route = async () => served;
const unavailable = async () => null;

const read = () => JSON.parse(readFileSync(settings, 'utf8'));
const write = (value) => {
  mkdirSync(join(home, '.claude'), { recursive: true });
  writeFileSync(settings, JSON.stringify(value, null, 2));
};

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'default-routing-'));
  settings = join(home, '.claude', 'settings.json');
  env = {
    TOKEN_OPTIMIZER_HOME: join(home, '.token-optimizer'),
    TOKEN_OPTIMIZER_SETTINGS: settings,
  };
});

afterEach(() => rmSync(home, { recursive: true, force: true }));

describe('routing a client we did not launch', () => {
  it('points Claude Code at the route and leaves the rest of the file alone', async () => {
    write({
      model: 'opus',
      env: { SOMETHING_ELSE: 'kept' },
      hooks: { SessionStart: [] },
    });
    const result = await applyDefaultRouting(route, env);
    expect(result.status).toBe('written');
    const after = read();
    expect(after.env.ANTHROPIC_BASE_URL).toBe(served);
    expect(after.env.SOMETHING_ELSE).toBe('kept');
    expect(after.model).toBe('opus');
    expect(after.hooks).toEqual({ SessionStart: [] });
  });

  it('writes nothing when the route could not be served', async () => {
    // The whole hazard in one case: an entry written on hope names a port nothing is listening on.
    write({ model: 'opus' });
    expect((await applyDefaultRouting(unavailable, env)).status).toBe(
      'unavailable'
    );
    expect(read()).toEqual({ model: 'opus' });
    expect(readRoutingManifest(env).entries).toEqual({});
  });

  it('removes its own entry as soon as the route stops being servable', async () => {
    // SELF-HEALING. Session start calls this again, so a supervisor that cannot come back takes the
    // entry out with it and the next session reaches the provider directly.
    write({});
    await applyDefaultRouting(route, env);
    expect(read().env.ANTHROPIC_BASE_URL).toBe(served);
    const healed = await applyDefaultRouting(unavailable, env);
    expect(healed.status).toBe('healed');
    expect(read().env?.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(readRoutingManifest(env).entries).toEqual({});
  });

  it('inserts itself in front of the endpoint the user already chose, and restores it exactly', async () => {
    write({ env: { ANTHROPIC_BASE_URL: 'https://gateway.corp.example' } });
    const result = await applyDefaultRouting(route, env);
    expect(result.upstream).toBe('https://gateway.corp.example');
    expect(read().env.ANTHROPIC_BASE_URL).toBe(served);
    expect(removeDefaultRouting(env).status).toBe('removed');
    expect(read().env.ANTHROPIC_BASE_URL).toBe('https://gateway.corp.example');
  });

  it('does not re-record its own route as the endpoint to restore', async () => {
    // The bug this guards: deriving "previous" again on the second pass would record the loopback
    // route, and removal would then restore a URL that stops working the moment we shut down.
    write({ env: { ANTHROPIC_BASE_URL: 'https://gateway.corp.example' } });
    await applyDefaultRouting(route, env);
    await applyDefaultRouting(route, env);
    expect(
      readRoutingManifest(env).entries[claudeSettingsFile(env)].previous
    ).toBe('https://gateway.corp.example');
    removeDefaultRouting(env);
    expect(read().env.ANTHROPIC_BASE_URL).toBe('https://gateway.corp.example');
  });

  it('leaves the variable behind entirely when there was nothing there before', async () => {
    write({ model: 'opus' });
    await applyDefaultRouting(route, env);
    removeDefaultRouting(env);
    expect(read()).toEqual({ model: 'opus' });
  });

  it('keeps an empty env object the user already had', async () => {
    // Found on a real machine: the settings file had `"env": {}`, we added our variable, the route
    // later became unservable, and tidying away the now-empty object removed a key the user wrote.
    // Removal has to return the file to what it was, or the record is not worth anything.
    write({ model: 'opus', env: {} });
    await applyDefaultRouting(route, env);
    removeDefaultRouting(env);
    expect(read()).toEqual({ model: 'opus', env: {} });
  });

  it('will not touch a client already pointed at somebody else’s local proxy', async () => {
    // Replacing it would silently take that tool out of the path, and forwarding to it could as
    // easily be forwarding to ourselves.
    const original = { env: { ANTHROPIC_BASE_URL: 'http://localhost:8080' } };
    write(original);
    expect((await applyDefaultRouting(route, env)).status).toBe(
      'foreign-proxy'
    );
    expect(read()).toEqual(original);
  });

  it('gives the value back to the user the moment they change it', async () => {
    write({});
    await applyDefaultRouting(route, env);
    const mine = {
      env: { ANTHROPIC_BASE_URL: 'https://my-own-choice.example' },
    };
    write(mine);
    expect(removeDefaultRouting(env).status).toBe('user-owned');
    expect(read()).toEqual(mine);
    expect(readRoutingManifest(env).entries).toEqual({});
  });

  it('refuses a settings file it cannot parse rather than replacing it', async () => {
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(settings, '{ this is not json');
    expect((await applyDefaultRouting(route, env)).status).toBe('unreadable');
    expect(readFileSync(settings, 'utf8')).toBe('{ this is not json');
  });

  it('does nothing at all when Claude Code is not installed', async () => {
    expect((await applyDefaultRouting(route, env)).status).toBe('no-client');
    expect(existsSync(settings)).toBe(false);
  });

  it('undoes itself when it is switched off, rather than only stopping', async () => {
    write({});
    await applyDefaultRouting(route, env);
    const off = { ...env, TOKEN_OPTIMIZER_DEFAULT_ROUTING: '0' };
    expect(defaultRoutingAllowed(off)).toBe(false);
    expect((await applyDefaultRouting(route, off)).status).toBe('removed');
    expect(read().env?.ANTHROPIC_BASE_URL).toBeUndefined();
  });

  it('is off when the product is off, and when request compression is off', () => {
    expect(defaultRoutingAllowed({ ...env, TOKEN_OPTIMIZER_MODE: 'off' })).toBe(
      false
    );
    expect(defaultRoutingAllowed({ ...env, TOKEN_OPTIMIZER_PROXY: '0' })).toBe(
      false
    );
    expect(defaultRoutingAllowed(env)).toBe(true);
  });

  it('keeps a backup of the file it changed', async () => {
    write({ model: 'opus' });
    await applyDefaultRouting(route, env);
    expect(JSON.parse(readFileSync(`${settings}.backup`, 'utf8'))).toEqual({
      model: 'opus',
    });
  });
});

describe('the route keeps Claude Code\u2019s own tool deferral on', () => {
  /*
   * WHY THIS IS PART OF ROUTING AT ALL. Pointed at any non-Anthropic base URL, Claude Code stops
   * deferring its tool schemas and sends every one inline. Schemas are roughly half a real
   * request, so installing the route costs that on every turn before compression does anything,
   * and the client had been doing the deferral for free. The launcher path already preserved it;
   * this is the settings path, which is how most installs are routed.
   */
  it('sets the flag alongside the route', async () => {
    write({ model: 'opus' });
    await applyDefaultRouting(route, env);
    expect(read().env.ENABLE_TOOL_SEARCH).toBe('true');
  });

  it('takes it back out with the route', async () => {
    write({ model: 'opus' });
    await applyDefaultRouting(route, env);
    // Present first, or the assertions below pass on a flag that was never written.
    expect(read().env.ENABLE_TOOL_SEARCH).toBe('true');

    removeDefaultRouting(env);
    const after = read();
    expect(after.env?.ENABLE_TOOL_SEARCH).toBeUndefined();
    expect(after.env?.ANTHROPIC_BASE_URL).toBeUndefined();
  });

  it('never overrides a value the user already set', async () => {
    write({ env: { ENABLE_TOOL_SEARCH: 'false' } });
    await applyDefaultRouting(route, env);
    expect(read().env.ENABLE_TOOL_SEARCH).toBe('false');

    // And removal must not take away what it did not add.
    removeDefaultRouting(env);
    expect(read().env.ENABLE_TOOL_SEARCH).toBe('false');
  });

  it('leaves a value adopted after we wrote it', async () => {
    write({ model: 'opus' });
    await applyDefaultRouting(route, env);
    const settled = read();
    expect(settled.env.ENABLE_TOOL_SEARCH).toBe('true');
    settled.env.ENABLE_TOOL_SEARCH = 'auto';
    write(settled);

    // We added it, but it is no longer what we wrote, so the edit stands.
    removeDefaultRouting(env);
    expect(read().env.ENABLE_TOOL_SEARCH).toBe('auto');
  });

  it('stays out of the way of a third-party backend', async () => {
    write({ env: { CLAUDE_CODE_USE_BEDROCK: '1' } });
    await applyDefaultRouting(route, env);
    expect(read().env.ENABLE_TOOL_SEARCH).toBeUndefined();
  });

  const moved = async () => 'http://127.0.0.1:45713';
  const owns = () =>
    readRoutingManifest(env).entries[claudeSettingsFile(env)].toolSearchAdded;

  it('still owns the flag after the route moves', async () => {
    write({ model: 'opus' });
    await applyDefaultRouting(route, env);
    expect(owns()).toBe(true);

    // THE SECOND PASS READS OUR OWN FLAG AS THE USER'S. "An explicit value is the user's" was
    // the only presence test there was, so a rewrite recorded `toolSearchAdded: false` while the
    // spread carried the flag forward -- and removal, which asks the manifest, then left our
    // value in a file we promise to restore exactly.
    await applyDefaultRouting(moved, env);
    expect(read().env.ENABLE_TOOL_SEARCH).toBe('true');
    expect(owns()).toBe(true);

    removeDefaultRouting(env);
    expect(read().env?.ENABLE_TOOL_SEARCH).toBeUndefined();
  });

  it('gives up the flag when the value changed between passes', async () => {
    write({ model: 'opus' });
    await applyDefaultRouting(route, env);
    const settled = read();
    settled.env.ENABLE_TOOL_SEARCH = 'auto';
    write(settled);

    // Carrying ownership forward must not mean carrying it over an edit.
    await applyDefaultRouting(moved, env);
    expect(read().env.ENABLE_TOOL_SEARCH).toBe('auto');
    expect(owns()).toBe(false);

    removeDefaultRouting(env);
    expect(read().env.ENABLE_TOOL_SEARCH).toBe('auto');
  });

  it('takes the flag back out when a backend arrives and the route has not moved', async () => {
    write({ model: 'opus' });
    await applyDefaultRouting(route, env);
    expect(read().env.ENABLE_TOOL_SEARCH).toBe('true');

    const settled = read();
    settled.env.CLAUDE_CODE_USE_BEDROCK = '1';
    write(settled);

    // NOTHING ELSE WOULD EVER CLEAR IT. Removal runs only when routing is switched off, and a
    // third-party backend does not switch routing off -- so without this the flag we wrote stays
    // asserted against a backend we said we would not touch, for as long as the install lasts.
    const result = await applyDefaultRouting(route, env);
    expect(result.status).toBe('unchanged');
    expect(read().env.ENABLE_TOOL_SEARCH).toBeUndefined();
    expect(read().env.ANTHROPIC_BASE_URL).toBe(served);
    expect(owns()).toBe(false);
  });

  it('takes the flag back out when a backend arrives and the route moves', async () => {
    write({ model: 'opus' });
    await applyDefaultRouting(route, env);
    const settled = read();
    settled.env.CLAUDE_CODE_USE_VERTEX = 'true';
    write(settled);

    await applyDefaultRouting(moved, env);
    expect(read().env.ENABLE_TOOL_SEARCH).toBeUndefined();
    expect(read().env.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:45713');
    expect(owns()).toBe(false);
  });

  it('leaves a user value alone when a backend arrives', async () => {
    // The clearing above is ours to do only because we wrote the value. A user who set it keeps
    // it, backend or no backend.
    write({ env: { ENABLE_TOOL_SEARCH: 'true' } });
    await applyDefaultRouting(route, env);
    expect(owns()).toBe(false);

    const settled = read();
    settled.env.CLAUDE_CODE_USE_BEDROCK = '1';
    write(settled);
    await applyDefaultRouting(moved, env);
    expect(read().env.ENABLE_TOOL_SEARCH).toBe('true');
  });

  it('leaves the file flag alone when our own launcher set the variable', async () => {
    // `scripts/run-client.mjs` puts ENABLE_TOOL_SEARCH in the environment of the Claude it
    // launches, so an MCP server running inside that child sees it set. That is someone already
    // asserting the flag, not a reason the flag is wrong -- and the settings entry is what serves
    // every other way the user starts Claude, so it has to survive the visit.
    write({ model: 'opus' });
    await applyDefaultRouting(route, env);
    expect(read().env.ENABLE_TOOL_SEARCH).toBe('true');

    const launched = { ...env, ENABLE_TOOL_SEARCH: 'true' };
    await applyDefaultRouting(moved, launched);
    expect(read().env.ENABLE_TOOL_SEARCH).toBe('true');
    expect(
      readRoutingManifest(launched).entries[claudeSettingsFile(launched)]
        .toolSearchAdded
    ).toBe(true);
  });

  it('still takes it back under the launcher when a backend arrives', async () => {
    // The gate above is about precedence, not about appropriateness: a third-party backend still
    // means our value is wrong, whoever else is also setting the variable.
    write({ model: 'opus' });
    await applyDefaultRouting(route, env);
    const settled = read();
    settled.env.CLAUDE_CODE_USE_VERTEX = 'true';
    write(settled);

    const launched = { ...env, ENABLE_TOOL_SEARCH: 'true' };
    await applyDefaultRouting(moved, launched);
    expect(read().env.ENABLE_TOOL_SEARCH).toBeUndefined();
  });
});
