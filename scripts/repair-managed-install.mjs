/** Refresh only unchanged, previously installed launchers/hooks after an MCP runtime upgrade. */
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { decodeProfile, replaceProfile } from './profile-file.mjs';
import { shellProfiles } from './managed-shell.mjs';

const digest = (text) => createHash('sha256').update(text).digest('hex');
const json = (path) => JSON.parse(readFileSync(path, 'utf8'));
const version = (value) =>
  /^\d+\.\d+\.\d+$/.test(value || '') ? value.split('.').map(Number) : null;
const newer = (a, b) => {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
};

export function repairManagedInstall({
  root = resolve(dirname(fileURLToPath(import.meta.url)), '..'),
  env = process.env,
  profiles = () => shellProfiles(env),
  directory = join(
    env.TOKEN_OPTIMIZER_HOME || join(homedir(), '.token-optimizer'),
    'bin'
  ),
  settingsPath = env.TOKEN_OPTIMIZER_SETTINGS ||
    join(homedir(), '.claude', 'settings.json'),
} = {}) {
  // A version pin is an explicit choice. Do not turn it into a global migration.
  if (
    env.TOKEN_OPTIMIZER_VERSION ||
    /^(0|false|no|off)$/i.test(env.TOKEN_OPTIMIZER_AUTO_REPAIR || '') ||
    String(env.TOKEN_OPTIMIZER_MODE).trim().toLowerCase() === 'off'
  )
    return [];
  const target = version(json(join(root, 'package.json')).version);
  if (!target) return [];
  const changed = [];
  const attempt = (fn) => {
    try {
      fn();
    } catch {
      /* preserve unreadable or user-edited state */
    }
  };
  const upgrade = (path, suffix) => {
    const oldRoot = path.slice(0, -suffix.length);
    if (resolve(oldRoot) === resolve(root)) return path;
    if (existsSync(join(oldRoot, 'package.json'))) {
      const pkg = json(join(oldRoot, 'package.json'));
      const old = version(pkg.version);
      if (
        pkg.name !== '@ooples/token-optimizer-mcp' ||
        !old ||
        !newer(target, old)
      )
        return path;
    }
    const next = join(root, suffix).replaceAll('\\', '/');
    return existsSync(next) ? next : path;
  };
  const launcher = (text) =>
    text.replace(
      /(['"])([^'"\r\n]+[/\\]scripts[/\\]run-client\.mjs)\1/g,
      (whole, quote, path) => {
        // Shell escaping is deliberately not reconstructed during automatic repair.
        if (/[%'`$]/.test(path) || /[%'`$]/.test(root)) return whole;
        return `${quote}${upgrade(path, 'scripts/run-client.mjs')}${quote}`;
      }
    );
  if (!/^(0|false|no|off)$/i.test(env.TOKEN_OPTIMIZER_MANAGED_CLIENTS || '')) {
    attempt(() => {
      for (const path of profiles())
        attempt(() => {
          if (!existsSync(path)) return;
          const before = readFileSync(path);
          const decoded = decodeProfile(before);
          const pattern =
            /# >>> token-optimizer managed clients >>>\r?\n([\s\S]*?)\r?\n# token-optimizer sha256: ([a-f0-9]{64})\r?\n# <<< token-optimizer managed clients <<</g;
          const matches = [...decoded.text.matchAll(pattern)];
          if (matches.length !== 1) return;
          const [whole, body, hash] = matches[0];
          const normalized = body.replaceAll('\r\n', '\n');
          if (digest(normalized) !== hash) return;
          const next = launcher(body);
          if (next === body) return;
          const block = whole
            .replace(body, next)
            .replace(hash, digest(next.replaceAll('\r\n', '\n')));
          const updated = decoded.text.replace(whole, block);
          let bytes = decoded.encode(updated);
          // Windows PowerShell needs a BOM when an upgraded package path introduces Unicode.
          if (
            path.endsWith('.ps1') &&
            /[^\x00-\x7f]/.test(updated) &&
            !(bytes[0] === 0xff && bytes[1] === 0xfe) &&
            !bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))
          )
            bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes]);
          replaceProfile(path, before, bytes);
          changed.push(path);
        });
    });
    attempt(() => {
      const recordPath = join(directory, 'launchers.json');
      if (!existsSync(recordPath)) return;
      let recordBytes = readFileSync(recordPath);
      const record = JSON.parse(recordBytes.toString('utf8'));
      for (const name of Object.keys(record))
        attempt(() => {
          if (!/^[a-z][a-z0-9-]*\.cmd$/.test(name)) return;
          const path = join(directory, name);
          if (!existsSync(path)) return;
          const before = readFileSync(path);
          if (digest(before) !== record[name]) return;
          const after = Buffer.from(launcher(before.toString('utf8')));
          if (before.equals(after)) return;
          const nextRecord = Buffer.from(
            JSON.stringify({ ...record, [name]: digest(after) }, null, 2)
          );
          replaceProfile(path, before, after);
          try {
            replaceProfile(recordPath, recordBytes, nextRecord);
          } catch (error) {
            replaceProfile(path, after, before);
            throw error;
          }
          record[name] = digest(after);
          recordBytes = nextRecord;
          changed.push(path);
        });
    });
  }
  attempt(() => {
    if (!existsSync(settingsPath)) return;
    const before = readFileSync(settingsPath);
    const settings = JSON.parse(before.toString('utf8'));
    let edited = false;
    for (const groups of Object.values(settings.hooks || {})) {
      if (!Array.isArray(groups)) continue;
      for (const group of groups)
        for (const hook of group.hooks || []) {
          if (hook.type !== 'command' || typeof hook.command !== 'string')
            continue;
          const match = hook.command.match(
            /^node "(.+[/\\]plugin[/\\]hooks[/\\](session-start|pretooluse-router|post-tool|precompact-optimize|stop)\.mjs)" --token-optimizer-hook$/
          );
          if (!match) continue;
          const next = upgrade(match[1], `plugin/hooks/${match[2]}.mjs`);
          if (next === match[1]) continue;
          hook.command = `node "${next}" --token-optimizer-hook`;
          edited = true;
        }
    }
    if (edited) {
      replaceProfile(
        settingsPath,
        before,
        Buffer.from(`${JSON.stringify(settings, null, 2)}\n`)
      );
      changed.push(settingsPath);
    }
  });
  return changed;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  repairManagedInstall();
}
