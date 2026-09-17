/** Add the startup budget to an existing MCP registration, preserving other TOML. */
import fs from 'node:fs';
import TOML from '@iarna/toml';
import { isDeepStrictEqual } from 'node:util';
import { replaceProfile } from './profile-file.mjs';

export function repairCodexStartup(file) {
  if (!fs.existsSync(file)) return false;
  const before = fs.readFileSync(file);
  const text = before.toString('utf8');
  const config = TOML.parse(text);
  const server = config.mcp_servers?.['token-optimizer'];
  if (!server || server.enabled === false || server.startup_timeout_sec !== undefined || server.startup_timeout_ms !== undefined) return false;
  // Only edit a standard table we can identify unambiguously. Parsing first
  // prevents corrupting invalid input; semantic comparison checks the output.
  const header = /^(\s*\[\s*mcp_servers\s*\.\s*(?:token-optimizer|"token-optimizer"|'token-optimizer')\s*\][^\r\n]*)(\r?\n|$)/m;
  if (!header.test(text)) throw new Error('Cannot safely locate the token-optimizer MCP table.');
  const next = text.replace(header, (_, line, ending) => `${line}${ending || '\n'}startup_timeout_sec = 60${ending || '\n'}`);
  server.startup_timeout_sec = 60;
  if (!isDeepStrictEqual(TOML.parse(next), config))
    throw new Error('Codex startup repair would change unrelated configuration.');
  if (!fs.existsSync(`${file}.before-token-optimizer-startup`))
    fs.writeFileSync(`${file}.before-token-optimizer-startup`, before, { flag: 'wx', mode: 0o600 });
  replaceProfile(file, before, Buffer.from(next));
  return true;
}
