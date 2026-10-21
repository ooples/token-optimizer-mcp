/**
 * Reduce at the source: quiet defaults for the tools an agent runs.
 *
 * WHY. Progress bars, colour codes, version nags, funding and telemetry
 * banners are bytes the model reads and never acts on -- and every byte of a
 * tool result is re-read on every later call of the session. Making the tools
 * emit less costs nothing to compress and cannot mangle anything, because the
 * omitted text was never produced.
 *
 * PARITY, THEN SOME. HeadRoom's `wrap claude` sets this list (0.41.0
 * headroom/cli/wrap.py, _QUIET_CLI_DEFAULTS) but only for sessions launched
 * through its wrapper. A Claude Code SessionStart hook can append `export`
 * lines to the file named by CLAUDE_ENV_FILE, and every later Bash call of the
 * session sees them -- subagents included (verified on 2.1.302). So a plugin
 * install gets the defaults with no wrapper at all.
 *
 * ONLY ZERO-SIGNAL SWITCHES. Nothing here hides an error, a warning, a diff, a
 * test name or a search result: no blanket --quiet, no log levels, no CI=1 (it
 * changes what test runners DO, not just what they print). A value the user
 * already set always wins. TOKEN_OPTIMIZER_QUIET_ENV=0 turns the whole thing
 * off.
 */
import { appendFileSync } from 'node:fs';

/** name -> value, written only when the variable is absent. */
export const QUIET_ENV_DEFAULTS = Object.freeze({
  // Pager framing (the Bash tool is not a TTY, but some git configs force it).
  GIT_PAGER: 'cat',
  // pip: "Requirement already satisfied" chatter, the version nag, the bar.
  PIP_QUIET: '1',
  PIP_DISABLE_PIP_VERSION_CHECK: '1',
  PIP_PROGRESS_BAR: 'off',
  // npm: funding banner, audit summary, progress bar, update box.
  npm_config_fund: 'false',
  npm_config_audit: 'false',
  npm_config_progress: 'false',
  npm_config_update_notifier: 'false',
  // Telemetry pings and first-run banners (consoledonottrack.com and the
  // per-tool switches that predate it).
  DO_NOT_TRACK: '1',
  DOTNET_CLI_TELEMETRY_OPTOUT: '1',
  DOTNET_NOLOGO: '1',
  DOTNET_SKIP_FIRST_TIME_EXPERIENCE: '1',
  NEXT_TELEMETRY_DISABLED: '1',
  GATSBY_TELEMETRY_DISABLED: '1',
  ASTRO_TELEMETRY_DISABLED: '1',
  NG_CLI_ANALYTICS: 'false',
  HOMEBREW_NO_ENV_HINTS: '1',
  // Progress bars redrawn line by line into a captured log.
  CARGO_TERM_PROGRESS_WHEN: 'never',
  HF_HUB_DISABLE_PROGRESS_BARS: '1',
  // ANSI colour escapes: the no-color.org standard only removes colour.
  NO_COLOR: '1',
});

const OFF = /^(0|false|no|off)$/i;

export function quietEnvEnabled(env = process.env) {
  return !OFF.test(String(env.TOKEN_OPTIMIZER_QUIET_ENV ?? '').trim());
}

/** POSIX single-quoting: the env file is sourced by the Bash tool's shell. */
const quote = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;

/**
 * The export lines for every default the environment does not already set, plus
 * `-q` appended to PYTEST_ADDOPTS (augmented, never replaced) unless present.
 *
 * @returns {{ script: string, names: string[] }}
 */
export function quietEnvScript(env = process.env) {
  if (!quietEnvEnabled(env)) return { script: '', names: [] };
  const lines = [];
  const names = [];
  for (const [name, value] of Object.entries(QUIET_ENV_DEFAULTS)) {
    if (env[name] !== undefined) continue;
    lines.push(`export ${name}=${quote(value)}`);
    names.push(name);
  }
  const addopts = String(env.PYTEST_ADDOPTS ?? '');
  if (!addopts.split(/\s+/).includes('-q')) {
    lines.push(`export PYTEST_ADDOPTS=${quote(`${addopts} -q`.trim())}`);
    names.push('PYTEST_ADDOPTS');
  }
  return { script: lines.length ? `${lines.join('\n')}\n` : '', names };
}

/**
 * Append the defaults to Claude Code's session env file. A no-op for clients
 * that do not provide CLAUDE_ENV_FILE, and fail-open like every hook.
 *
 * @returns {string[]} the variables written
 */
export function applyQuietEnv(env = process.env) {
  const file = env.CLAUDE_ENV_FILE;
  if (!file) return [];
  const { script, names } = quietEnvScript(env);
  if (!script) return [];
  try {
    appendFileSync(file, script);
    return names;
  } catch {
    return [];
  }
}
