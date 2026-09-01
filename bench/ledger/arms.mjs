/**
 * What an arm IS: a settings file and an environment, nothing more.
 *
 * No arm-specific code path exists anywhere in this harness. That is a
 * deliberate constraint rather than an accident of design: the moment the
 * runner knows which arm it is running, the benchmark can favour one, and no
 * reader could rule it out. An arm here is data an operator could write by
 * hand and hand to `claude --settings`, so a result is reproducible without
 * trusting us.
 */

import { readFileSync } from 'node:fs';

/** Vanilla Claude Code. No hooks, no MCP server, no optimizer. */
export const control = {
  name: 'control',
  settings: {},
  env: {
    // Stated rather than assumed: with nothing installed there is no inventory
    // to fabricate, and an explicit empty value cannot be topped up by a
    // package that happens to be present in the image.
    TOKEN_OPTIMIZER_MCP_CAPABILITIES: '',
    TOKEN_OPTIMIZER_MODE: 'off',
  },
};

const HOOK = (event, script) => ({
  [event]: [
    {
      hooks: [
        {
          type: 'command',
          command: `node "/usr/local/lib/node_modules/@ooples/token-optimizer-mcp/plugin/hooks/${script}"`,
        },
      ],
    },
  ],
});

/** The hook set the product installs. */
const optimizerHooks = {
  ...HOOK('SessionStart', 'session-start.mjs'),
  PreToolUse: [
    {
      matcher: 'Read|Grep|Glob|Edit|MultiEdit|Write|Bash|PowerShell',
      hooks: [
        {
          type: 'command',
          command:
            'node "/usr/local/lib/node_modules/@ooples/token-optimizer-mcp/plugin/hooks/pretooluse-router.mjs"',
        },
      ],
    },
  ],
  ...HOOK('PostToolUse', 'post-tool.mjs'),
  ...HOOK('Stop', 'stop.mjs'),
  ...HOOK('PreCompact', 'pre-compact.mjs'),
};

/**
 * The product as we intend to ship it: hooks on, refusals off, no MCP server.
 *
 * `assist` is the posture worth measuring. Enforcement refuses a call and costs
 * a whole turn to redirect it, which on a cost benchmark is the most expensive
 * thing an optimizer can do -- so the interesting question is what the hooks
 * are worth WITHOUT that.
 */
export const assist = {
  name: 'assist',
  settings: { hooks: optimizerHooks },
  env: {
    TOKEN_OPTIMIZER_MODE: 'assist',
    TOKEN_OPTIMIZER_MCP_CAPABILITIES: '',
    TOKEN_OPTIMIZER_RUNTIME: '/opt/token-optimizer-runtime',
    TOKEN_OPTIMIZER_REFRESH_INTERVAL_MS: '999999999999',
  },
};

/**
 * assist with the project index disabled.
 *
 * The A/B partner for the search advisory: identical in every other respect,
 * so the difference between them is the seed and nothing else.
 */
export const assistNoSeed = {
  name: 'assist-noseed',
  settings: assist.settings,
  env: { ...assist.env, TOKEN_OPTIMIZER_SEED: '0' },
};

export const ARMS = { control, assist, 'assist-noseed': assistNoSeed };

/** Loads extra arms from a JSON file, so an outsider can add their own. */
export function loadArms(path) {
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  const out = {};
  for (const [name, arm] of Object.entries(raw)) {
    if (!arm || typeof arm !== 'object') throw new Error(`arm ${name} is not an object`);
    out[name] = { name, settings: arm.settings ?? {}, env: arm.env ?? {} };
  }
  return out;
}
