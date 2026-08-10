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

import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, statSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { harvestMode } from './harvest.mjs';
import { readManifest, verifyManifest, residue } from './manifest.mjs';

const ok = (name, detail) => ({ name, pass: true, detail });
const bad = (name, detail, remedy) => ({ name, pass: false, detail, remedy });

const PLUGIN_ID = 'token-optimizer@token-optimizer';

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
  const parse = (v) => String(v || '').split('.').map((n) => Number.parseInt(n, 10));
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
export function detectInstall({ pluginsDir, root } = {}) {
  const dir = pluginsDir || join(homedir(), '.claude', 'plugins');
  const packageHooks = join(root || '.', 'plugin', 'hooks');

  const record = readJson(join(dir, 'installed_plugins.json'))?.plugins?.[PLUGIN_ID]?.[0];
  const marketplace = readJson(
    join(dir, 'marketplaces', 'token-optimizer', 'plugin', '.claude-plugin', 'plugin.json')
  );

  const installedVersion = record?.version ?? null;
  const availableVersion = marketplace?.version ?? null;
  const pluginHooks = record?.installPath ? join(record.installPath, 'hooks') : null;

  // A record whose installPath has gone missing is a broken plugin install, not
  // a script install -- saying "script" there would send the user to the wrong
  // remedy entirely.
  if (record) {
    return {
      method: 'plugin',
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
    hooksDir: packageHooks,
    installPath: null,
    installedVersion,
    availableVersion,
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
 * ZERO findings, because harvestMode() was 'off:not-opted-in'. Fifteen checks
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

  if (mode === 'local') {
    return [ok('finding extraction is available',
      'active-model wiki_write is primary; local endpoint also enables fallback extraction')];
  }
  if (mode === 'remote') {
    return [ok('finding extraction is available',
      'active-model wiki_write is primary; a credential also enables fallback extraction from ' +
      'the bounded digest. TOKEN_OPTIMIZER_HARVEST=0 turns only that fallback off')];
  }

  // No second-model credential is required for the primary path. The Codex/agent session that
  // already paid to derive the conclusion is the extractor and wiki_write is local.
  if (mode === 'off:no-key') {
    return [ok('finding extraction is available',
      'active model records durable conclusions through local wiki_write; no separate-model ' +
      'credential is configured, so fallback transcript extraction is unavailable')];
  }

  // off:opted-out -- a deliberate choice, reported as one. Nagging about a setting somebody chose
  // is how a diagnostic gets ignored, and the point of this check is that it is worth reading.
  return [ok('finding extraction is available',
    'active-model wiki_write remains available; separate-model fallback extraction is off by ' +
    'your choice (TOKEN_OPTIMIZER_HARVEST is set to a false value)')];
}

export function probeVersion({ install }) {
  const { method, installedVersion, availableVersion } = install || {};

  if (method !== 'plugin' || !installedVersion || !availableVersion) {
    return [];
  }

  if (compareVersions(installedVersion, availableVersion) < 0) {
    return [bad('plugin is up to date',
      `installed ${installedVersion}, but ${availableVersion} is available`,
      'run /plugin and update token-optimizer -- updating the marketplace alone ' +
      'does not move the installed version, and older builds shipped far weaker hooks')];
  }

  return [ok('plugin is up to date', `installed ${installedVersion}`)];
}

/** Runs a hook binary with a payload and returns its stdout, or null. */
function probe(binary, payload, { timeoutMs = 8000, cwd, env } = {}) {
  try {
    return execFileSync(process.execPath, [binary], {
      input: JSON.stringify(payload),
      encoding: 'utf8',
      timeout: timeoutMs,
      cwd,
      env: { ...process.env, ...(env || {}) },
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'ignore'],
    });
  } catch (error) {
    // A hook that exits non-zero WITH OUTPUT still told us something. One that
    // timed out, was killed, or never spawned told us nothing -- and null has to
    // mean exactly that, because an empty string is a legitimate "allowed".
    return error?.stdout || null;
  }
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
  checks.push(ok('install method', resolved.method === 'plugin'
    ? `plugin${resolved.installedVersion ? ` ${resolved.installedVersion}` : ''}` +
      ` -- hooks from ${hooksDir}`
    : `${resolved.method} -- hooks from ${hooksDir}`));

  const router = join(hooksDir, 'pretooluse-router.mjs');
  const sessionStart = join(hooksDir, 'session-start.mjs');

  checks.push(existsSync(router)
    ? ok('hook binary present', router)
    : bad('hook binary present', `not found at ${router}`,
      'reinstall the package, or run install-hooks.sh (install-hooks.ps1 on Windows)'));

  checks.push(existsSync(sessionStart)
    ? ok('session-start binary present', sessionStart)
    : bad('session-start binary present', `not found at ${sessionStart}`,
      'reinstall the package to restore the session-start hook'));

  // SETTINGS AND MANIFEST ARE SCRIPT-INSTALL CONCERNS ONLY.
  //
  // A plugin declares its hooks in the plugin's own hooks.json and writes
  // nothing to settings.json, so demanding entries there reported "not wired"
  // about a plugin that was demonstrably wired -- its SessionStart hook was
  // injecting the policy at that very moment. Likewise the manifest: only
  // install-hooks.* writes one. Two guaranteed failures on a healthy install
  // taught the user to ignore the score.
  if (resolved.method !== 'plugin') {
    if (settingsPath && existsSync(settingsPath)) {
      try {
        const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
        const wired = JSON.stringify(settings?.hooks || {}).includes('token-optimizer');
        checks.push(wired
          ? ok('hooks wired into settings', settingsPath)
          : bad('hooks wired into settings', 'no token-optimizer entries found',
            'run install-hooks.sh to add the PreToolUse and SessionStart entries'));
      } catch {
        checks.push(bad('settings file parses', `${settingsPath} is not valid JSON`,
          'fix the JSON by hand -- we will not rewrite a file we cannot parse'));
      }
    } else {
      checks.push(bad('settings file present', `${settingsPath || 'settings path unknown'} not found`,
        'run install-hooks.sh, or point TOKEN_OPTIMIZER_SETTINGS at your settings file'));
    }

    // What we recorded putting on the machine, and whether it is still that.
    const verified = verifyManifest(readManifest());
    if (verified) {
      checks.push(verified.modified === 0
        ? ok('installed files intact', `${verified.intact} file(s) match the install manifest`)
        : ok('installed files intact', `${verified.modified} file(s) edited since install -- ` +
          'uninstall will leave those alone rather than destroy your changes'));
    } else {
      checks.push(bad('install manifest present', 'no record of what was installed',
        'harmless if you installed manually; reinstall to get a removable, verifiable record'));
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
export function probeEnforcement({ root, workspace, hooksDir, install }) {
  const checks = [];
  // Probe the build that RUNS, not the one bundled beside this module. On a real
  // machine those were 5.3.5 and 5.3.6 with all 37 hook files differing, and
  // this probe passed for the copy nobody was executing.
  const binary = join(hooksDirFor({ hooksDir, install, root }), 'pretooluse-router.mjs');
  if (!existsSync(binary)) {
    return [bad('enforcement refuses a large read', 'hook binary missing', 'reinstall the package')];
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
    // The router is deliberately fail-open without positive runtime MCP
    // inventory evidence. This probe tests the enforcement path, so it must
    // attest the exact replacement whose routing it is trying to verify.
    const probeOptions = {
      env: { TOKEN_OPTIMIZER_MCP_CAPABILITIES: 'smart_read' },
    };
    const denied = probe(
      binary,
      {
        tool_name: 'Read',
        tool_input: { file_path: big },
        cwd: workspace,
        session_id: probeId,
      },
      probeOptions
    );
    const deniedOk = typeof denied === 'string' && denied.includes('deny');
    checks.push(deniedOk
      ? ok('enforcement refuses a large read', 'the refusal came back from the real hook')
      : bad('enforcement refuses a large read', `hook returned: ${String(denied).slice(0, 200) || '(nothing)'}`,
        'check TOKEN_OPTIMIZER_MODE is not "off" or "advise", then reinstall the hooks'));

    const allowed = probe(
      binary,
      {
        tool_name: 'Read',
        tool_input: { file_path: small },
        cwd: workspace,
        session_id: probeId,
      },
      probeOptions
    );
    // `allowed === null` is "the probe never ran", NOT "the hook allowed it".
    // allow() writes nothing and exits 0, so '' is a legitimate allow -- but null
    // is a spawn failure, an EPERM, or a timeout, and reporting a pass there is a
    // green tick produced by an absent measurement. A hook that hangs on every
    // small read is a catastrophic install, and this check used to call it fine.
    const allowedOk = allowed !== null && !allowed.includes('deny');
    checks.push(allowedOk
      ? ok('small reads are left alone', 'no refusal, as intended')
      : bad('small reads are left alone',
        allowed === null
          ? 'the hook produced no result at all -- it crashed, hung past the timeout, or could not be spawned'
          : 'the hook refused a tiny file',
        'a hook that refuses everything, or answers nothing, is as broken as one that refuses nothing -- report this'));
  } finally {
    for (const path of [big, small]) {
      try { unlinkSync(path); } catch { /* best effort */ }
    }
  }

  return checks;
}

/** The session-start notice has to actually come out. */
export function probeSessionStart({ root, workspace, hooksDir, install }) {
  const binary = join(hooksDirFor({ hooksDir, install, root }), 'session-start.mjs');
  if (!existsSync(binary)) {
    return [bad('session-start emits the policy', 'binary missing', 'reinstall the package')];
  }

  // probeEnforcement normally creates this, but it returns early when the router
  // binary is missing -- before its own mkdirSync -- and a cwd that does not
  // exist makes the SPAWN fail rather than the hook. Do not depend on another
  // check having run first.
  mkdirSync(workspace, { recursive: true });
  const out = probe(binary, {}, { cwd: workspace });
  // JSON.parse(null) coerces to the string 'null' and RETURNS null rather than
  // throwing, so without this the never-ran case fell past the catch written for
  // it and reported 'ran, but produced no policy text' -- sending the user after
  // TOKEN_OPTIMIZER_MODE for what is a spawn failure.
  if (out === null) {
    return [bad('session-start emits the policy',
      'the hook produced no output at all -- it did not run',
      'reinstall the package; the binary is present but could not be executed')];
  }
  try {
    const parsed = JSON.parse(out);
    const context = parsed?.hookSpecificOutput?.additionalContext || '';
    return [context.includes('Token optimization is active')
      ? ok('session-start emits the policy', `${Math.ceil(context.length / 4)} tokens of standing context`)
      : bad('session-start emits the policy', 'ran, but produced no policy text',
        'check TOKEN_OPTIMIZER_MODE is not "off"')];
  } catch {
    return [bad('session-start emits the policy', `unparseable output: ${String(out).slice(0, 120)}`,
      'reinstall the package; the hook is present but not producing valid output')];
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
    checks.push(bad('graph directory writable', String(error?.message || error),
      `check permissions on ${dir}, or set TOKEN_OPTIMIZER_WIKI_DIR to a writable path`));
    return checks;
  }

  // The graph names real paths from a private codebase, so the mode matters --
  // but only where POSIX modes mean anything. On Windows chmod is a no-op and
  // the bits read back as world-readable regardless, so failing there would be
  // reporting a platform property as a broken install: a false alarm that
  // teaches people to ignore the doctor.
  if (process.platform === 'win32') {
    checks.push(ok('graph directory is private',
      'POSIX modes are not enforced on Windows; the directory inherits its parent ACL'));
    return checks;
  }

  try {
    const mode = statSync(dir).mode & 0o777;
    checks.push((mode & 0o077) === 0
      ? ok('graph directory is private', `mode ${mode.toString(8)}`)
      : bad('graph directory is private', `mode ${mode.toString(8)} is group- or world-readable`,
        `run: chmod 700 ${dir}`));
  } catch {
    checks.push(ok('graph directory is private', 'mode could not be read on this filesystem'));
  }

  return checks;
}

/**
 * The MCP server has to start and list its tools.
 *
 * This is the check that would have caught a broken build being published: the
 * config can name a server that does not run.
 */
export function probeServer({ root, timeoutMs = 20_000 }) {
  const entry = join(root, 'dist', 'server', 'index.js');
  if (!existsSync(entry)) {
    return [bad('MCP server responds', `${entry} not found`, 'run `npm run build`, or reinstall the package')];
  }

  try {
    const out = execFileSync(process.execPath, [entry], {
      input: `${JSON.stringify({ jsonrpc: '2.0', id: '1', method: 'tools/list' })}\n`,
      encoding: 'utf8',
      timeout: timeoutMs,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    const line = out.split('\n').find((l) => l.startsWith('{'));
    const tools = line ? JSON.parse(line)?.result?.tools : null;
    if (!Array.isArray(tools) || !tools.length) {
      return [bad('MCP server responds', 'started but listed no tools',
        'run `npm run build` and try again')];
    }
    if (!tools.some((tool) => tool?.name === 'wiki_write')) {
      return [bad('MCP server responds', `${tools.length} tools listed, but wiki_write is missing`,
        'use the core or full tool profile; semantic harvesting requires wiki_write')];
    }
    return [ok('MCP server responds', `${tools.length} tools listed; wiki_write available`)];
  } catch (error) {
    return [bad('MCP server responds', String(error?.message || error).slice(0, 160),
      'run `npm run build`; if it persists the install is incomplete')];
  }
}

/* --------------------------------------------------------------- ASSEMBLY */

/**
 * The full examination.
 *
 * Structural checks first because they are fast and explain most failures;
 * probes after, because they are what actually prove it works.
 */
export function diagnose({
  root, workspace, graphDir, settingsPath, pluginsDir, skipServer = false,
} = {}) {
  // Resolved ONCE and threaded through, so every check reasons about the same
  // install. Detecting per-probe is how the checklist and the enforcement probe
  // ended up describing two different builds in the same report.
  const install = detectInstall({ pluginsDir, root });

  const checks = [
    ...checklist({ root, settingsPath, install }),
    ...probeVersion({ install }),
    ...probeHarvest(),
    ...probeEnforcement({ root, workspace, install }),
    ...probeSessionStart({ root, workspace, install }),
    ...probeGraph({ dir: graphDir }),
    ...(skipServer ? [] : probeServer({ root })),
  ];

  const failed = checks.filter((c) => !c.pass);
  return {
    // Carried so the report can speak about the file that was examined.
    settingsPath: settingsPath ?? null,
    checks,
    passed: checks.length - failed.length,
    total: checks.length,
    healthy: failed.length === 0,
    failed,
  };
}

/** The report, with a remedy on every failure. */
export function renderDiagnosis(result) {
  const lines = result.checks.map((check) => `  ${check.pass ? 'PASS' : 'FAIL'}  ${check.name}` +
    (check.detail ? `\n          ${check.detail}` : '') +
    (check.pass || !check.remedy ? '' : `\n          fix: ${check.remedy}`));

  const residueNote = [];
  // The path diagnose ACTUALLY EXAMINED. Reading the env override here meant the
  // residue note printed for nobody who had not set one -- that is, almost
  // everybody, since both callers compute a default. It is also the only line
  // that covers settings entries at all: removalPlan handles manifest-recorded
  // files and nothing else.
  const settings = result.settingsPath || process.env.TOKEN_OPTIMIZER_SETTINGS;
  if (settings) {
    const found = residue(settings);
    residueNote.push('', found.clean
      ? 'No token-optimizer entries in the settings file.'
      : `${found.entries.length} token-optimizer entry/entries present in the settings file.`);
  }

  return [
    `${result.passed}/${result.total} checks passed.`,
    '',
    ...lines,
    ...residueNote,
    '',
    result.healthy
      ? 'Enforcement is live: the hook was run and the refusal came back.'
      : 'Something above is broken. Each failure names its own fix.',
    'Enforcement can be turned off at any time with TOKEN_OPTIMIZER_MODE=off.',
  ].join('\n');
}
