import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
const routingKeys = [
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_ANTHROPIC_AWS',
];
export function policyControlsRouting(policy) {
  return Boolean(
    policy &&
      typeof policy === 'object' &&
      policy.env &&
      routingKeys.some((key) => Object.hasOwn(policy.env, key))
  );
}

/** Detect locally delivered policy without copying it into lower-priority
 * settings or attempting to override it. Remote/MDM policy can still arrive
 * after launch; observed traffic remains the authoritative routing evidence.
 */
export async function claudeManagedRouting({
  platform = process.platform,
  directory,
  registry,
} = {}) {
  const root =
    directory ||
    (platform === 'win32'
      ? 'C:/Program Files/ClaudeCode'
      : platform === 'darwin'
        ? '/Library/Application Support/ClaudeCode'
        : '/etc/claude-code');
  const files = [join(root, 'managed-settings.json')];
  try {
    files.push(
      ...(await readdir(join(root, 'managed-settings.d')))
        .filter((name) => !name.startsWith('.') && name.endsWith('.json'))
        .map((name) => join(root, 'managed-settings.d', name))
    );
  } catch (error) {
    if (error.code !== 'ENOENT') return true;
  }
  for (const file of files) {
    try {
      if (
        policyControlsRouting(
          JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, ''))
        )
      )
        return true;
    } catch (error) {
      if (error.code !== 'ENOENT') return true;
    }
  }
  if (platform === 'win32') {
    const query =
      registry ||
      (async (hive) => {
        try {
          const result = await exec(
            'reg.exe',
            [
              'query',
              `${hive}\\SOFTWARE\\Policies\\ClaudeCode`,
              '/v',
              'Settings',
            ],
            { windowsHide: true, timeout: 2000, maxBuffer: 128 * 1024 }
          );
          const value = result.stdout.match(
            /Settings\s+REG_(?:EXPAND_)?SZ\s+([^\r\n]+)/i
          )?.[1];
          return value ? JSON.parse(value) : {};
        } catch (error) {
          // Missing registry keys normally exit 1. Claude still enforces policy
          // this best-effort preflight cannot read; traffic evidence detects bypass.
          if (error.code === 1) return {};
          return { env: { ANTHROPIC_BASE_URL: null } };
        }
      });
    const policies = await Promise.all(['HKLM', 'HKCU'].map(query));
    if (policies.some(policyControlsRouting)) return true;
  }
  return false;
}
