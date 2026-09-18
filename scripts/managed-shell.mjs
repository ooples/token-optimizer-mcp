/** Reversible shell activation. Client binaries and provider files stay intact. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { decodeProfile, replaceProfile } from './profile-file.mjs';
import {
  LEGACY_LAUNCHER_COMMANDS,
  launcherCommands,
} from './managed-clients.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const begin = '# >>> token-optimizer managed clients >>>';
const end = '# <<< token-optimizer managed clients <<<';
const quoteSh = (text) => `'${text.replaceAll("'", "'\\''")}'`;
const quotePs = (text) => `'${text.replaceAll("'", "''")}'`;

export function bashLoginProfile(home) {
  return (
    ['.bash_profile', '.bash_login', '.profile']
      .map((name) => join(home, name))
      .find(existsSync) || join(home, '.profile')
  );
}

export function shellProfiles(env = process.env) {
  if (env.TOKEN_OPTIMIZER_SHELL_PROFILES)
    return JSON.parse(env.TOKEN_OPTIMIZER_SHELL_PROFILES);
  // Isolated hook-install checks must not touch the operator's shell profiles.
  if (env.TOKEN_OPTIMIZER_SETTINGS) return [];
  if (process.platform === 'win32') {
    const documents = execFileSync(
      'powershell',
      ['-NoProfile', '-Command', "[Environment]::GetFolderPath('MyDocuments')"],
      { encoding: 'utf8', windowsHide: true }
    ).trim();
    if (!documents)
      throw new Error('Cannot locate the PowerShell profile directory.');
    return ['PowerShell', 'WindowsPowerShell'].map((shell) =>
      join(documents, shell, 'Microsoft.PowerShell_profile.ps1')
    );
  }
  // Bash reads only the first existing login profile. Creating .bash_profile
  // would suppress the user's .bash_login/.profile (including PATH setup).
  const login = bashLoginProfile(homedir());
  return [
    join(homedir(), '.bashrc'),
    login,
    join(env.ZDOTDIR || homedir(), '.zshrc'),
  ];
}

export function activateShells({
  remove = false,
  apply = true,
  env = process.env,
  clients = launcherCommands({ env }),
} = {}) {
  const changed = [];
  const plans = [];
  for (const path of shellProfiles(env)) {
    const bytes = existsSync(path) ? readFileSync(path) : null;
    const decoded = decodeProfile(bytes || Buffer.alloc(0));
    const original = decoded.text;
    const start = original.indexOf(begin);
    const finish = original.indexOf(end);
    if (start < 0 !== finish < 0 || (start >= 0 && finish < start))
      throw new Error(
        `Incomplete token-optimizer activation block in ${path}; repair it before installing.`
      );
    if (
      start >= 0 &&
      (original.indexOf(begin, start + begin.length) >= 0 ||
        original.indexOf(end, finish + end.length) >= 0)
    )
      throw new Error(
        `Duplicate token-optimizer activation blocks in ${path}; profile left unchanged.`
      );
    const powershell = path.endsWith('.ps1');
    const quote = powershell ? quotePs : quoteSh;
    const invocation = `${quote(process.execPath)} ${quote(join(root, 'scripts', 'run-client.mjs'))}`;
    const define = (names) =>
      names
        .map((client) =>
          powershell
            ? `function global:${client} { & ${invocation} ${client} @args }`
            : `${client}() { ${invocation} ${client} "$@"; }`
        )
        .join('\n');
    const functions = define(clients);
    const digest = (text) => createHash('sha256').update(text).digest('hex');
    // The blocks earlier versions wrote carried no checksum, so they are recognised by their exact
    // text. That text is the CLIENTS THEY WRAPPED, not whatever this machine wraps today: deriving
    // it from `functions` would stop recognising our own old block the moment the list changed, and
    // the user would be told their profile had been edited by hand.
    const previous = define(LEGACY_LAUNCHER_COMMANDS);
    const legacy = `${begin}\n${previous}\n${end}`;
    const legacyTwoClients = `${begin}\n${previous.split('\n').slice(0, 2).join('\n')}\n${end}`;
    // No client on this machine means no block: an empty one would define nothing and still have to
    // be explained to whoever opens the profile.
    const block =
      remove || clients.length === 0
        ? ''
        : `${begin}\n${functions}\n# token-optimizer sha256: ${digest(functions)}\n${end}`;
    if (start >= 0) {
      const existing = original
        .slice(start, finish + end.length)
        .replaceAll('\r\n', '\n');
      // The checksum protects ownership, not authenticity: user edits are kept.
      const match = existing.match(
        /^# >>> token-optimizer managed clients >>>\n([\s\S]*)\n# token-optimizer sha256: ([a-f0-9]{64})\n# <<< token-optimizer managed clients <<<$/
      );
      if (
        existing !== legacy &&
        existing !== legacyTwoClients &&
        (!match || digest(match[1]) !== match[2])
      )
        throw new Error(
          `Managed activation was edited in ${path}; refusing to overwrite or remove user changes.`
        );
    }
    const next =
      start < 0
        ? remove
          ? original
          : `${original}${original.endsWith('\n') || !original ? '' : '\n'}${block}\n`
        : original.slice(0, start) +
          block +
          original.slice(finish + end.length);
    if (next === original) continue;
    changed.push(path);
    let encoded = decoded.encode(next);
    // Windows PowerShell interprets BOM-less scripts as the legacy codepage.
    // Add a UTF-8 BOM when an otherwise UTF-8 profile contains non-ASCII text.
    if (
      powershell &&
      /[^\x00-\x7f]/.test(next) &&
      !(encoded[0] === 0xff && encoded[1] === 0xfe) &&
      !encoded.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))
    )
      encoded = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), encoded]);
    plans.push({ path, bytes, next: encoded });
  }
  // Check every profile's ownership and encoding before changing any of them.
  if (apply) {
    for (const { path, bytes, next } of plans) {
      mkdirSync(dirname(path), { recursive: true });
      if (existsSync(path) && !existsSync(`${path}.before-token-optimizer`))
        writeFileSync(`${path}.before-token-optimizer`, bytes, {
          flag: 'wx',
          mode: 0o600,
        });
      replaceProfile(path, bytes, next);
    }
  }
  return changed;
}
