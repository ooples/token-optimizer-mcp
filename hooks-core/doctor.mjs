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
import { existsSync, statSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { readManifest, verifyManifest, residue } from './manifest.mjs';

const ok = (name, detail) => ({ name, pass: true, detail });
const bad = (name, detail, remedy) => ({ name, pass: false, detail, remedy });

/** Runs a hook binary with a payload and returns its stdout, or null. */
function probe(binary, payload, { timeoutMs = 8000, cwd } = {}) {
  try {
    return execFileSync(process.execPath, [binary], {
      input: JSON.stringify(payload),
      encoding: 'utf8',
      timeout: timeoutMs,
      cwd,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'ignore'],
    });
  } catch (error) {
    // A hook that exits non-zero with output still told us something.
    return error?.stdout ?? null;
  }
}

/* ------------------------------------------------------------- THE CHECKLIST */

/** Cheap structural checks. Fast, and each names its own fix. */
export function checklist({ root, settingsPath }) {
  const checks = [];

  const router = join(root, 'plugin', 'hooks', 'pretooluse-router.mjs');
  const sessionStart = join(root, 'plugin', 'hooks', 'session-start.mjs');

  checks.push(existsSync(router)
    ? ok('hook binary present', router)
    : bad('hook binary present', `not found at ${router}`,
      'reinstall the package, or run install-hooks.sh (install-hooks.ps1 on Windows)'));

  checks.push(existsSync(sessionStart)
    ? ok('session-start binary present', sessionStart)
    : bad('session-start binary present', `not found at ${sessionStart}`,
      'reinstall the package to restore the session-start hook'));

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
export function probeEnforcement({ root, workspace }) {
  const checks = [];
  const binary = join(root, 'plugin', 'hooks', 'pretooluse-router.mjs');
  if (!existsSync(binary)) {
    return [bad('enforcement refuses a large read', 'hook binary missing', 'reinstall the package')];
  }

  mkdirSync(workspace, { recursive: true });
  const big = join(workspace, 'doctor-large.ts');
  const small = join(workspace, 'doctor-small.ts');
  writeFileSync(big, 'export const x = 1;\n'.repeat(20_000));
  writeFileSync(small, 'export const y = 2;\n');

  try {
    const denied = probe(binary, {
      tool_name: 'Read', tool_input: { file_path: big }, cwd: workspace, session_id: 'doctor',
    });
    const deniedOk = typeof denied === 'string' && denied.includes('deny');
    checks.push(deniedOk
      ? ok('enforcement refuses a large read', 'the refusal came back from the real hook')
      : bad('enforcement refuses a large read', `hook returned: ${String(denied).slice(0, 200) || '(nothing)'}`,
        'check TOKEN_OPTIMIZER_MODE is not "off" or "advise", then reinstall the hooks'));

    const allowed = probe(binary, {
      tool_name: 'Read', tool_input: { file_path: small }, cwd: workspace, session_id: 'doctor',
    });
    const allowedOk = !allowed || !allowed.includes('deny');
    checks.push(allowedOk
      ? ok('small reads are left alone', 'no refusal, as intended')
      : bad('small reads are left alone', 'the hook refused a tiny file',
        'a hook that refuses everything is as broken as one that refuses nothing -- report this'));
  } finally {
    for (const path of [big, small]) {
      try { unlinkSync(path); } catch { /* best effort */ }
    }
  }

  return checks;
}

/** The session-start notice has to actually come out. */
export function probeSessionStart({ root, workspace }) {
  const binary = join(root, 'plugin', 'hooks', 'session-start.mjs');
  if (!existsSync(binary)) {
    return [bad('session-start emits the policy', 'binary missing', 'reinstall the package')];
  }

  const out = probe(binary, {}, { cwd: workspace });
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
    return [Array.isArray(tools) && tools.length
      ? ok('MCP server responds', `${tools.length} tools listed`)
      : bad('MCP server responds', 'started but listed no tools', 'run `npm run build` and try again')];
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
export function diagnose({ root, workspace, graphDir, settingsPath, skipServer = false } = {}) {
  const checks = [
    ...checklist({ root, settingsPath }),
    ...probeEnforcement({ root, workspace }),
    ...probeSessionStart({ root, workspace }),
    ...probeGraph({ dir: graphDir }),
    ...(skipServer ? [] : probeServer({ root })),
  ];

  const failed = checks.filter((c) => !c.pass);
  return {
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
  const settings = process.env.TOKEN_OPTIMIZER_SETTINGS;
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
