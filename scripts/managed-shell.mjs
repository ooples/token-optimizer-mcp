/** Reversible shell activation. Client binaries and provider files stay intact. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const begin = '# >>> token-optimizer managed clients >>>';
const end = '# <<< token-optimizer managed clients <<<';
const quoteSh = text => `'${text.replaceAll("'", "'\\''")}'`;
const quotePs = text => `'${text.replaceAll("'", "''")}'`;

export function shellProfiles(env = process.env) {
  if (env.TOKEN_OPTIMIZER_SHELL_PROFILES) return JSON.parse(env.TOKEN_OPTIMIZER_SHELL_PROFILES);
  // Isolated hook-install checks must not touch the operator's shell profiles.
  if (env.TOKEN_OPTIMIZER_SETTINGS) return [];
  if (process.platform === 'win32') {
    const documents = execFileSync('powershell', ['-NoProfile', '-Command', "[Environment]::GetFolderPath('MyDocuments')"], { encoding: 'utf8', windowsHide: true }).trim();
    if (!documents) throw new Error('Cannot locate the PowerShell profile directory.');
    return ['PowerShell', 'WindowsPowerShell'].map(shell => join(documents, shell, 'Microsoft.PowerShell_profile.ps1'));
  }
  return [join(homedir(), '.bashrc'), join(homedir(), '.bash_profile'), join(env.ZDOTDIR || homedir(), '.zshrc')];
}

export function activateShells({ remove = false, apply = true, env = process.env } = {}) {
  const changed = [];
  for (const path of shellProfiles(env)) {
    const original = existsSync(path) ? readFileSync(path, 'utf8') : '';
    const start = original.indexOf(begin);
    const finish = original.indexOf(end);
    if ((start < 0) !== (finish < 0) || (start >= 0 && finish < start))
      throw new Error(`Incomplete token-optimizer activation block in ${path}; repair it before installing.`);
    const powershell = path.endsWith('.ps1');
    const quote = powershell ? quotePs : quoteSh;
    const invocation = `${quote(process.execPath)} ${quote(join(root, 'scripts', 'run-client.mjs'))}`;
    const functions = ['claude', 'codex'].map(client => powershell
      ? `function global:${client} { & ${invocation} ${client} @args }`
      : `${client}() { ${invocation} ${client} "$@"; }`).join('\n');
    const block = remove ? '' : `${begin}\n${functions}\n${end}`;
    const next = start < 0
      ? (remove ? original : `${original}${original.endsWith('\n') || !original ? '' : '\n'}${block}\n`)
      : original.slice(0, start) + block + original.slice(finish + end.length);
    if (next === original) continue;
    changed.push(path);
    if (apply) {
      mkdirSync(dirname(path), { recursive: true });
      if (existsSync(path) && !existsSync(`${path}.before-token-optimizer`))
        writeFileSync(`${path}.before-token-optimizer`, original, { flag: 'wx' });
      writeFileSync(path, next);
    }
  }
  return changed;
}
