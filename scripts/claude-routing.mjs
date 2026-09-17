import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

function argument(args, name) {
  let result;
  for (let i = 0; i < args.length && args[i] !== '--'; i++) {
    if (args[i] === name) {
      const value = args[i + 1];
      if (value === undefined || value.startsWith('--'))
        throw new Error(`${name} needs a value.`);
      result = { index: ++i, value, inline: false };
    }
    else if (args[i].startsWith(`${name}=`))
      result = {
        index: i,
        value: args[i].slice(name.length + 1),
        inline: true,
      };
  }
  return result;
}
const read = (path) =>
  existsSync(path)
    ? JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''))
    : {};

export function claudeRoute(args, env, projectRoot) {
  const sources = (
    argument(args, '--setting-sources')?.value ?? 'user,project,local'
  ).split(',');
  let effective = { ...env };
  const locations = {
    user: join(
      env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'),
      'settings.json'
    ),
    project: join(projectRoot, '.claude/settings.json'),
    local: join(projectRoot, '.claude/settings.local.json'),
  };
  for (const source of ['user', 'project', 'local'])
    if (sources.includes(source))
      effective = { ...effective, ...read(locations[source]).env };
  const settings = argument(args, '--settings');
  let explicit = {};
  if (settings) {
    if (!settings.value) throw new Error('--settings needs a value.');
    // Missing explicit files are errors, unlike optional default settings.
    explicit = settings.value.trim().startsWith('{')
      ? JSON.parse(settings.value)
      : JSON.parse(readFileSync(settings.value, 'utf8').replace(/^\uFEFF/, ''));
    effective = { ...effective, ...explicit.env };
  }
  const external = [
    'CLAUDE_CODE_USE_BEDROCK',
    'CLAUDE_CODE_USE_VERTEX',
    'CLAUDE_CODE_USE_FOUNDRY',
    'CLAUDE_CODE_USE_ANTHROPIC_AWS',
  ].some((key) =>
    /^(1|true|yes|on)$/i.test(String(effective[key] || '').trim())
  );
  const upstream = effective.ANTHROPIC_BASE_URL || 'https://api.anthropic.com';
  let origin;
  if (!external) {
    try {
      const parsed = new URL(upstream);
      if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error();
      origin = parsed.origin;
    } catch {
      throw new Error('ANTHROPIC_BASE_URL must be an absolute HTTP or HTTPS URL.');
    }
  }
  // Loopback routing must not turn off Claude's first-party MCP deferral.
  // Preserve explicit user/settings choices and third-party gateway behavior.
  const preserveToolSearch =
    !external &&
    effective.ENABLE_TOOL_SEARCH === undefined &&
    origin === 'https://api.anthropic.com';
  return {
    upstream,
    preserveToolSearch,
    external,
    explicit,
    settings,
  };
}
