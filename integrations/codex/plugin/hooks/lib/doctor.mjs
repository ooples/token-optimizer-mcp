// GENERATED FILE -- do not edit.
// Source of truth: hooks-core/doctor.mjs. Regenerate with `npm run sync:hooks`.
/**
 * Does this installation actually work?
 *
 * The competing product's doctor is a checklist scored out of ten: files
 * present, JSON parses, server registered. THIS PROJECT ALREADY SHIPPED THE BUG
 * THAT DEFEATS THAT. Before #203 the plugin registered one advisory hook that
 * emitted a non-blocking tip; you could install it, see it connected in /mcp,
 * and save nothing at all. Every checklist item would have passed.
 *
 * So the checklist is the cheap half, and it is kept -- it catches the ordinary
 * breakages fast and can name a specific remedy for each. The half that matters
 * runs the thing: a synthetic payload is fed to the REAL hook binary and the
 * refusal has to come back out. A doctor that inspects configuration can tell
 * you the plumbing is connected. Only a doctor that opens the tap can tell you
 * water comes out.
 *
 * Every check returns a remedy on failure. A diagnosis without a next step is a
 * complaint.
 */

import { entrypointOf, isOurs } from './wire.mjs';
import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  existsSync,
  readdirSync,
  statSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  mkdirSync,
} from 'node:fs';
import { request as httpRequest } from 'node:http';
import { connect } from 'node:net';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { harvestMode, harvestFailure } from './harvest.mjs';
import {
  proxyEnvFor,
  MANAGED_CLIENTS,
  clientForCommand,
  hookInstallFor,
} from './capabilities.mjs';
import { mode } from './policy.mjs';
import {
  readManifest,
  verifyManifest,
  residue,
  manifestSize,
} from './manifest.mjs';
import { mcpClientsSeen } from './metrics.mjs';

/**
 * Bytes as a person reads them.
 *
 * Local because it exists for one line of one check, and because the alternative
 * -- printing a raw byte count next to a file count -- is the kind of detail
 * that gets skimmed past rather than read.
 */
function describeBytes(bytes) {
  if (!bytes) return 'size unknown';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const ok = (name, detail) => ({ name, pass: true, detail });
const bad = (name, detail, remedy) => ({ name, pass: false, detail, remedy });
// A healthy install in a state the user must know about. It never fails the doctor (an
// opt-out is not a broken hook) and is never counted as a pass either.
const warn = (name, detail, remedy) => ({
  name,
  pass: true,
  warn: true,
  detail,
  remedy,
});

const PLUGIN_ID = 'token-optimizer@token-optimizer';

/**
 * The plugin's own name, without the marketplace it was installed from.
 *
 * Codex keys a plugin `<name>@<marketplace>` and the second half is wherever the
 * user added it from -- `token-optimizer@token-optimizer` on the machine in
 * #307, `token-optimizer@personal` on the one this was written on. Only the
 * first half is ours to assume.
 */
const PLUGIN_NAME = PLUGIN_ID.split('@')[0];

/**
 * The tightest startup budget any supported client gives a stdio MCP server
 * before killing it.
 *
 * Codex: "startup_timeout_sec -- Timeout (seconds) for the server to start.
 * Default: 10." (learn.chatgpt.com/docs/extend/mcp, the Codex MCP config
 * reference). That is the shortest of the clients we ship configs for, so it is
 * the one worth warning against; a server slower than this is invisible to a
 * default Codex install no matter how healthy it is.
 */
const CLIENT_STARTUP_BUDGET_MS = 10_000;

/** Reads JSON, or null. Never throws: this module must diagnose, not crash. */
function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

/** Numeric semver compare; unparseable versions sort as equal to avoid crying wolf. */
function compareVersions(a, b) {
  const parse = (v) =>
    String(v || '')
      .split('.')
      .map((n) => Number.parseInt(n, 10));
  const left = parse(a);
  const right = parse(b);
  if (left.some(Number.isNaN) || right.some(Number.isNaN)) return 0;
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  return 0;
}

/**
 * WHICH INSTALL IS THIS, AND WHERE ARE THE HOOKS IT ACTUALLY RUNS?
 *
 * Everything below used to assume the script-install path: hooks copied into
 * ~/.claude-global/hooks, entries written into settings.json, a manifest
 * recording both. The plugin path satisfies none of that. Its hooks are declared
 * in the plugin's own hooks.json and live in the plugin cache, so a doctor
 * looking in settings.json reports "not wired" about a plugin that is wired, and
 * reports "no manifest" about a file that path never writes.
 *
 * It also resolved the hook binary from the npm package root, which is a
 * DIFFERENT BUILD from the plugin's. Measured on a real machine: the package
 * shipped 5.3.5 and the plugin cache held 5.3.6, with all 37 hook files
 * differing. The enforcement probe passed -- for a build that was not running.
 *
 * Returns the versions separately rather than a boolean, because "installed is
 * behind available" is the single most useful thing this tool can say: 5.0.2
 * shipped one advisory hook, so a stale install is present, listed in /mcp, and
 * saving nothing.
 */
export function detectInstall({
  pluginsDir,
  root,
  client,
  codexHome,
  cwd,
} = {}) {
  // DIAGNOSE THE INSTALL THAT IS ASKING. Everything below reads Claude Code's registry, which
  // is the right answer for Claude Code and the wrong one for every other client on the machine.
  if (client === 'codex') {
    const codex = detectCodexInstall({ codexHome, root });
    if (codex) return codex;
  }

  const dir = pluginsDir || join(homedir(), '.claude', 'plugins');
  const packageHooks = join(root || '.', 'plugin', 'hooks');

  const record = readJson(join(dir, 'installed_plugins.json'))?.plugins?.[
    PLUGIN_ID
  ]?.[0];
  const marketplace = readJson(
    join(
      dir,
      'marketplaces',
      'token-optimizer',
      'plugin',
      '.claude-plugin',
      'plugin.json'
    )
  );

  const installedVersion = record?.version ?? null;
  const availableVersion = marketplace?.version ?? null;
  // A STRING, OR NOTHING. installed_plugins.json is not written by us, and join() throws on a
  // truthy non-string -- which would end the whole report rather than describe one broken record.
  const installPath =
    typeof record?.installPath === 'string' && record.installPath.trim()
      ? record.installPath
      : null;
  const pluginHooks = installPath ? join(installPath, 'hooks') : null;

  // WHICH BUILD IS ACTUALLY BEING DIAGNOSED?
  //
  // `root` is this package -- the copy npx/npm resolved and whose dist/ the
  // server probe will run. It has a version of its own, and it is NOT
  // necessarily Claude Code's plugin cache. Issue #307 caught the consequence:
  // a user diagnosing the 5.7.0 npm package under Codex was told "plugin 5.5.0"
  // and "plugin is up to date", because the only version this function looked at
  // was a stale Claude Code record on the same machine. Read the package's own
  // version so every report can name the build it examined.
  const packageVersion =
    readJson(join(root || '.', 'package.json'))?.version ?? null;

  // Is the plugin record describing THIS tree, or another client's copy? Path
  // comparison, because a plugin install and an npm install can hold the same
  // version number and still be two different directories.
  const sameTree = Boolean(
    record?.installPath && root && resolve(record.installPath) === resolve(root)
  );

  // WHOSE RECORD IS THIS, THOUGH? installed_plugins.json is Claude Code's registry and nobody
  // else's, so a client we have positively identified as something other than Claude Code cannot
  // own what is in it. #408 is a Codex user told "install method: Claude Code plugin 6.0.0" while
  // Codex's own entry points went unexercised. That was fixed for a Codex install that EXISTS;
  // the same misreport still stood for Codex with no cache yet, and for the eight other managed
  // clients, none of which had a branch here. An unidentified client still falls through on
  // purpose: when we do not know who is asking, the machine's registered plugin is the best
  // answer there is.
  if (client && client !== 'claude-code') {
    // FIRST, THE CLIENT'S OWN HOOKS, WHERE THE REGISTRY SAYS THEY LAND. Refusing the Claude
    // record stops the lie; it does not supply a diagnosis. CLIENT_HOOK_INSTALLS carries the
    // destination each integration documents, so the probes below can run THIS client's entry
    // points -- which is the whole point of a doctor that opens the tap instead of reading config.
    const own = detectClientHooks({ client, cwd });
    if (own)
      return {
        method: client + ' hooks',
        foreign: true,
        packageVersion,
        sameTree: false,
        hooksDir: own.dir,
        installPath: own.dir,
        // NO VERSION. Hooks are copied files with no stamp on them; claiming a number here would
        // be the same fabrication as reporting Claude's, one indirection later.
        installedVersion: null,
        availableVersion: null,
        entries: own.entries,
      };

    // Otherwise say so, and say nothing more. The Claude record is not discarded: returning
    // anything but `plugin` is what makes diagnose() re-read it as `crossClient`, where it is
    // reported as another client's state rather than as this one's.
    return {
      method: verifyManifest(readManifest()) ? 'script' : 'unknown',
      foreign: true,
      packageVersion,
      sameTree: false,
      hooksDir: packageHooks,
      installPath: null,
      // NULL, NOT CLAUDE'S NUMBERS. Reporting them here is the misattribution itself: the
      // checklist would compare this package against a version belonging to a different client.
      installedVersion: null,
      availableVersion: null,
    };
  }

  // A record whose installPath has gone missing is a broken plugin install, not
  // a script install -- saying "script" there would send the user to the wrong
  // remedy entirely.
  if (record) {
    return {
      method: 'plugin',
      packageVersion,
      sameTree,
      // AND IT MUST NOT FALL BACK TO THE PACKAGE COPY. plugin/hooks ships with
      // every npm install (it is in package.json `files`), so substituting it
      // here makes the checklist and the enforcement probe pass against a build
      // Claude Code is not loading -- it loads from installPath, which is gone.
      // The header records this exact defect as already fixed once: "The
      // enforcement probe passed -- for a build that was not running." Point at
      // where the hooks are supposed to be and let the checks fail loudly.
      hooksDir: pluginHooks ?? packageHooks,
      installPath: record.installPath ?? null,
      installedVersion,
      availableVersion,
    };
  }

  return {
    method: verifyManifest(readManifest()) ? 'script' : 'unknown',
    packageVersion,
    sameTree: false,
    hooksDir: packageHooks,
    installPath: null,
    installedVersion,
    availableVersion,
  };
}

/**
 * The hook entry files an install actually ships.
 * NAMED BY THE INSTALL ITSELF WHERE IT KNOWS THEM. A client detected through
 * CLIENT_HOOK_INSTALLS carries its own entry filenames, which is what lets Cline -- whose
 * wrappers are extensionless and named after the event -- be checked at all.
 *
 * Claude Code loads a single PreToolUse router; the Codex plugin ships one file per event. The
 * checklist and both spawning probes used to name the Claude files unconditionally, so pointing
 * them at a Codex install would have reported its present, working hooks as missing.
 */
export function entriesFor(install) {
  if (install?.entries) return install.entries;
  return install?.method === 'codex plugin'
    ? { preTool: 'pre-tool.mjs', sessionStart: 'session-start.mjs' }
    : { preTool: 'pretooluse-router.mjs', sessionStart: 'session-start.mjs' };
}

/**
 * This client's hooks, if they are where its integration says they are installed.
 *
 * EVERY ENTRY, NOT ANY. A directory holding some of our files is a half-copied install, and
 * reporting that as installed is exactly how a broken install passes for a working one -- the
 * failure this whole module exists to catch.
 */
function detectClientHooks({ client, cwd, home }) {
  const entry = hookInstallFor(client);
  if (!entry?.dir) return null;
  const base = entry.base === 'home' ? home || homedir() : cwd || process.cwd();
  const dir = join(base, ...entry.dir.split('/'));
  const names = Object.values(entry.entries || {});
  if (!names.length || !names.every((name) => existsSync(join(dir, name))))
    return null;
  return { dir, entries: entry.entries };
}
/** Directory entries of `dir`, or [] -- this module must diagnose, not crash. */
function subdirectories(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

/**
 * THE CODEX PLUGIN INSTALL, WHEN CODEX IS THE CLIENT ASKING.
 *
 * detectInstall reads ~/.claude/plugins, which is Claude Code's registry and nobody else's. Run
 * from a Codex session it therefore reported on whatever Claude Code happened to have on the
 * same machine -- #408 is a user told `install method: Claude Code plugin 6.0.0` while asking
 * from Codex 7.1.0, whose own entry points were never exercised at all.
 *
 * Codex keeps its plugins at ~/.codex/plugins/cache/<marketplace>/<name>/<version>/, so the
 * marketplace half is whatever the user added it from and cannot be pinned. The highest version
 * carrying a readable .codex-plugin/plugin.json wins, which is the one Codex loads.
 */
export function detectCodexInstall({ codexHome, root } = {}) {
  const cache = join(
    codexHome || join(homedir(), '.codex'),
    'plugins',
    'cache'
  );
  let best = null;
  for (const marketplace of subdirectories(cache)) {
    const pluginRoot = join(cache, marketplace, PLUGIN_NAME);
    for (const version of subdirectories(pluginRoot)) {
      const installPath = join(pluginRoot, version);
      const manifest = readJson(
        join(installPath, '.codex-plugin', 'plugin.json')
      );
      if (!manifest) continue;
      const installedVersion = manifest.version || version;
      if (best && compareVersions(installedVersion, best.installedVersion) <= 0)
        continue;
      best = { installPath, installedVersion };
    }
  }
  if (!best) return null;

  const packageVersion =
    readJson(join(root || '.', 'package.json'))?.version ?? null;
  return {
    method: 'codex plugin',
    // NOT CLAUDE CODE'S. See checklist(): Claude's settings.json and the install-hooks
    // manifest are evidence about a Claude install and about nothing else.
    foreign: true,
    packageVersion,
    // The Codex cache is never this package's own tree: it is a copy Codex unpacked for itself.
    sameTree: false,
    hooksDir: join(best.installPath, 'hooks'),
    installPath: best.installPath,
    installedVersion: best.installedVersion,
    // Codex publishes no marketplace manifest beside the cache, so there is no newer version to
    // compare against. Claiming one would be inventing it.
    availableVersion: null,
  };
}

/** Resolves the directory holding the hook entrypoints for a probe. */
function hooksDirFor({ hooksDir, install, root }) {
  return hooksDir || install?.hooksDir || join(root || '.', 'plugin', 'hooks');
}

/**
 * Is the installed plugin the version that is available?
 *
 * The gap this closes: updating the marketplace does NOT update the installed
 * plugin. `installed_plugins.json` pins installPath and version, so a machine
 * can sit on 5.0.2 indefinitely while 5.3.6 is checked out beside it, and
 * nothing anywhere says so. Restarting does not help, because the restart
 * faithfully reloads the pinned version.
 */
/**
 * Is the half that LEARNS actually running?
 *
 * Everything else here checks that reads are being optimised. None of it
 * notices when finding-extraction is off, and the two failure modes look
 * identical from outside: a graph that fills with structural nodes either way.
 *
 * Measured on a real 5.4.0 install: 484 symbol, 286 file and 122 task nodes and
 * ZERO findings, because harvestMode() then returned an opt-in refusal (the mode has
 * since been renamed: it is 'off:no-key' now, and opting in is no longer the gate). Fifteen checks
 * passed and none mentioned harvest. stop-harvest.mjs names this exact gap --
 * "nothing in doctor, audit or waste mentions harvest, so a user sees a graph
 * filling with structural nodes and no findings and has no way to learn why" --
 * and then fixed only its own half, the once-per-session Stop notice. A
 * systemMessage at Stop is easy to miss; the doctor is where someone goes to ask.
 *
 * THE DEFAULT HAS SINCE BEEN JUDGED, and reversed. This used to say that requiring consent was
 * right and that only the invisibility was the defect. Measured again on a machine running this
 * for weeks: 340 read events in one project's graph, 48 in another, and ZERO findings, ZERO
 * harvests, ZERO injections in either. A default that nobody discovers is not a conservative
 * default, it is a dead feature -- and everything downstream of the harvest is inert without it.
 * The primary path is now model-driven: the active session is continued once at Stop and calls
 * wiki_write itself when it has a durable conclusion. The detached model harvest remains an
 * optional fallback. A missing credential can therefore disable only that fallback; it must not
 * make a healthy, private, zero-extra-model semantic path fail its doctor check.
 */
export function probeHarvest() {
  const mode = harvestMode();

  // The documented escape hatch. A harvest failure stacked on top of "the whole
  // optimizer is off" is noise, which is why stop-harvest maps it to no notice.
  if (mode === 'off:mode') return [];

  // SAID PLAINLY, because this is the configuration a user would choose if they
  // knew it existed and the previous wording buried it in machinery. A local
  // endpoint is the only setting under which the semantic harvest runs with no
  // credential, no billing and no digest leaving the machine -- so the two facts
  // that decide whether someone wants it are the two facts stated first.
  if (mode === 'local') {
    // WHY THE LAST ONE PRODUCED NOTHING, when it produced nothing.
    //
    // `extract` returns [] on every failure so a hook-path caller need not
    // care, which made a misconfigured endpoint indistinguishable from a
    // session with nothing to learn -- the exact reason a client speaking the
    // wrong dialect went unnoticed. `harvestFailure()` carries the reason, and
    // this is the reader it was added for.
    const reason = harvestFailure();
    if (reason) {
      return [
        bad(
          'finding extraction is configured but returned nothing',
          `the last harvest attempt ended: ${reason}`,
          'check the endpoint URL and, for an OpenAI-compatible server, that ' +
            'TOKEN_OPTIMIZER_HARVEST_MODEL names a model it actually serves'
        ),
      ];
    }
    return [
      ok(
        'finding extraction is available',
        'local model found -- semantic harvest is on, free and private: no credential, no billing, ' +
          'and nothing leaves this machine. Active-model wiki_write remains the primary path'
      ),
    ];
  }
  // The host client's own CLI, opted into with TOKEN_OPTIMIZER_HARVEST_CLI.
  // Reported with the same failure-reason read as `local`, because the two
  // share the property that made a broken configuration invisible: they
  // return [] on failure and look exactly like a session with nothing to
  // learn.
  if (mode === 'host-cli') {
    const reason = harvestFailure();
    if (reason) {
      return [
        bad(
          'finding extraction is configured but returned nothing',
          `the last harvest attempt ended: ${reason}`,
          "check that this client's CLI is on PATH and signed in, or unset " +
            'TOKEN_OPTIMIZER_HARVEST_CLI to fall back to a configured endpoint'
        ),
      ];
    }
    return [
      ok(
        'finding extraction is available',
        "this client's own CLI runs the semantic harvest -- no separate credential and no " +
          'second vendor. Active-model wiki_write remains the primary path'
      ),
    ];
  }
  if (mode === 'remote') {
    return [
      ok(
        'finding extraction is available',
        'active-model wiki_write is primary; a credential also enables fallback extraction from ' +
          'the bounded digest. TOKEN_OPTIMIZER_HARVEST=0 turns only that fallback off'
      ),
    ];
  }

  // No second-model credential is required for the primary path. The Codex/agent session that
  // already paid to derive the conclusion is the extractor and wiki_write is local.
  // NAME THE TRADE, not just the missing variable. This is the default state on
  // every machine without a credential, so it is the text most users will read,
  // and "unavailable" alone tells them neither what they are missing nor that
  // the free option exists. Local findings still accumulate: derive.mjs reads
  // exit codes, red-to-green transitions, corrections and churn out of evidence
  // already on disk and sends nothing anywhere.
  if (mode === 'off:no-key') {
    return [
      ok(
        'finding extraction is available',
        'active model records durable conclusions through local wiki_write, and derive runs at ' +
          'session end with no credential. No separate-model credential is configured, so fallback ' +
          'transcript extraction is unavailable: point TOKEN_OPTIMIZER_HARVEST_ENDPOINT at a local ' +
          'model to run it free and private, or set TOKEN_OPTIMIZER_API_KEY to run it from a bounded ' +
          'digest of paths, commands, prompts and conclusions -- never file contents'
      ),
    ];
  }

  // off:opted-out -- a deliberate choice, reported as one. Nagging about a setting somebody chose
  // is how a diagnostic gets ignored, and the point of this check is that it is worth reading.
  return [
    ok(
      'finding extraction is available',
      'active-model wiki_write remains available; separate-model fallback extraction is off by ' +
        'your choice (TOKEN_OPTIMIZER_HARVEST is set to a false value)'
    ),
  ];
}

/**
 * Is the compression proxy on, and can the client actually reach it?
 *
 * REPORTED BECAUSE IT IS INVISIBLE OTHERWISE. The proxy is opt-in, and the
 * failure that matters is silent: the variable is set but the client was
 * never pointed at it, so traffic goes straight to the provider and the user
 * sees no savings and no error. Naming both halves -- enabled, and actually
 * routed -- is the whole point of the check.
 */
/**
 * Does this base URL actually point at this machine?
 *
 * PARSED, NOT PREFIX-MATCHED, and the difference is a real hole rather than a
 * style preference. The prefix test this replaces accepted
 * `http://localhost.attacker.example` -- a registrable domain that merely
 * STARTS with `localhost` -- and `http://localhost@attacker.example`, where
 * everything before the `@` is userinfo and the host is the attacker. In both
 * cases the diagnostic reported that traffic was safely routed through a local
 * proxy while it was in fact being sent to someone else, with the user's
 * provider credentials attached.
 *
 * `new URL()` resolves userinfo, ports, IPv6 brackets and case for us, so the
 * check becomes what it always meant: an exact hostname, on a scheme we
 * understand.
 */
export function pointsAtLoopback(value) {
  if (!value) return false;
  let url;
  try {
    url = new URL(String(value));
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  // A URL with userinfo is never a plain loopback address, and accepting one is
  // precisely how the old check was fooled.
  if (url.username || url.password) return false;
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return (
    host === 'localhost' ||
    host === '::1' ||
    /^127[.]\d{1,3}[.]\d{1,3}[.]\d{1,3}$/.test(host)
  );
}

/**
 * Is the background proxy actually answering?
 *
 * ASKED, NOT READ. The supervisor records what it serves in a state file, and that file is exactly
 * what survives a process that was killed rather than signalled -- which on Windows is what
 * Task Manager and `Stop-Process` do. A report built from the file would describe routes that no
 * longer exist, which is the failure mode this whole diagnostic exists to catch.
 *
 * Spoken over plain http rather than through the compiled client, because this file is copied into
 * eleven client integrations that do not ship `dist/`.
 */
export async function probeSupervisor(
  env = process.env,
  { clientName, client: requested } = {}
) {
  if (
    String(env.TOKEN_OPTIMIZER_MODE || '')
      .trim()
      .toLowerCase() === 'off'
  )
    return [];
  if (/^(0|false|no|off)$/i.test(env.TOKEN_OPTIMIZER_PROXY?.trim() || ''))
    return [];

  const port = Number(
    // KEEP IN STEP WITH controlPort() IN src/proxy/supervisor.ts. Moved off 45710 because that
    // sat inside the range the kernel allocates outbound source ports from; the doctor probing
    // the old port would report a healthy supervisor as absent.
    (env.TOKEN_OPTIMIZER_PROXY_CONTROL_PORT || '').trim() || 16999
  );
  const health = await new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };
    let req;
    try {
      req = httpRequest(
        {
          host: '127.0.0.1',
          port,
          path: '/__token-optimizer/health',
          method: 'GET',
          timeout: 1500,
        },
        (res) => {
          const chunks = [];
          res.on('data', (chunk) => chunks.push(chunk));
          res.on('end', () => {
            try {
              done(
                res.statusCode === 200
                  ? JSON.parse(Buffer.concat(chunks).toString('utf8'))
                  : null
              );
            } catch {
              done(null);
            }
          });
        }
      );
    } catch {
      return done(null);
    }
    req.on('error', () => done(null));
    req.on('timeout', () => {
      req.destroy();
      done(null);
    });
    req.end();
  });

  const checks = [];
  if (health?.ok) {
    const routes = Array.isArray(health.routes) ? health.routes : [];
    checks.push(
      ok(
        'the background compression proxy is running',
        routes.length
          ? `serving ${routes.length} upstream${routes.length === 1 ? '' : 's'} on loopback: ` +
              routes
                .map((route) => `${route.upstream} via ${route.url}`)
                .join(', ')
          : 'running with no upstream routed yet; a route is created the first time a client asks ' +
              'for one'
      )
    );
  }

  // NOT RUNNING IS NOT ITSELF A FINDING. A session launched through token-optimizer-run carries its
  // own proxy and needs no daemon, and a client that is not routed at all is already reported by
  // probeProxy with the remedy. Saying it again here would add a standing warning to installs that
  // are working exactly as intended.
  //
  // WHAT IS A FINDING is a client pointed at a loopback port that nothing answers. probeProxy reads
  // that same variable and can only see that it LOOKS routed, so on its own it would report a
  // healthy install while the client cannot reach its provider at all -- the one failure this
  // feature can cause, and the only one a report built from our own state file would miss.
  const pointed =
    env[proxyEnvFor(clientFrom(env, clientName, requested)) || ''];
  if (pointsAtLoopback(pointed) && !(await portAnswers(pointed))) {
    checks.push(
      bad(
        'this client is routed at a port with nothing listening',
        `${pointed} is configured as this client's endpoint, but nothing accepted a connection ` +
          'there, so its model requests cannot reach the provider',
        'Run npx token-optimizer-install to restore the route, or npx token-optimizer-uninstall ' +
          '--apply to take the routing back out and talk to the provider directly.'
      )
    );
  }
  return checks;
}

/** Will anything accept a connection here? A refusal is an answer, not an error. */
function portAnswers(url) {
  return new Promise((resolve) => {
    let parsed;
    try {
      parsed = new URL(String(url));
    } catch {
      return resolve(false);
    }
    const socket = connect(
      {
        host: parsed.hostname.replace(/^\[|\]$/g, ''),
        port: Number(parsed.port) || 80,
      },
      () => {
        socket.destroy();
        resolve(true);
      }
    );
    socket.setTimeout(1500, () => {
      socket.destroy();
      resolve(false);
    });
    socket.on('error', () => resolve(false));
  });
}

/**
 * Which client this report is about.
 *
 * Shared with probeProxy so the two cannot disagree about whose variable they are reading -- a
 * disagreement would have one of them reporting on a client the other is not looking at.
 */
function clientFrom(env, clientName, explicit) {
  // AN EXPLICIT REQUEST OUTRANKS THE AMBIENT ONE. TOKEN_OPTIMIZER_CLIENT is set by whatever
  // launched this process, so it names the session -- not necessarily the install the user is
  // asking about. A caller who names a client in the tool call has already answered the question
  // the variable is a guess at, so the answer wins (#408).
  const asked = managedName(explicit);
  if (asked) return asked;
  return (
    String(env.TOKEN_OPTIMIZER_CLIENT || '')
      .trim()
      .toLowerCase() || managedName(clientName)
  );
}

/**
 * A reported name as the registry spells it, or '' when it names nothing we manage.
 *
 * NORMALISED, because read raw a whitespace-only value is truthy as a client name: proxyEnvFor(' ')
 * then finds nothing and the report says the client cannot be served -- about a client the MCP
 * handshake had already identified by name.
 */
function managedName(name) {
  const reported = String(name || '')
    .trim()
    .toLowerCase();
  return /^(codex|codex[_-](cli|mcp|desktop))$/.test(reported)
    ? 'codex'
    : /^(claude-code|claude)$/.test(reported)
      ? 'claude-code'
      : managedClientFor(reported);
}

/**
 * The managed client a reported handshake name refers to, or ''.
 *
 * READ FROM THE REGISTRY, NOT A SECOND HAND-KEPT LIST. Three names were spelled out here while
 * MANAGED_CLIENTS grew to ten, so a Gemini or Qwen session that did not set TOKEN_OPTIMIZER_CLIENT
 * resolved to no client at all and was reported as "routing is unverified" before its route was ever
 * examined. The registry also carries each client's command, which is how `cn` reaches Continue.
 */
function managedClientFor(reported) {
  if (!reported) return '';
  if (Object.hasOwn(MANAGED_CLIENTS, reported)) return reported;
  return clientForCommand(reported) || '';
}

/**
 * Have we already written this machine's routing, so an unrouted session is merely an old one?
 *
 * WHY THIS IS A WARNING AND NOT A FAILURE. The client reads its endpoint at startup, and the MCP
 * server writes that endpoint while starting. A session running when the route was first installed
 * therefore reports unrouted and is right to -- but nothing is broken, and the next start picks it
 * up. Reporting it as a failure would tell a correctly-installed user their install is broken, once,
 * for one session, which is exactly the false alarm this whole report exists to avoid.
 *
 * Read as a plain file rather than through the compiled module, because this file is copied into
 * eleven client integrations that do not ship `dist/`.
 */
function routingPending(env = process.env) {
  try {
    const home =
      env.TOKEN_OPTIMIZER_HOME || join(homedir(), '.token-optimizer');
    const manifest = JSON.parse(
      readFileSync(join(home, 'default-routing.json'), 'utf8')
    );
    if (manifest?.schema !== 1) return false;
    return Object.values(manifest.entries || {}).some((entry) =>
      pointsAtLoopback(entry?.value)
    );
  } catch {
    // No manifest, or one we cannot read, means nothing has been written for us to be waiting on.
    return false;
  }
}

export function probeProxy(
  env = process.env,
  { clientName, client: requested } = {}
) {
  // NORMALISED THE WAY THE RUNTIME NORMALISES IT. `policy.mode()` trims and
  // lowercases, so `OFF` and ` off ` genuinely turn the product off -- while a raw
  // comparison here read them as "on" and reported proxy failures against a
  // product that was not running. A diagnostic that disagrees with the runtime
  // about whether the runtime is enabled is worse than no diagnostic.
  const mode = String(env.TOKEN_OPTIMIZER_MODE || '')
    .trim()
    .toLowerCase();
  if (mode === 'off') return [];
  const on = !/^(0|false|no|off)$/i.test(
    env.TOKEN_OPTIMIZER_PROXY?.trim() || ''
  );
  if (!on) {
    return [
      ok(
        'request compression was explicitly disabled',
        'TOKEN_OPTIMIZER_PROXY opts out of request compression; remove it to restore the default'
      ),
    ];
  }

  const client = clientFrom(env, clientName, requested);
  if (!client)
    return [
      bad(
        'compression proxy routing is unverified',
        'The MCP client did not identify a supported client; MCP connectivity alone does not prove model routing.',
        'Run npx token-optimizer-install and restart the client, or launch a single session through ' +
          'token-optimizer-run <client> -- claude, codex, gemini, opencode, qwen, crush, droid, cn, ' +
          'copilot or amp.'
      ),
    ];
  const variable = proxyEnvFor(client);
  if (!variable) {
    // NOT A FAILURE, BECAUSE NOTHING THE USER DOES COULD MAKE IT PASS. Cursor, Cline, Windsurf,
    // Kilo, Roo and Zed run the assistant inside the editor process and expose no documented way to
    // redirect its model traffic. Reporting that as a failed check told six clients' users their
    // installation was broken when it was working exactly as designed, and left a real failure
    // indistinguishable from a property of their editor. It is stated, and it is not counted
    // against the install.
    return [
      warn(
        'the compression proxy cannot serve this client',
        client +
          ' routes model traffic through its editor process and exposes no supported way ' +
          'to redirect it, so request compression cannot apply here. Everything else -- the ' +
          'optimizer tools, the graph and the hooks -- still applies.',
        'nothing to fix. Use one of the command-line clients for request compression as well.'
      ),
    ];
  }

  const pointed = env[variable];
  const loopback = pointsAtLoopback(pointed);
  if (!loopback) {
    return [
      (routingPending(env) ? warn : bad)(
        routingPending(env)
          ? 'this session started before the route was configured'
          : 'the compression proxy is on but nothing is routed through it',
        variable +
          ' is ' +
          (pointed ? 'not a loopback URL' : 'not set') +
          ', so this client talks straight to the provider',
        // Routing is now installed rather than only launched, so the first remedy is the one that
        // survives the session: `token-optimizer-install` writes the client's own configuration,
        // and it takes effect the next time the client starts. Naming only the launcher sent every
        // user of a client we did not start away with nothing to do.
        'Run npx token-optimizer-install, then restart ' +
          client +
          ' so it picks up the routed endpoint. To route a single session instead, launch through ' +
          'token-optimizer-run ' +
          (client === 'claude-code' ? 'claude' : client) +
          '. Restarting the MCP server alone cannot reroute an existing session.'
      ),
    ];
  }

  return [
    ok(
      'request compression is available',
      'the compression proxy is enabled and ' +
        variable +
        ' points at loopback. ' +
        'Routing is configured; confirm model traffic in the managed launch ledger. The cached prefix is never rewritten.'
    ),
  ];
}

export function probeVersion({ install, crossClient } = {}) {
  const {
    method,
    installedVersion,
    availableVersion,
    packageVersion,
    sameTree,
  } = install || {};

  const checks = [];

  // ALWAYS NAME THE BUILD UNDER EXAMINATION, FIRST.
  //
  // Everything else in this report -- the server probe, the hook probes, the
  // file checks -- ran against the package at `root`. Reporting only a Claude
  // Code plugin version, discovered by scanning the home directory, told a
  // Codex user their 5.7.0 package was "5.5.0 and up to date" (#307). The two
  // numbers are both true and they are about different installs, so both are
  // printed and each says whose it is.
  if (packageVersion) {
    checks.push(
      ok(
        'package under examination',
        `@ooples/token-optimizer-mcp ${packageVersion}`
      )
    );
  }

  // ANOTHER CLIENT'S CACHE IS INFORMATION, NOT THIS CLIENT'S VERDICT.
  //
  // When the subject is a Codex install, a stale Claude Code cache on the same machine says
  // nothing about whether Codex's hooks work -- and #408 is a Codex user whose report FAILED on
  // exactly that, about a client they were not using. It is still worth saying, because two
  // clients on different builds is a real split-brain, so it is a warning that names whose it is.
  if (crossClient?.installedVersion && packageVersion) {
    checks.push(
      crossClient.installedVersion === packageVersion
        ? ok(
            'other clients agree with this package',
            `Claude Code plugin ${crossClient.installedVersion}; this package ${packageVersion}`
          )
        : warn(
            'other clients agree with this package',
            `the Claude Code plugin cache holds ${crossClient.installedVersion}, but this package ` +
              `is ${packageVersion}. This run diagnosed the ${method}, not that cache`,
            'run /plugin in Claude Code and update token-optimizer if you use it there too'
          )
    );
  }

  if (method !== 'plugin' || !installedVersion) {
    return checks;
  }

  // A Claude Code plugin record exists but points somewhere else: it belongs to
  // a different client than the one being diagnosed. Say so instead of silently
  // adopting its version, and flag it when it is behind -- a stale plugin cache
  // beside a fresh package is a real split-brain, and it is what the reporter
  // was looking at.
  if (!sameTree && packageVersion) {
    const label = 'other clients agree with this package';
    return checks.concat(
      installedVersion !== packageVersion
        ? [
            bad(
              label,
              `the Claude Code plugin cache holds ${installedVersion}, but this package is ${packageVersion}`,
              compareVersions(installedVersion, packageVersion) < 0
                ? 'this run diagnosed the package, not the plugin. Run /plugin in Claude Code and ' +
                    'update token-optimizer so both clients run the same build'
                : 'this run diagnosed the served runtime, not the plugin. Update the managed runtime ' +
                    'to the plugin version and restart the client. If npm does not yet carry that version, ' +
                    'the release publication must complete first; otherwise refresh the stale runtime.'
            ),
          ]
        : [
            ok(
              label,
              `Claude Code plugin ${installedVersion}; this package ${packageVersion}`
            ),
          ]
    );
  }

  if (!availableVersion) {
    return checks;
  }

  if (compareVersions(installedVersion, availableVersion) < 0) {
    return checks.concat([
      bad(
        'plugin is up to date',
        `installed ${installedVersion}, but ${availableVersion} is available`,
        'run /plugin and update token-optimizer -- updating the marketplace alone ' +
          'does not move the installed version, and older builds shipped far weaker hooks'
      ),
    ]);
  }

  return checks.concat([
    ok('plugin is up to date', `installed ${installedVersion}`),
  ]);
}

/**
 * Runs a hook binary with a payload and returns its stdout, or null.
 *
 * ASYNCHRONOUS BECAUSE EACH CALL IS A WHOLE NODE PROCESS. Measured on this
 * machine, one hook spawn costs ~118 ms, of which ~60 ms is bare Node startup
 * and ~52 ms is loading the 30-module hook graph -- almost none of it this
 * process's CPU. Run serially, the doctor's three probes simply added up:
 * 477 ms for the enforcement pair, 166 ms for session-start, and 1,490 ms for
 * the server probe, for 2,133 ms of a 2,137 ms diagnose. Waiting on them
 * concurrently costs the same CPU and a third of the wall clock.
 *
 * `execFileSync` also blocks the event loop for its entire duration, so while
 * one probe ran the server could not answer anything else -- the same defect
 * class `n/no-sync` exists to catch in src/.
 */
function probe(binary, payload, { timeoutMs = 8000, cwd, env } = {}) {
  return new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      [binary],
      {
        encoding: 'utf8',
        timeout: timeoutMs,
        cwd,
        env: {
          ...process.env,
          // THE PROBE MUST SUPPLY ITS OWN EVIDENCE. The bundled tool inventory is
          // now asserted only for an actual plugin install, which the runtime
          // marks with CLAUDE_PLUGIN_ROOT -- and the doctor is a CLI, run outside
          // that runtime, so it never has it. Without this the enforcement probe
          // would report "not refused" for a correctly installed plugin: a false
          // negative in the one tool whose job is to tell the user the truth.
          //
          // The question the probe asks is "would enforcement fire if the tools
          // were there", so it states that they are rather than inferring it.
          TOKEN_OPTIMIZER_MCP_CAPABILITIES:
            process.env.TOKEN_OPTIMIZER_MCP_CAPABILITIES ??
            'smart_read,smart_write,smart_edit,smart_glob,smart_grep',
          ...(env || {}),
        },
        windowsHide: true,
      },
      (error, stdout) => {
        // A hook that exits non-zero WITH OUTPUT still told us something. One
        // that timed out, was killed, or never spawned told us nothing -- and
        // null has to mean exactly that, because an empty string is a
        // legitimate "allowed".
        if (!error) return resolve(stdout);
        resolve(stdout || error?.stdout || null);
      }
    );
    // stderr is discarded exactly as the previous stdio:'ignore' did, but the
    // pipe must still be drained or a chatty hook can fill it and deadlock.
    child.stderr?.resume();
    // EPIPE IS EXPECTED HERE AND MUST NOT BE THROWN. A hook that exits before
    // reading its payload leaves nothing on the other end of the pipe, and the
    // write then emits an ASYNCHRONOUS error event on stdin -- which a
    // try/catch around .end() cannot catch, and which with no listener is an
    // unhandled error that takes down the doctor. execFileSync handled its
    // `input` internally, so this hazard arrived with the switch to execFile.
    // The child's own outcome is still reported by the callback above, so
    // swallowing this loses no diagnosis.
    child.stdin?.on('error', () => {});
    try {
      child.stdin.end(JSON.stringify(payload));
    } catch {
      // A spawn that already failed has no stdin; the callback reports it.
    }
  });
}

/* ------------------------------------------------------------- THE CHECKLIST */

/** Cheap structural checks. Fast, and each names its own fix. */
export function checklist({ root, settingsPath, install }) {
  const checks = [];
  const resolved = install || detectInstall({ root });
  const hooksDir = hooksDirFor({ install: resolved, root });

  // SAY WHICH PATH THIS IS. Skipping the script-install checks silently would
  // leave a user unable to tell whether they passed or were never run, which is
  // the same opacity that made a 7/9 score untrustworthy in the first place.
  // Name the client the hooks belong to, not just the method. "plugin 5.5.0"
  // beside a 5.7.0 package reads as a version regression in the thing you are
  // holding; "Claude Code plugin 5.5.0, hooks from <cache>" reads as what it is
  // -- another client's install, on the same machine (#307).
  const pluginLabel = resolved.sameTree ? 'plugin' : 'Claude Code plugin';
  const entries = entriesFor(resolved);
  checks.push(
    ok(
      'install method',
      resolved.method === 'plugin'
        ? `${pluginLabel}${resolved.installedVersion ? ` ${resolved.installedVersion}` : ''}` +
            ` -- hooks from ${hooksDir}`
        : `${resolved.method} -- hooks from ${hooksDir}`
    )
  );

  const router = join(hooksDir, entries.preTool);
  const sessionStart = join(hooksDir, entries.sessionStart);

  checks.push(
    existsSync(router)
      ? ok('hook binary present', router)
      : bad(
          'hook binary present',
          `not found at ${router}`,
          'reinstall the package, or run install-hooks.sh (install-hooks.ps1 on Windows)'
        )
  );

  checks.push(
    existsSync(sessionStart)
      ? ok('session-start binary present', sessionStart)
      : bad(
          'session-start binary present',
          `not found at ${sessionStart}`,
          'reinstall the package to restore the session-start hook'
        )
  );

  // SETTINGS AND MANIFEST ARE SCRIPT-INSTALL CONCERNS ONLY.
  //
  // A plugin declares its hooks in the plugin's own hooks.json and writes
  // nothing to settings.json, so demanding entries there reported "not wired"
  // about a plugin that was demonstrably wired -- its SessionStart hook was
  // injecting the policy at that very moment. Likewise the manifest: only
  // install-hooks.* writes one. Two guaranteed failures on a healthy install
  // taught the user to ignore the score.
  // AND A FOREIGN INSTALL IS NOT A SCRIPT INSTALL EITHER. settingsPath is Claude Code's
  // settings.json and the manifest is written only by install-hooks.*, so neither is evidence
  // about a Cursor, Codex or Copilot install. Asking anyway reproduces #408 one level down: a
  // Claude Code machine reports its own wiring as the caller's, and a machine without one fails
  // a check the caller could not have passed by any means.
  if (!resolved.foreign && resolved.method !== 'plugin') {
    if (settingsPath && existsSync(settingsPath)) {
      try {
        const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
        const wired = JSON.stringify(settings?.hooks || {}).includes(
          'token-optimizer'
        );
        checks.push(
          wired
            ? ok('hooks wired into settings', settingsPath)
            : bad(
                'hooks wired into settings',
                'no token-optimizer entries found',
                'run install-hooks.sh to add the PreToolUse and SessionStart entries'
              )
        );

        // WIRED IS NOT THE SAME AS WORKING. The check above is a substring test,
        // so an entry naming a script that no longer exists still reads as wired
        // while every invocation of it dies with MODULE_NOT_FOUND. That is not
        // hypothetical: an upgrade wired its own staging directory, the OS later
        // cleaned that directory up, and the Stop hook failed on every turn with
        // settings that looked perfectly healthy.
        //
        // This says nothing about WHERE a hook lives -- any folder the user chose
        // is legitimate -- only whether the file the command names is still there.
        // Keyed on OUR OWNERSHIP FLAG, not on wiredEntries(). Ownership additionally
        // requires a `token-optimizer` path SEGMENT, and the staging directory that
        // caused this ("optimizer upgrade <tmp>/new/plugin/hooks") has none -- so
        // the entry we most need to report would have been the one entry skipped.
        // The flag is written by us and by nobody else, which is the property that
        // matters here.
        const stale = [];
        for (const entries of Object.values(settings?.hooks || {})) {
          for (const entry of Array.isArray(entries) ? entries : []) {
            for (const hook of entry?.hooks || []) {
              const command = hook?.command || '';
              // OURS BY EITHER TEST, NOT JUST THE FLAG. Entries we wrote
              // before the flag existed carry no flag, so a flag-only
              // check skipped exactly the legacy hooks most likely to
              // point at a script that has since moved. isOurs applies
              // the flag test first and falls back to the path shape, so
              // an unrelated /workspace/token-optimizer/stop.mjs is still
              // not claimed.
              if (!isOurs({ hooks: [hook] })) continue;
              const script = entrypointOf(command);
              if (script && !existsSync(script)) stale.push(script);
            }
          }
        }
        checks.push(
          stale.length === 0
            ? ok('wired hooks resolve on disk', settingsPath)
            : bad(
                'wired hooks resolve on disk',
                `wired to ${stale.length === 1 ? 'a path that no longer exists' : `${stale.length} paths that no longer exist`}: ${stale.join(', ')}`,
                're-run the installer against the directory that holds the installed hooks'
              )
        );
      } catch {
        checks.push(
          bad(
            'settings file parses',
            `${settingsPath} is not valid JSON`,
            'fix the JSON by hand -- we will not rewrite a file we cannot parse'
          )
        );
      }
    } else {
      checks.push(
        bad(
          'settings file present',
          `${settingsPath || 'settings path unknown'} not found`,
          'run install-hooks.sh, or point TOKEN_OPTIMIZER_SETTINGS at your settings file'
        )
      );
    }

    // What we recorded putting on the machine, and whether it is still that.
    const manifest = readManifest();
    const verified = verifyManifest(manifest);
    if (verified) {
      // HOW MUCH, not just how many. manifestSize computed exactly this and had
      // no caller, so the one number that says what uninstall will actually
      // remove -- and the only cross-check on a manifest that lists files which
      // no longer exist, since a missing file contributes zero bytes -- was
      // computed nowhere and shown to no one.
      const footprint = describeBytes(manifestSize(manifest));
      // MISSING IS NOT INTACT, and branching on `modified` alone said it was.
      // verifyManifest reports three states and this read two of them: a
      // recorded file DELETED rather than edited left `modified === 0`, so a
      // half-removed install passed as healthy. The footprint above is what
      // makes it visible -- a missing file contributes zero bytes -- but a
      // visible detail beside a PASS is still a PASS.
      if (verified.missing > 0) {
        checks.push(
          bad(
            'installed files intact',
            `${verified.missing} of ${verified.files.length} recorded file(s) are gone (${footprint} still on disk)`,
            'reinstall the package to restore them, or run the uninstaller to clear the manifest'
          )
        );
      } else if (verified.modified === 0) {
        checks.push(
          ok(
            'installed files intact',
            `${verified.intact} file(s), ${footprint}, match the install manifest`
          )
        );
      } else {
        checks.push(
          ok(
            'installed files intact',
            `${verified.modified} of ${verified.intact + verified.modified} file(s) ` +
              `(${footprint} recorded) edited since install -- ` +
              'uninstall will leave those alone rather than destroy your changes'
          )
        );
      }
    } else {
      checks.push(
        bad(
          'install manifest present',
          'no record of what was installed',
          'harmless if you installed manually; reinstall to get a removable, verifiable record'
        )
      );
    }
  }

  return checks;
}

/* ---------------------------------------------------------------- THE PROBES */

/**
 * Runs the enforcement path for real.
 *
 * A large file must be refused and a small one allowed. Both directions matter:
 * a hook that refuses everything is as broken as one that refuses nothing, and
 * only the second is what shipped last time.
 */
export async function probeEnforcement({ root, workspace, hooksDir, install }) {
  const checks = [];
  // Probe the build that RUNS, not the one bundled beside this module. On a real
  // machine those were 5.3.5 and 5.3.6 with all 37 hook files differing, and
  // this probe passed for the copy nobody was executing.
  const binary = join(
    hooksDirFor({ hooksDir, install, root }),
    entriesFor(install).preTool
  );
  if (!existsSync(binary)) {
    return [
      bad(
        'enforcement refuses a large read',
        'hook binary missing',
        'reinstall the package'
      ),
    ];
  }

  mkdirSync(workspace, { recursive: true });
  // A FRESH SESSION AND FRESH FILENAMES PER RUN. The router remembers what a
  // session has already seen and degrades a repeat refusal to an advisory
  // (loop-breaking), and it refuses a file it has seen before (re-read
  // detection). With a fixed session id and fixed paths, the SECOND doctor run
  // on a machine therefore reported both probes as failures -- the product
  // behaving correctly, scored as broken. A doctor that cries wolf on its own
  // second run is worse than no doctor.
  const probeId = `doctor-${process.pid}-${randomBytes(4).toString('hex')}`;
  const big = join(workspace, `${probeId}-large.ts`);
  const small = join(workspace, `${probeId}-small.ts`);
  writeFileSync(big, 'export const x = 1;\n'.repeat(20_000));
  writeFileSync(small, 'export const y = 2;\n');

  try {
    // Do not inject capability evidence here. The shipped hook must establish
    // its bundled MCP contract by itself or this check would pass while real
    // Claude/Codex sessions continue to leave native large reads unrestricted.
    // THE TWO PROBES BELOW STAY SERIAL, DELIBERATELY. They share `probeId` as
    // their session id, and the router keeps per-session state on disk: what it
    // has already refused (loop-breaking) and which files it has already seen
    // (re-read detection). Running them concurrently would race two processes
    // on the same session file, and the failure would be intermittent and
    // wrong-looking rather than loud. The concurrency win is taken in
    // diagnose(), across probes that share no state.
    // ENFORCE IS ASKED FOR, NOT INHERITED -- for the same reason the capability
    // evidence in `probe` is stated rather than inferred. The question this probe
    // asks is "would enforcement fire if it were switched on", and policy.mjs#mode
    // now defaults to `assist`, which never refuses (THOL and ledger measurement).
    // Inheriting the default would make the probe report "not refused" on a
    // perfectly healthy install: a false negative in the one tool whose job is to
    // tell the user the truth.
    //
    // BOTH probes take it, not just the refusal one. "Small reads are left alone"
    // is evidence of something only under a posture that COULD have refused;
    // under assist it would pass against a hook that does nothing whatsoever,
    // which is precisely the broken install it exists to catch.
    const enforcing = { env: { TOKEN_OPTIMIZER_MODE: 'enforce' } };
    const denied = await probe(
      binary,
      {
        tool_name: 'Read',
        tool_input: { file_path: big },
        cwd: workspace,
        session_id: probeId,
      },
      enforcing
    );
    const deniedOk = typeof denied === 'string' && denied.includes('deny');
    checks.push(
      deniedOk
        ? ok(
            'enforcement refuses a large read',
            'the refusal came back from the real hook'
          )
        : bad(
            'enforcement refuses a large read',
            `hook returned: ${String(denied).slice(0, 200) || '(nothing)'}`,
            'the probe asks for enforce explicitly, so a failure is the hook itself rather than your mode -- reinstall the hooks'
          )
    );

    const allowed = await probe(
      binary,
      {
        tool_name: 'Read',
        tool_input: { file_path: small },
        cwd: workspace,
        session_id: probeId,
      },
      enforcing
    );
    // `allowed === null` is "the probe never ran", NOT "the hook allowed it".
    // allow() writes nothing and exits 0, so '' is a legitimate allow -- but null
    // is a spawn failure, an EPERM, or a timeout, and reporting a pass there is a
    // green tick produced by an absent measurement. A hook that hangs on every
    // small read is a catastrophic install, and this check used to call it fine.
    const allowedOk = allowed !== null && !allowed.includes('deny');
    checks.push(
      allowedOk
        ? ok('small reads are left alone', 'no refusal, as intended')
        : bad(
            'small reads are left alone',
            allowed === null
              ? 'the hook produced no result at all -- it crashed, hung past the timeout, or could not be spawned'
              : 'the hook refused a tiny file',
            'a hook that refuses everything, or answers nothing, is as broken as one that refuses nothing -- report this'
          )
    );
  } finally {
    for (const path of [big, small]) {
      try {
        unlinkSync(path);
      } catch {
        /* best effort */
      }
    }
  }

  return checks;
}

/** The session-start notice has to actually come out. */
export async function probeSessionStart({
  root,
  workspace,
  hooksDir,
  install,
}) {
  const binary = join(
    hooksDirFor({ hooksDir, install, root }),
    entriesFor(install).sessionStart
  );
  if (!existsSync(binary)) {
    return [
      bad(
        'session-start emits the policy',
        'binary missing',
        'reinstall the package'
      ),
    ];
  }

  // probeEnforcement normally creates this, but it returns early when the router
  // binary is missing -- before its own mkdirSync -- and a cwd that does not
  // exist makes the SPAWN fail rather than the hook. Do not depend on another
  // check having run first.
  mkdirSync(workspace, { recursive: true });
  // Test the installed binary independently of an intentional runtime opt-out,
  // as probeEnforcement does. diagnose reports the effective mode separately.
  const out = await probe(
    binary,
    {},
    { cwd: workspace, env: { TOKEN_OPTIMIZER_MODE: 'enforce' } }
  );
  // JSON.parse(null) coerces to the string 'null' and RETURNS null rather than
  // throwing, so without this the never-ran case fell past the catch written for
  // it and reported 'ran, but produced no policy text' -- sending the user after
  // TOKEN_OPTIMIZER_MODE for what is a spawn failure.
  if (out === null) {
    return [
      bad(
        'session-start emits the policy',
        'the hook produced no output at all -- it did not run',
        'reinstall the package; the binary is present but could not be executed'
      ),
    ];
  }
  try {
    const parsed = JSON.parse(out);
    const context = parsed?.hookSpecificOutput?.additionalContext || '';
    return [
      context.includes('Token optimization is active')
        ? ok(
            'session-start emits the policy',
            `${Math.ceil(context.length / 4)} tokens of standing context`
          )
        : bad(
            'session-start emits the policy',
            'ran, but produced no policy text',
            'reinstall the package and report the session-start hook failure if the policy is still missing'
          ),
    ];
  } catch {
    return [
      bad(
        'session-start emits the policy',
        `unparseable output: ${String(out).slice(0, 120)}`,
        'reinstall the package; the hook is present but not producing valid output'
      ),
    ];
  }
}

/** The graph has to be writable, and private. */
export function probeGraph({ dir }) {
  const checks = [];
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const canary = join(dir, '.doctor-write-test');
    writeFileSync(canary, 'ok');
    unlinkSync(canary);
    checks.push(ok('graph directory writable', dir));
  } catch (error) {
    checks.push(
      bad(
        'graph directory writable',
        String(error?.message || error),
        `check permissions on ${dir}, or set TOKEN_OPTIMIZER_WIKI_DIR to a writable path`
      )
    );
    return checks;
  }

  // The graph names real paths from a private codebase, so the mode matters --
  // but only where POSIX modes mean anything. On Windows chmod is a no-op and
  // the bits read back as world-readable regardless, so failing there would be
  // reporting a platform property as a broken install: a false alarm that
  // teaches people to ignore the doctor.
  // BEFORE THE PLATFORM RETURN, and this is exactly the defect this branch
  // exists to close: the client probe was appended after `probeGraph`'s
  // Windows early-return, so on Windows it had a call site and never ran. A
  // reference that cannot execute is what the reachability guard cannot see.
  const clients = probeClients({ dir });

  if (process.platform === 'win32') {
    checks.push(
      ok(
        'graph directory is private',
        'POSIX modes are not enforced on Windows; the directory inherits its parent ACL'
      )
    );
    checks.push(...clients);
    return checks;
  }

  try {
    const mode = statSync(dir).mode & 0o777;
    checks.push(
      (mode & 0o077) === 0
        ? ok('graph directory is private', `mode ${mode.toString(8)}`)
        : bad(
            'graph directory is private',
            `mode ${mode.toString(8)} is group- or world-readable`,
            `run: chmod 700 ${dir}`
          )
    );
  } catch {
    checks.push(
      ok(
        'graph directory is private',
        'mode could not be read on this filesystem'
      )
    );
  }

  checks.push(...clients);
  return checks;
}

/**
 * Which MCP clients have actually handshaked with this server.
 *
 * THE QUESTION THE REST OF THE DOCTOR CANNOT ANSWER. Every other check here
 * reasons about files on disk: is the hook present, is it wired, does it refuse
 * a large read. None of them can tell you whether the editor in front of you
 * ever actually connected -- which is the single most common way this product
 * is installed and silently does nothing.
 *
 * `mcp-client` records exactly that on every `initialize`, and nothing read it
 * until now. NEVER A FAILURE: a fresh install has no handshakes yet, and a
 * doctor that reports red on a correct install teaches people to ignore it.
 */
export function probeClients({ dir }) {
  let clients = [];
  try {
    clients = mcpClientsSeen(dir);
  } catch {
    return [ok('MCP clients seen', 'no evidence log yet')];
  }
  if (!clients.length) {
    return [
      ok(
        'MCP clients seen',
        'none yet -- the server has had no MCP handshake in this project'
      ),
    ];
  }
  const described = clients
    .slice(0, 5)
    .map((c) => `${c.title || c.client}${c.version ? ` ${c.version}` : ''}`)
    .join(', ');
  return [
    ok(
      'MCP clients seen',
      `${clients.length}: ${described}` +
        (clients.length > 5 ? `, and ${clients.length - 5} more` : '')
    ),
  ];
}

/**
 * Is this tree a source checkout, or an installed package?
 *
 * It decides the remedy, and getting it wrong is issue #307's second complaint:
 * every server failure suggested `npm run build` -- advice that is impossible to
 * follow inside `node_modules`, where there is no src/ and no dev toolchain. A
 * published package that cannot start needs reinstalling, not compiling.
 */
function isSourceCheckout(root) {
  return (
    existsSync(join(root, 'src', 'server', 'index.ts')) &&
    existsSync(join(root, 'tsconfig.json'))
  );
}

/** The remedy for "the server did not work", phrased for the install we are in. */
function serverRemedy(root, extra) {
  const base = isSourceCheckout(root)
    ? 'run `npm run build`'
    : 'reinstall the package: `npm install -g @ooples/token-optimizer-mcp@latest` ' +
      '(or clear the npx cache and retry)';
  return extra ? `${base}; ${extra}` : base;
}

/**
 * Speak the MCP handshake to the server and return its `tools/list` result.
 *
 * Run as a child process, not inline, so `diagnose()` callers get a plain
 * synchronous-looking await and the probe can hold stdin OPEN. That last part is
 * the fix: the previous probe used `execFileSync` with `input`, which closes
 * stdin the instant the request is written. The server treats stdin closing as
 * "my client died" (correctly -- that is the only orphan signal Windows gives
 * it) and shuts down, racing its own reply. It also skipped `initialize`
 * entirely, so it was asking an uninitialized server a question the protocol
 * does not promise to answer.
 *
 * Returns { tools, code, signal, stderr, timedOut } and never throws.
 */
function speakMcp(entry, timeoutMs) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(process.execPath, [entry], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      resolve({
        tools: null,
        code: null,
        signal: null,
        timedOut: false,
        stderr: String(error?.message || error),
      });
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;

    const finish = (extra = {}) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      resolve({
        tools: readTools(stdout),
        stderr: stderr.trim(),
        timedOut,
        elapsedMs: Date.now() - started,
        code: null,
        signal: null,
        ...extra,
      });
    };

    const started = Date.now();
    const timer = setTimeout(() => {
      timedOut = true;
      finish();
    }, timeoutMs);

    child.on('error', (error) => {
      stderr += `\n${error?.message || error}`;
      finish();
    });
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      // Answer in hand: stop early rather than burn the whole timeout.
      if (readTools(stdout)) finish();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    // close follows stdio drainage, so a startup error is not lost on exit.
    child.on('close', (code, signal) => finish({ code, signal }));
    // A server can exit before consuming the handshake. EPIPE is asynchronous;
    // the close outcome and captured stderr, not an unhandled stdin error,
    // must determine the diagnosis.
    child.stdin.on('error', () => {});

    const send = (message) => {
      try {
        child.stdin.write(`${JSON.stringify(message)}\n`);
      } catch {
        /* exited */
      }
    };
    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'token-optimizer-doctor', version: '1' },
      },
    });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    // stdin stays open until finish() kills the child.
  });
}

/** The tools array from whichever line carries the tools/list result, or null. */
function readTools(stdout) {
  for (const line of stdout.split('\n')) {
    if (!line.startsWith('{')) continue;
    try {
      const tools = JSON.parse(line)?.result?.tools;
      if (Array.isArray(tools)) return tools;
    } catch {
      // A partial line at the buffer edge; the next chunk completes it.
    }
  }
  return null;
}

/**
 * The MCP server has to start and list its tools.
 *
 * This is the check that would have caught a broken build being published: the
 * config can name a server that does not run.
 *
 * WHEN IT FAILS, IT MUST SAY WHY. This check used to run the server with
 * `stdio: [..., 'ignore']` for stderr and then report `error.message`, which for
 * `execFileSync` is the bare string "Command failed: <node> <entry>". The server
 * had in fact printed its exception -- to the stderr that was being discarded.
 * Issue #307 is a user staring at that sentence, with the actual cause thrown
 * away by the tool whose entire job was to find it. Every failure below carries
 * the child's exit status and its stderr.
 */
export async function probeServer({ root, timeoutMs = 20_000 }) {
  const entry = join(root, 'dist', 'server', 'index.js');
  if (!existsSync(entry)) {
    return [
      bad(
        'MCP server responds',
        `${entry} not found`,
        serverRemedy(root, 'the build output is missing entirely')
      ),
    ];
  }

  const result = await speakMcp(entry, timeoutMs);
  const detail = (summary) => {
    const parts = [summary];
    if (result.code !== null && result.code !== undefined)
      parts.push(`exit code ${result.code}`);
    if (result.signal) parts.push(`killed by ${result.signal}`);
    if (result.stderr)
      parts.push(`stderr: ${stderrHighlights(result.stderr, 6)}`);
    return parts.join('\n          ');
  };

  if (result.timedOut && !result.tools) {
    return [
      bad(
        'MCP server responds',
        detail(`no tools/list reply within ${timeoutMs}ms`),
        serverRemedy(
          root,
          "raise the client's startup timeout if the machine is slow"
        )
      ),
    ];
  }

  if (!result.tools) {
    return [
      bad(
        'MCP server responds',
        detail('the server exited without answering tools/list'),
        serverRemedy(root)
      ),
    ];
  }

  if (!result.tools.length) {
    return [
      bad(
        'MCP server responds',
        detail('started, but listed no tools'),
        serverRemedy(
          root,
          'check TOKEN_OPTIMIZER_TOOL_PROFILE -- an empty profile registers nothing'
        )
      ),
    ];
  }

  if (!result.tools.some((tool) => tool?.name === 'wiki_write')) {
    return [
      bad(
        'MCP server responds',
        `${result.tools.length} tools listed, but wiki_write is missing`,
        'use the core or full tool profile; semantic harvesting requires wiki_write'
      ),
    ];
  }

  const seconds = (result.elapsedMs / 1000).toFixed(1);

  // A SERVER THAT ANSWERS TOO LATE IS A SERVER THAT NEVER ANSWERS.
  //
  // Codex kills a stdio server that has not completed its initialize handshake
  // within `startup_timeout_sec`, which defaults to 10. The user then sees a
  // server that was configured, enabled, and registered no tools --
  // indistinguishable from a crash, and reported as one (#307). This probe holds
  // the only stopwatch on the machine, so this is where it has to be said.
  //
  // Cold start is the slow one: `npx -y ...@latest` contacts the registry before
  // node runs at all, then the tokenizer loads and the cache database opens.
  // Measured on Windows, cold 12.1s against warm 1.4s -- healthy both times, and
  // over the default budget exactly once.
  if (result.elapsedMs > CLIENT_STARTUP_BUDGET_MS) {
    return [
      bad(
        'MCP server responds',
        `${result.tools.length} tools listed, but startup took ${seconds}s`,
        `that is past the ${CLIENT_STARTUP_BUDGET_MS / 1000}s Codex allows by default, which ` +
          'shows up as a server that registers no tools rather than as a timeout. Raise it -- ' +
          '`startup_timeout_sec = 30` under [mcp_servers.token-optimizer] in ~/.codex/config.toml'
      ),
    ];
  }

  return [
    ok(
      'MCP server responds',
      `${result.tools.length} tools listed in ${seconds}s; wiki_write available`
    ),
  ];
}

/**
 * The part of a child's stderr worth printing.
 *
 * Not the tail: an uncaught exception in Node prints the offending source line,
 * then the MESSAGE, then a stack, then the version banner. Tailing it yields six
 * lines of `node:internal/modules/...` frames and hides the one sentence that
 * says what went wrong. So the message line leads, and a little context follows.
 */
function stderrHighlights(text, count) {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    // Stack frames are the noise. Dropping them BEFORE tailing is the whole
    // trick: six raw tail lines of an uncaught exception are six
    // `at node:internal/modules/...` frames and no message.
    .filter((line) => !/^\s*at\s/.test(line));

  return lines.slice(-count).join('\n          ');
}

/* ------------------------------------------------------------ OTHER CLIENTS */

/**
 * The body of one TOML table, or null. Deliberately not a TOML parser.
 *
 * hooks-core is dependency-free by construction -- it is vendored into eleven
 * client trees and executed from each -- so pulling in a parser to read three
 * keys is not on offer. Reading a table header and the lines under it is enough
 * to answer "is it declared" and "is the timeout set", and a diagnostic that
 * guesses slightly wrong about an exotic TOML spelling is still better than one
 * that cannot see the file at all.
 */
function tomlTables(text) {
  // TOML lets one table be written [a.b], [a."b"] and [a.'b']. Splitting the
  // dotted key into SEGMENTS, with quotes and padding stripped, treats all three
  // as the same table -- and does it without building a regex out of text from
  // somebody's config file.
  const tables = [];
  let current = null;

  for (const line of text.split(/\r?\n/)) {
    const header = /^\s*\[([^[\]]+)\]\s*(?:#.*)?$/.exec(line);
    if (header) {
      current = { key: splitTomlKey(header[1]), body: [] };
      tables.push(current);
      continue;
    }
    if (current) current.body.push(line);
  }

  return tables.map((table) => ({
    key: table.key,
    body: table.body.join('\n'),
  }));
}

/** The body of the one table with this exact dotted key, or null. */
function tomlTable(text, name) {
  const wanted = splitTomlKey(name);
  const found = tomlTables(text).find((table) =>
    sameTomlKey(table.key, wanted)
  );
  return found ? found.body : null;
}

/** `mcp_servers."token-optimizer"` -> ['mcp_servers', 'token-optimizer']. */
function splitTomlKey(key) {
  return key
    .split('.')
    .map((part) => part.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean);
}

const sameTomlKey = (left, right) =>
  left.length === right.length && left.every((part, i) => part === right[i]);

/**
 * What does Codex think it has?
 *
 * The doctor ships inside a package that Codex, Claude Code, Cursor and seven
 * others all install, and until now it could only see one of them. #307 is a
 * Codex user whose report contained the two facts this check exists to state --
 * a server declared in BOTH the plugin manifest and ~/.codex/config.toml, and a
 * config.toml declaration with no startup timeout on it.
 *
 * Silent when Codex is not installed. A diagnostic that reports on absent
 * software is noise, and noise is how a report stops being read.
 */
export function probeCodex({ codexHome } = {}) {
  const home = codexHome || join(homedir(), '.codex');
  const configPath = join(home, 'config.toml');
  if (!existsSync(configPath)) return [];

  let config;
  try {
    config = readFileSync(configPath, 'utf8');
  } catch {
    return [
      bad(
        'codex config readable',
        `${configPath} could not be read`,
        'check the file permissions, or remove it to let Codex recreate it'
      ),
    ];
  }

  const server = tomlTable(config, 'mcp_servers.token-optimizer');

  // MATCH THE PLUGIN NAME, NOT THE FULL ID. A Codex plugin is keyed
  // `<name>@<marketplace>`, and the marketplace half is wherever the user added
  // it from. The reporter's config said `token-optimizer@token-optimizer`; the
  // machine this was written on says `token-optimizer@personal`. Pinning the
  // whole id would have made this check silently blind on both of them one day.
  const pluginTable = tomlTables(config).find(
    (table) =>
      table.key.length === 2 &&
      table.key[0] === 'plugins' &&
      table.key[1].split('@')[0] === PLUGIN_NAME
  );
  const pluginEnabled = Boolean(
    pluginTable && /^\s*enabled\s*=\s*true\s*$/m.test(pluginTable.body)
  );
  const pluginId = pluginTable?.key[1];

  if (!server && !pluginEnabled) {
    return [
      ok(
        'codex knows about this server',
        'no token-optimizer entry in ~/.codex/config.toml -- not installed for Codex, which is ' +
          'fine if you do not use it'
      ),
    ];
  }

  const checks = [];

  // BOTH ROUTES AT ONCE. The plugin declares the server in its own .mcp.json and
  // the config.toml block declares it again under the same name. Which set of
  // settings wins is then a question about Codex's merge order rather than about
  // anything we shipped, and the answer is not written down.
  checks.push(
    server && pluginEnabled
      ? bad(
          'codex declares this server once',
          `declared twice: the enabled plugin ${pluginId} provides it, and ` +
            '[mcp_servers.token-optimizer] declares it again',
          'keep one. The plugin is self-contained and carries its own timeouts, so the usual fix ' +
            'is `codex mcp remove token-optimizer`; keep the config.toml block instead if you are ' +
            'not using the plugin'
        )
      : ok(
          'codex declares this server once',
          pluginEnabled
            ? `via the enabled plugin ${pluginId}`
            : 'via [mcp_servers.token-optimizer]'
        )
  );

  // A config.toml block with no budget on it inherits Codex's default of 10
  // seconds, which a cold `npx -y ...@latest` start does not fit inside. The
  // plugin's own .mcp.json has always carried 30; a hand-merged block did not.
  if (server && !/^\s*startup_timeout_sec\s*=/m.test(server)) {
    checks.push(
      bad(
        'codex allows enough time to start',
        'no startup_timeout_sec on [mcp_servers.token-optimizer], so Codex uses its default of ' +
          `${CLIENT_STARTUP_BUDGET_MS / 1000}s`,
        'add `startup_timeout_sec = 30` to that block. A cold start pays for an npx registry ' +
          'lookup before node even runs, and gets killed mid-handshake -- which looks exactly ' +
          'like a server that registered no tools'
      )
    );
  } else if (server) {
    const budget = /^\s*startup_timeout_sec\s*=\s*(\d+)/m.exec(server);
    checks.push(
      ok(
        'codex allows enough time to start',
        `startup_timeout_sec = ${budget?.[1]}`
      )
    );
  }

  return checks;
}

/**
 * Is the cache actually persisting?
 *
 * The server no longer dies when its database will not open -- it falls back to
 * an in-memory one so every tool keeps working (#307). That is the right trade,
 * and it has exactly one hazard: a degraded cache is invisible from outside.
 * Every call succeeds, every write is thrown away at exit, and the hit rate is
 * zero forever. This project has already paid for a silent cache fallback once;
 * that one was a tmpdir, and it was removed for producing a 0% hit rate nobody
 * could see. So the fallback is allowed to exist, on the condition that the
 * doctor says it is there.
 *
 * Only the running server can answer, so the reason is passed in rather than
 * detected here: a fresh CacheEngine opened by the doctor may well succeed while
 * the one inside the server is still degraded.
 */
export function probeCache({ degradedReason }) {
  if (!degradedReason) return [];
  return [
    bad(
      'cache is persisting',
      `running in memory only -- ${degradedReason}`,
      'fix the path above, then restart the MCP server. Tools work meanwhile, but ' +
        'nothing is cached across runs, so every read is paid for again'
    ),
  ];
}

/* --------------------------------------------------------------- ASSEMBLY */

/**
 * The full examination.
 *
 * Structural checks first because they are fast and explain most failures;
 * probes after, because they are what actually prove it works.
 */
export async function diagnose({
  root,
  workspace,
  graphDir,
  settingsPath,
  pluginsDir,
  skipServer = false,
  cacheDegradedReason = null,
  codexHome,
  clientName,
  client: clientRequested,
  cwd,
} = {}) {
  // Resolved ONCE and threaded through, so every check reasons about the same
  // install. Detecting per-probe is how the checklist and the enforcement probe
  // ended up describing two different builds in the same report.
  //
  // THE CLIENT DECIDES WHICH INSTALL IS THE SUBJECT. Read through the same clientFrom() the
  // proxy checks use, so the report cannot diagnose one client's install while describing
  // another's routing (#408).
  const client = clientFrom(process.env, clientName, clientRequested);

  const install = detectInstall({
    pluginsDir,
    root,
    client,
    codexHome,
    cwd,
  });

  // THE THREE SPAWNING PROBES RUN CONCURRENTLY. Each is a separate Node
  // process and the cost is almost entirely that process's own startup, so
  // serialising them just added the wall clocks together. They share no state:
  // probeEnforcement works under a per-run `probeId` and cleans up after
  // itself, probeSessionStart creates the workspace itself rather than relying
  // on another check having run first, and probeServer spawns a separate
  // server. Order is restored below, so the report reads exactly as before.
  // The Claude Code record, when it is NOT the subject: reported beside the verdict as another
  // client's state rather than as this one's.
  const crossClient =
    install.method === 'plugin' ? null : detectInstall({ pluginsDir, root });

  const [enforcement, sessionStart, serverChecks, supervisor] =
    await Promise.all([
      probeEnforcement({ root, workspace, install }),
      probeSessionStart({ root, workspace, install }),
      skipServer ? Promise.resolve([]) : probeServer({ root }),
      // One loopback request with a short timeout; it shares no state with the others.
      probeSupervisor(process.env, { clientName, client: clientRequested }),
    ]);

  const checks = [
    ...probeMode({ settingsPath }),
    ...checklist({ root, settingsPath, install }),
    ...probeVersion({ install, crossClient }),
    ...probeHarvest(),
    ...supervisor,
    ...probeProxy(process.env, { clientName, client: clientRequested }),
    ...enforcement,
    ...sessionStart,
    ...probeGraph({ dir: graphDir }),
    ...probeCodex({ codexHome }),
    ...probeCache({ degradedReason: cacheDegradedReason }),
    ...serverChecks,
  ];

  const failed = checks.filter((c) => !c.pass);
  const warnings = checks.filter((c) => c.pass && c.warn);
  return {
    // Carried so the report can speak about the file that was examined.
    settingsPath: settingsPath ?? null,
    mode: mode(),
    checks,
    passed: checks.length - failed.length - warnings.length,
    warnings: warnings.length,
    total: checks.length,
    healthy: failed.length === 0,
    failed,
  };
}

/**
 * The effective mode, and where an opt-out comes from (#395).
 *
 * TOKEN_OPTIMIZER_MODE=off is a deliberate, healthy configuration that saves nothing. Reporting it
 * as one more PASS let the override sit unnoticed in ~/.claude/settings.json behind a clean sheet,
 * so it is a warning that names the file (or the process environment) and the key to remove.
 */
export function probeMode({ settingsPath } = {}) {
  const effective = mode();
  if (effective !== 'off') {
    return [
      ok(
        'effective optimization mode',
        `${effective}; hook probes below temporarily use enforce mode`
      ),
    ];
  }
  // BOTH SOURCES WHEN BOTH ARE SET. mode() reads the process environment, so removing the settings
  // entry alone would not change anything -- and naming only the file would send the user to fix
  // half of it and find the doctor unmoved.
  let fromSettings = false;
  if (settingsPath && existsSync(settingsPath)) {
    try {
      const value = JSON.parse(readFileSync(settingsPath, 'utf8'))?.env
        ?.TOKEN_OPTIMIZER_MODE;
      fromSettings =
        String(value ?? '')
          .trim()
          .toLowerCase() === 'off';
    } catch {
      /* an unparseable settings file is reported by the checklist */
    }
  }
  // WHEN THE FILE SETS IT, BOTH SOURCES ARE NAMED. The agent applies its settings `env` block to
  // the processes it launches, so a settings opt-out reaches mode() as a process variable as well,
  // and from in here that is indistinguishable from a shell that also exports it. Naming only the
  // file would send someone to edit it, restart, and find the doctor unmoved.
  const detail = fromSettings
    ? `disabled by TOKEN_OPTIMIZER_MODE=off in the "env" block of ${settingsPath}, which the agent ` +
      'also applies to this process'
    : 'disabled by TOKEN_OPTIMIZER_MODE=off in the process environment';
  const remedy = fromSettings
    ? `remove "TOKEN_OPTIMIZER_MODE" from the "env" block of ${settingsPath}, and unset it in any ` +
      'shell that exports it, then start a new session'
    : 'unset TOKEN_OPTIMIZER_MODE where the agent is launched, then start a new session';
  return [
    warn(
      'effective optimization mode',
      `${detail}: hooks neither refuse nor advise, so nothing is saved. ` +
        'Hook probes below temporarily use enforce mode.',
      remedy
    ),
  ];
}

/** The report, with a remedy on every failure. */
export function renderDiagnosis(result) {
  const label = (check) =>
    !check.pass ? 'FAIL' : check.warn ? 'WARN' : 'PASS';
  const lines = result.checks.map(
    (check) =>
      `  ${label(check)}  ${check.name}` +
      (check.detail ? `\n          ${check.detail}` : '') +
      ((check.pass && !check.warn) || !check.remedy
        ? ''
        : `\n          fix: ${check.remedy}`)
  );
  const warnings = Number(
    result.warnings ?? result.checks.filter((c) => c.pass && c.warn).length
  );
  const disabled = result.checks.find(
    (c) => c.warn && c.name === 'effective optimization mode'
  );

  const residueNote = [];
  // The path diagnose ACTUALLY EXAMINED. Reading the env override here meant the
  // residue note printed for nobody who had not set one -- that is, almost
  // everybody, since both callers compute a default. It is also the only line
  // that covers settings entries at all: removalPlan handles manifest-recorded
  // files and nothing else.
  const settings = result.settingsPath || process.env.TOKEN_OPTIMIZER_SETTINGS;
  if (settings) {
    const found = residue(settings);
    residueNote.push(
      '',
      found.clean
        ? 'No token-optimizer entries in the settings file.'
        : `${found.entries.length} token-optimizer entry/entries present in the settings file.`
    );
  }

  return [
    `${result.passed}/${result.total} checks passed` +
      (warnings ? `, ${warnings} warning${warnings === 1 ? '' : 's'}.` : '.'),
    '',
    ...lines,
    ...residueNote,
    '',
    result.healthy
      ? 'Installation probes passed: the hook emitted policy and refused a synthetic large read in enforce mode.'
      : 'Something above is broken. Each failure names its own fix.',
    // SAID WHETHER OR NOT THE INSTALL IS HEALTHY. Tying this to `healthy` hid it on exactly the
    // installs that need it most -- a broken install with optimization switched off reported only
    // the breakage -- and made the report depend on the machine it ran on.
    ...(result.mode === 'off'
      ? [
          `Optimization is disabled by TOKEN_OPTIMIZER_MODE=off: nothing is being saved.` +
            (disabled?.remedy ? ` To enable it: ${disabled.remedy}.` : ''),
        ]
      : []),
    'Enforcement can be turned off at any time with TOKEN_OPTIMIZER_MODE=off.',
  ].join('\n');
}
