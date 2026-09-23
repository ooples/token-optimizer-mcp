#!/usr/bin/env node
/**
 * Does this package actually install for a user?
 *
 * WHY THIS EXISTS. Two releases in a row shipped to fix installation, and both were found by users
 * rather than by us, because nothing here ever performed an installation. The unit suite imports
 * modules from the working tree; `verify:package-contents` checks the tarball's file list; neither
 * runs `npm install` and neither executes the postinstall that does the wiring. A package can pass
 * both and still fail on a clean machine -- a missing `files` entry, a script that assumes the repo
 * layout, an import that only resolves from source.
 *
 * So this packs the real tarball, installs it into a throwaway prefix, and drives the installed copy.
 *
 * ISOLATED, DELIBERATELY. Every path the installer writes is redirected into a temporary directory:
 * the settings file, the shell profiles, our own home. Nothing touches the developer's Claude
 * configuration, PATH, or daemon, and autostart is off so no background service is left behind. That
 * is what makes this safe to run on every change rather than only before a release.
 */

import { execFileSync, spawn } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  rmSync,
  readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * npm, run as JavaScript rather than through a shell.
 *
 * Node refuses to execFile a `.cmd` without a shell, and passing an argument array with
 * `shell: true` concatenates instead of escaping (DEP0190) -- a sandbox path containing a space
 * would then be split into two arguments. npm's own CLI is a plain script beside the Node binary,
 * so running it with this interpreter sidesteps both.
 */
const npmCli = join(
  dirname(process.execPath),
  'node_modules',
  'npm',
  'bin',
  'npm-cli.js'
);
const npmArgv = existsSync(npmCli) ? [npmCli] : null;
const runNpm = (args, options) =>
  npmArgv
    ? execFileSync(process.execPath, [...npmArgv, ...args], options)
    : execFileSync('npm', args, options);
const keep = process.argv.includes('--keep');
const failures = [];
const check = (ok, what, detail = '') => {
  if (ok) console.log(`  ok    ${what}`);
  else {
    console.log(`  FAIL  ${what}${detail ? ` -- ${detail}` : ''}`);
    failures.push(what);
  }
};

const sandbox = mkdtempSync(join(tmpdir(), 'token-optimizer-install-'));
const prefix = join(sandbox, 'prefix');
const settings = join(sandbox, 'settings.json');
const profile = join(sandbox, 'profile.ps1');
mkdirSync(prefix, { recursive: true });
writeFileSync(settings, JSON.stringify({ env: {} }, null, 2));
writeFileSync(profile, '# existing user content\n');

const env = {
  ...process.env,
  TOKEN_OPTIMIZER_SETTINGS: settings,
  TOKEN_OPTIMIZER_SHELL_PROFILES: JSON.stringify([profile]),
  TOKEN_OPTIMIZER_HOME: join(sandbox, 'home'),
  // No background service and no reach for a provider: this proves installation, not routing.
  TOKEN_OPTIMIZER_PROXY_AUTOSTART: '0',
  npm_config_yes: 'true',
};

try {
  console.log('packing the tarball the registry would serve...');
  const packed = runNpm(['pack', '--silent', '--pack-destination', sandbox], {
    cwd: root,
    encoding: 'utf8',
    env,
  })
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .pop();
  const tarball = join(sandbox, packed);
  check(existsSync(tarball), 'npm pack produced a tarball', tarball);

  console.log(
    'installing it into a throwaway prefix (runs the real postinstall)...'
  );
  // --prefer-offline DOES NOT WEAKEN THIS GATE. The subject under test is `tarball`, a local
  // path npm never caches, so it is read fresh every time; the flag only decides whether its
  // DEPENDENCIES come from ~/.npm or from another registry round-trip, and resolution and the
  // postinstall are identical either way. On windows-2022 this step measured 127-135s, most of
  // it revalidating packages `npm ci` had already put on disk earlier in the same job.
  const log = runNpm(
    [
      'install',
      '--prefix',
      prefix,
      '--prefer-offline',
      '--no-audit',
      '--no-fund',
      tarball,
    ],
    { cwd: sandbox, encoding: 'utf8', env, stdio: 'pipe' }
  );
  check(true, 'npm install completed without throwing');

  const installed = join(
    prefix,
    'node_modules',
    '@ooples',
    'token-optimizer-mcp'
  );
  check(existsSync(installed), 'the package landed in node_modules');

  // THE FILES AN INSTALL ACTUALLY NEEDS. A missing one here is exactly the class of defect the two
  // previous releases shipped: present in the repository, absent from the tarball.
  for (const relative of [
    'dist/server/index.js',
    'dist/proxy/server.js',
    'dist/proxy/supervisor.js',
    'dist/proxy/supervisor-cli.js',
    'dist/proxy/default-routing.js',
    'scripts/install-cli.mjs',
    'scripts/run-client.mjs',
    'scripts/route-client.mjs',
    'scripts/managed-clients.mjs',
    'hooks-core/capabilities.mjs',
    'hooks-core/doctor.mjs',
    'plugin/hooks/session-start.mjs',
    'plugin/hooks/lib/capabilities.mjs',
  ])
    check(existsSync(join(installed, relative)), `shipped: ${relative}`);

  // Every bin the manifest promises must resolve to a file that exists.
  const manifest = JSON.parse(
    readFileSync(join(installed, 'package.json'), 'utf8')
  );
  for (const [name, target] of Object.entries(manifest.bin || {}))
    check(
      existsSync(join(installed, target)),
      `bin target exists: ${name} -> ${target}`
    );

  // THE ENTRY POINTS MUST LOAD FROM THE INSTALLED TREE, not merely exist. An import that only
  // resolves against the repository layout fails here and nowhere else.
  for (const relative of [
    'dist/proxy/supervisor.js',
    'dist/proxy/default-routing.js',
    'hooks-core/capabilities.mjs',
    'scripts/managed-clients.mjs',
  ]) {
    try {
      execFileSync(
        process.execPath,
        [
          '--input-type=module',
          // A FILE URL, NOT A PATH. `import('C:\...')` is an unsupported URL scheme on Windows, so
          // a bare path fails here for a reason that has nothing to do with the package.
          '-e',
          `await import(${JSON.stringify(pathToFileURL(join(installed, relative)).href)})`,
        ],
        { encoding: 'utf8', env, stdio: 'pipe' }
      );
      check(true, `loads when installed: ${relative}`);
    } catch (error) {
      check(
        false,
        `loads when installed: ${relative}`,
        String(error.stderr || error).slice(0, 200)
      );
    }
  }

  // A LOCAL INSTALL DELIBERATELY WIRES NOTHING. postinstall.cjs skips setup for dependency and CI
  // installs, which is why this drives the documented recovery command instead -- that command is
  // what a user runs when lifecycle scripts were disabled, and it is the path that has to work.
  const beforeWiring = JSON.parse(readFileSync(settings, 'utf8'));
  check(
    Object.keys(beforeWiring.hooks || {}).length === 0,
    'a local install wires nothing on its own, as documented'
  );

  try {
    execFileSync(
      process.execPath,
      [join(installed, 'scripts', 'install-cli.mjs')],
      {
        encoding: 'utf8',
        env,
        stdio: 'pipe',
        timeout: 240_000,
      }
    );
    check(true, 'token-optimizer-install ran from the installed tree');
  } catch (error) {
    check(
      false,
      'token-optimizer-install ran from the installed tree',
      String(error.stderr || error.stdout || error).slice(0, 300)
    );
  }

  const wired = JSON.parse(readFileSync(settings, 'utf8'));
  const events = Object.keys(wired.hooks || {});
  check(
    events.length > 0,
    'the installer wired hooks into settings.json',
    events.join(', ')
  );
  check(
    JSON.stringify(wired.hooks || {}).includes('token-optimizer'),
    'the wired commands point at this package'
  );
  // Every wired command must name a file that exists, or the hook fails at the user's first turn.
  // Walked from the parsed object rather than matched out of JSON text: the commands are Windows
  // paths, and pulling them back through a regex over escaped JSON is its own source of defects.
  const scripts = [];
  const walk = (node) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (node && typeof node === 'object')
      return Object.values(node).forEach(walk);
    if (typeof node === 'string' && /\.(mjs|cjs|js)\b/.test(node))
      scripts.push(node);
  };
  walk(wired.hooks || {});
  const missing = scripts
    .map((command) => {
      const quoted = command.match(/"([^"]+\.(?:mjs|cjs|js))"/);
      return quoted ? quoted[1] : null;
    })
    .filter((file) => file && !existsSync(file));
  check(
    scripts.length > 0 && missing.length === 0,
    'every wired hook command exists on disk',
    missing.join(', ')
  );

  // The doctor is what a user runs when something looks wrong; it must at least run.
  try {
    const out = execFileSync(
      process.execPath,
      [join(installed, 'scripts', 'doctor.mjs')],
      { encoding: 'utf8', env, stdio: 'pipe', timeout: 240_000 }
    );
    check(
      /checks passed/.test(out),
      'token-optimizer-doctor produced a report',
      out.split('\n')[0]
    );
  } catch (error) {
    // A non-zero exit is normal -- an isolated sandbox is not a routed client. Producing a report is
    // the bar; crashing is not.
    const out = String(error.stdout || '') + String(error.stderr || '');
    check(
      /checks passed/.test(out),
      'token-optimizer-doctor produced a report',
      out.slice(-200)
    );
  }

  check(
    !existsSync(join(sandbox, 'home', 'proxy-supervisor.json')),
    'installation started no background service'
  );

  // INSTALLING IS NOT WORKING. Everything above proves the files arrived and load; none of it
  // proves the server starts and answers, which is the only thing a user actually needs. So this
  // speaks MCP to the installed copy over stdio -- the same transport a client uses -- and asks it
  // to list its tools.
  //
  // It runs here rather than against the registry because `npm pack` produces the exact bytes
  // `npm publish` uploads: testing the tarball is testing the release, and it can be done BEFORE
  // publishing rather than after, when a bad version is already the one people get.
  const REQUIRED_TOOLS = [
    'smart_read',
    'smart_grep',
    'smart_edit',
    'install_doctor',
  ];
  const mcp = await new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [join(installed, 'dist', 'server', 'index.js')],
      { env, stdio: ['pipe', 'pipe', 'pipe'] }
    );
    const outcome = {
      server: null,
      tools: [],
      stderr: '',
      timedOut: false,
      // NON-JSON LINES ARE A DEFECT, NOT NOISE. MCP's stdio transport reserves stdout for
      // newline-delimited JSON-RPC and nothing else, so a banner printed there is a protocol
      // violation a conforming client may reject outright. Skipping such a line quietly -- which
      // is what this did first -- would let exactly the kind of release this job exists to stop
      // walk straight through the gate. They are collected and asserted on instead.
      junk: [],
    };
    const timer = setTimeout(() => {
      outcome.timedOut = true;
      child.kill();
    }, 120_000);
    let buffer = '';
    child.stderr.on('data', (chunk) => {
      outcome.stderr += chunk;
    });
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      for (let nl; (nl = buffer.indexOf('\n')) !== -1;) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          if (line) outcome.junk.push(line);
          continue;
        }
        if (message.id === 1) {
          outcome.server = message.result?.serverInfo ?? null;
          child.stdin.write(
            `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`
          );
          child.stdin.write(
            `${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`
          );
        } else if (message.id === 2) {
          outcome.tools = (message.result?.tools ?? []).map((t) => t.name);
          child.kill();
        }
      }
    });
    child.on('error', (error) => {
      outcome.stderr += String(error);
    });
    child.on('exit', () => {
      clearTimeout(timer);
      resolve(outcome);
    });
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'fresh-install-verification', version: '0' },
        },
      })}\n`
    );
  });

  check(
    !mcp.timedOut,
    'the installed server answered within two minutes',
    mcp.stderr.slice(-200)
  );
  check(
    mcp.server !== null,
    'the installed server completed an MCP initialize',
    mcp.stderr.slice(-200)
  );
  check(
    mcp.junk.length === 0,
    'the installed server wrote only JSON-RPC to stdout',
    mcp.junk.slice(0, 3).join(' | ').slice(0, 200)
  );
  const missingTools = REQUIRED_TOOLS.filter((t) => !mcp.tools.includes(t));
  check(
    mcp.tools.length > 0 && missingTools.length === 0,
    `tools/list served the core tools (${mcp.tools.length} total)`,
    missingTools.length ? `missing ${missingTools.join(', ')}` : ''
  );
} catch (error) {
  check(
    false,
    'installation completed',
    String(error.stderr || error.message || error).slice(0, 400)
  );
} finally {
  if (keep) console.log(`\nsandbox kept at ${sandbox}`);
  else rmSync(sandbox, { recursive: true, force: true });
}

console.log('');
if (failures.length) {
  console.error(
    `fresh-install verification FAILED: ${failures.length} check(s)`
  );
  for (const f of failures) console.error(`  - ${f}`);
  process.exitCode = 1;
} else {
  console.log(
    'fresh-install verification passed: the packed tarball installs and runs.'
  );
}
