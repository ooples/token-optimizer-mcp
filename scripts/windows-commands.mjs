/** PATH launchers also work in cmd.exe and PowerShell with profiles disabled. */
import fs from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { replaceProfile } from './profile-file.mjs';
import { launcherCommands } from './managed-clients.mjs';

export const launcherMarker = 'rem token-optimizer managed launcher v1';
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const key = (value) =>
  value.replaceAll('/', '\\').replace(/\\+$/, '').toLowerCase();
const ps = (script) =>
  execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      Buffer.from(
        `$ProgressPreference='SilentlyContinue'; ${script}`,
        'utf16le'
      ).toString('base64'),
    ],
    { encoding: 'utf8', windowsHide: true }
  ).trim();

export const userPath = {
  read: () =>
    JSON.parse(
      ps(
        "ConvertTo-Json -Compress -InputObject ([Environment]::GetEnvironmentVariable('Path','User'))"
      )
    ) || '',
  write: (value) =>
    ps(
      `[Environment]::SetEnvironmentVariable('Path','${value.replaceAll("'", "''")}','User')`
    ),
};

export function activateWindowsCommands({
  root,
  remove = false,
  apply = true,
  env = process.env,
  platform = process.platform,
  directory = join(homedir(), '.token-optimizer', 'bin'),
  registry = userPath,
  clients,
} = {}) {
  if (
    platform !== 'win32' ||
    env.TOKEN_OPTIMIZER_SETTINGS ||
    env.TOKEN_OPTIMIZER_SHELL_PROFILES
  )
    return [];
  const recordPath = join(directory, 'launchers.json');
  const recordBytes = fs.existsSync(recordPath)
    ? fs.readFileSync(recordPath)
    : null;
  const previous = recordBytes ? JSON.parse(recordBytes) : {};
  const plans = [];
  const nextRecord = {};
  const wanted = clients ?? launcherCommands({ env, platform, directory });
  // Every launcher we have ever written is considered, not only the ones we would write today.
  // Uninstalling has to remove a `qwen.cmd` from a machine that has since dropped qwen, and a client
  // that disappears must not leave a wrapper pointing at a command that is no longer there.
  const considered = [
    ...new Set([
      ...wanted,
      ...Object.keys(previous).map((name) => name.replace(/\.cmd$/i, '')),
    ]),
  ];
  for (const client of considered) {
    const name = `${client}.cmd`;
    const file = join(directory, name);
    const before = fs.existsSync(file) ? fs.readFileSync(file) : null;
    if (before && digest(before) !== previous[name])
      throw new Error(`Managed launcher was edited or is not owned: ${file}`);
    // Batch expands percent signs even inside quotes; delayed expansion is off.
    const quote = (value) => {
      if (/["\r\n]/.test(value)) throw new Error('Unsupported launcher path.');
      return `"${value.replaceAll('%', '%%')}"`;
    };
    const after =
      remove || !wanted.includes(client)
        ? null
        : Buffer.from(
            [
              '@echo off',
              launcherMarker,
              'setlocal DisableDelayedExpansion',
              `${quote(process.execPath)} ${quote(join(root, 'scripts', 'run-client.mjs'))} ${client} %*`,
              'exit /b %errorlevel%',
              '',
            ].join('\r\n')
          );
    if (after) nextRecord[name] = digest(after);
    if (after ? !before?.equals(after) : before !== null)
      plans.push({ file, before, after });
  }
  const originalPath = registry.read();
  const entries = (originalPath ? originalPath.split(';') : []).filter(
    (entry) => key(entry) !== key(directory)
  );
  // An empty launcher directory has no reason to be on PATH, and leaving it there would shadow
  // nothing while still showing up in the user's environment.
  const serving = Object.keys(nextRecord).length > 0;
  const nextPath =
    remove || !serving ? entries.join(';') : [directory, ...entries].join(';');
  if (apply) {
    const recordAfter =
      remove || !serving
        ? null
        : Buffer.from(JSON.stringify(nextRecord, null, 2));
    const applied = [];
    const change = ({ file, before, after }) => {
      if (after) replaceProfile(file, before, after);
      else if (before) {
        if (!fs.readFileSync(file).equals(before))
          throw new Error(`Launcher changed during removal: ${file}`);
        fs.unlinkSync(file);
      }
    };
    try {
      for (const plan of [
        ...plans,
        { file: recordPath, before: recordBytes, after: recordAfter },
      ]) {
        change(plan);
        applied.push(plan);
      }
      if (nextPath !== originalPath) registry.write(nextPath);
    } catch (error) {
      const failures = [error];
      for (const { file, before, after } of applied.reverse()) {
        try {
          change({ file, before: after, after: before });
        } catch (rollbackError) {
          failures.push(rollbackError);
        }
      }
      throw new AggregateError(
        failures,
        'Windows command activation failed; unchanged files were rolled back.'
      );
    }
  }
  return [
    ...plans.map(({ file }) => file),
    ...(nextPath !== originalPath ? ['User PATH'] : []),
  ];
}
