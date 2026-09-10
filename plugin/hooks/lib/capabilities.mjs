// GENERATED FILE -- do not edit.
// Source of truth: hooks-core/capabilities.mjs. Regenerate with `npm run sync:hooks`.
/**
 * The product's honest cross-client capability contract.
 *
 * A client is listed at the strongest surface its public lifecycle protocol can
 * actually support.  This registry is consumed by the adapter, certification
 * tooling, and evidence reports so a rules-only integration can never be
 * presented as equivalent to a native stop-continuation integration.
 */

export const CAPABILITY_TIERS = Object.freeze({
  CONTINUATION: 'lifecycle-continuation',
  OBSERVATION: 'native-observation',
  RULES: 'mcp-rules',
});

/**
 * MCP tools whose presence changes hook behaviour.
 *
 * A hook and an MCP server are separate processes. Installing both does not
 * prove that the current host registered the server's schemas: the server may
 * have failed to start, the host may have disabled it, or a bounded tool
 * profile may deliberately omit the file tools. The old hook treated install
 * intent as runtime fact and could deny Grep only to point at a `smart_grep`
 * schema the model did not have.
 *
 * Keep this list deliberately smaller than the full catalog. These are the
 * names a lifecycle hook may mention or substitute, so these are the names for
 * which it needs positive inventory evidence.
 */
export const HOOK_MCP_TOOLS = Object.freeze([
  'smart_read',
  'smart_write',
  'smart_edit',
  'smart_glob',
  'smart_grep',
  'optimize_session',
  'get_optimization_report',
  'wiki_write',
  // The read side of the graph. The session index tells the model to "call
  // wiki_query with a key for detail", so the hook needs positive evidence that
  // the name it is advertising is actually registered in this host.
  'wiki_query',
]);

const HOOK_MCP_TOOL_SET = new Set(HOOK_MCP_TOOLS);
const INVENTORY_KEYS = new Set([
  'availabletools',
  'mcptools',
  'registeredtools',
  'toolinventory',
  'toolnames',
]);
const INVENTORY_CONTAINERS = new Set([
  'capabilities',
  'context',
  'mcp',
  'session',
]);

/** Convert a host-qualified MCP name back to the schema name. */
function optimizerToolName(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  for (const name of HOOK_MCP_TOOLS) {
    if (
      normalized === name ||
      normalized.endsWith(`__${name}`) ||
      normalized.endsWith(`.${name}`) ||
      normalized.endsWith(`/${name}`) ||
      normalized.endsWith(`:${name}`)
    )
      return name;
  }
  return null;
}

function addInventoryValue(value, names) {
  if (Array.isArray(value)) {
    for (const item of value) addInventoryValue(item, names);
    return;
  }
  if (typeof value === 'string') {
    // Environment configuration commonly uses either CSV or JSON. A host
    // payload normally supplies one name per array item; accepting both shapes
    // keeps the explicit contract portable without guessing from prose.
    let parsed = null;
    if (/^\s*\[/.test(value)) {
      try {
        parsed = JSON.parse(value);
      } catch {
        parsed = null;
      }
    }
    if (Array.isArray(parsed)) {
      addInventoryValue(parsed, names);
      return;
    }
    for (const item of value.split(/[\s,]+/)) {
      const name = optimizerToolName(item);
      if (name) names.add(name);
    }
    return;
  }
  if (value && typeof value === 'object') {
    const name = optimizerToolName(
      value.name ?? value.tool_name ?? value.toolName
    );
    if (name) names.add(name);
  }
}

/**
 * Extract positive, tool-by-tool registration evidence supplied by the host.
 *
 * `proven: false` is intentionally different from an empty proven inventory.
 * Both fail open, but the distinction lets a SessionStart inventory be carried
 * into later hook processes only when the host actually supplied one. The
 * TOKEN_OPTIMIZER_MCP_CAPABILITIES environment variable is the portable escape
 * hatch for hosts whose hook payload has no inventory field; it must enumerate
 * exact registered names and is never inferred from TOOL_PROFILE.
 */
export function optimizerToolEvidence(raw = {}, env = process.env) {
  const hostNames = new Set();
  let hostProven = false;

  const visit = (value, depth = 0) => {
    if (!value || typeof value !== 'object' || depth > 3) return;
    for (const [key, child] of Object.entries(value)) {
      const normalized = key.replace(/[_-]/g, '').toLowerCase();
      if (INVENTORY_KEYS.has(normalized)) {
        hostProven = true;
        addInventoryValue(child, hostNames);
      } else if (INVENTORY_CONTAINERS.has(normalized)) {
        visit(child, depth + 1);
      }
    }
  };
  visit(raw);

  // A current host inventory is stronger than a bundled/install-time default.
  // In particular, a proven empty inventory means the server failed or was
  // disabled for this session and must keep native tools available.
  if (hostProven) return { proven: true, names: hostNames };

  const names = new Set();
  const proven = Object.prototype.hasOwnProperty.call(
    env,
    'TOKEN_OPTIMIZER_MCP_CAPABILITIES'
  );
  if (proven)
    addInventoryValue(env.TOKEN_OPTIMIZER_MCP_CAPABILITIES, names);
  return { proven, names };
}

/** Rehydrate the most recently proven inventory for this exact hook session. */
export function optimizerToolsForHook(raw, state = {}, env = process.env) {
  const current = optimizerToolEvidence(raw, env);
  if (current.proven) return current;
  if (
    Number.isFinite(state.optimizerToolsObservedAt) &&
    state.optimizerToolsObservedAt > 0 &&
    Array.isArray(state.optimizerTools)
  ) {
    return {
      proven: true,
      names: new Set(
        state.optimizerTools.filter((name) => HOOK_MCP_TOOL_SET.has(name))
      ),
    };
  }
  return { proven: false, names: new Set() };
}

/** Persist a proven inventory on the state object used by later hook events. */
export function rememberOptimizerTools(
  state,
  evidence,
  observedAt = Date.now()
) {
  if (!state || !evidence?.proven) return state;
  state.optimizerTools = [...evidence.names]
    .filter((name) => HOOK_MCP_TOOL_SET.has(name))
    .sort();
  state.optimizerToolsObservedAt = observedAt;
  return state;
}

const native = (profile) => ({
  structuralCapture: 'native',
  findingDelivery: 'native',
  routing: 'native-veto',
  ...profile,
});

/**
 * How each client is pointed at a local compression proxy.
 *
 * THE PROXY IS OPT-IN AND THE CLIENT HAS TO BE TOLD, so this is the table that
 * says how. Every one of these reads a base-URL variable; the name differs per
 * client, and getting it wrong is silent -- the agent talks straight to the
 * provider, the user sees no savings, and nothing reports an error. probeProxy
 * in doctor.mjs exists to make that state visible.
 *
 * VERIFIED means the variable was confirmed against the client. DOCUMENTED
 * means it comes from the vendor and has not been exercised here -- the same
 * distinction CLIENT_HARVEST_CLI draws, for the same reason: a wrong
 * DOCUMENTED row should fail loudly in doctor rather than look like it works.
 *
 * A null means the client offers no supported way to redirect its model
 * traffic, so the proxy cannot serve it and says so.
 */
export const CLIENT_PROXY_ENV = Object.freeze({
  // VERIFIED: Claude Code reads ANTHROPIC_BASE_URL for its provider, and this
  // package's own harvest already relies on endpoint redirection working.
  'claude-code': 'ANTHROPIC_BASE_URL',
  // DOCUMENTED: OpenAI-compatible clients read OPENAI_BASE_URL; codex also
  // accepts a model_provider base_url in its config file.
  codex: 'OPENAI_BASE_URL',
  // VERIFIED AGAINST THE INSTALLED CLI, and it was wrong before. Copilot was
  // mapped to OPENAI_BASE_URL because it speaks an OpenAI-shaped API, which
  // is the kind of inference that produces a doctor reporting success while
  // the client talks straight past the proxy -- the exact silent failure this
  // whole diagnostic exists to catch.
  //
  // In @github/copilot's bundle, COPILOT_API_URL is what reaches
  // `setCopilotUrl(...)` and is read again in the auth path as the host an
  // env-provided token belongs to: it is the provider endpoint.
  // OPENAI_BASE_URL reaches `setOpenAiBaseUrl(...)`, which is the
  // Azure/OpenAI-direct configuration, and is otherwise only the bundled
  // OpenAI SDK constructor default. Redirecting it does not move Copilot
  // traffic. (A review asked for COPILOT_PROVIDER_BASE_URL; that name does
  // not occur anywhere in the shipped bundle.)
  copilot: 'COPILOT_API_URL',
  gemini: 'GOOGLE_GEMINI_BASE_URL',
  qwen: 'OPENAI_BASE_URL',
  opencode: 'OPENAI_BASE_URL',
  crush: 'OPENAI_BASE_URL',
  droid: 'OPENAI_BASE_URL',
  amp: 'AMP_URL',
  continue: 'OPENAI_BASE_URL',

  // Editor-hosted clients route model traffic through the extension host and
  // expose no documented redirect. Declaring null keeps that a stated fact
  // rather than an omission, exactly as the harvest table does.
  cursor: null,
  cline: null,
  windsurf: null,
  kilo: null,
  roo: null,
  zed: null,
});

/**
 * How each client's own CLI can be driven headlessly, when it has one.
 *
 * THE HARVEST MODEL IS THE HOST ITSELF. Semantic extraction has always
 * needed an API key or a local endpoint, and on a machine with neither it
 * simply does not run -- measured on this one, 3 harvested findings against
 * 237 written by the agent. But the client that just ran the session is
 * installed BY DEFINITION and every one of these ships a headless mode, so
 * the model was already on the machine. Nothing needed configuring; it only
 * needed asking.
 *
 * ONE ROW PER CLIENT, not a hardcoded backend list. The nearest competitor
 * picks from three (claude, gemini, codex), so its Cursor, Zed, Amp, Crush
 * or Droid users get no semantic harvest at all. Every client this package
 * supports gets a row here or an explicit null, and `npm run sync:hooks`
 * copies the same table into all 16 integrations so the design cannot drift
 * per client.
 *
 * NEVER ANOTHER VENDOR'S CLI. Reaching for whatever happens to be on PATH
 * would send this session's digest to a model the user never chose, which is
 * a disclosure they did not agree to. The host is the only defensible
 * default, and TOKEN_OPTIMIZER_HARVEST_CLI_COMMAND is the only way to pick a
 * different one.
 *
 * DELIVERY IS PART OF THE ROW because the CLIs genuinely differ, and getting
 * it wrong is silent:
 *   - 'stdin'       the whole payload goes to the child's stdin.
 *   - 'arg-stdin'   a short instruction is the final argument and the digest
 *                   goes to stdin, for CLIs whose prompt flag needs a value
 *                   but which still read stdin.
 *   - 'prompt-file' the payload is written to a temp file and the final
 *                   argument tells the agent to read it, for CLIs that do
 *                   not read stdin at all.
 *
 * WHY A FILE AND NOT JUST A LONG ARGUMENT. Passing the payload itself as an
 * argument was tried and abandoned on evidence. On POSIX it is fine; on
 * Windows every one of these installs as a .cmd shim, which Node will not
 * spawn without a shell, and cmd.exe cannot carry a newline inside an
 * argument at all. Routing through PowerShell with the payload base64-encoded
 * got past cmd.exe and then hit PowerShell 5.1's native-argument binder,
 * which does not escape embedded double quotes: the prompt is JSON, so the
 * first `\"type\":` ended the quoting and the child received 32 arguments
 * instead of 1. A path has no spaces we did not choose, no quotes and no
 * newlines, and it also lifts the ARG_MAX ceiling entirely -- these are
 * agentic CLIs whose whole purpose is reading files, and the route is
 * verified: copilot asked to read a payload file returned the exact array.
 *
 * VERIFIED means a probe was executed against the installed CLI in this
 * repository and its reply parsed. DOCUMENTED means the shape comes from the
 * vendor's own `--help` or published headless docs and has not been executed
 * here, because the CLI is not installed on this machine. Both ship; the
 * distinction is recorded so nobody mistakes the second for the first, and a
 * wrong DOCUMENTED row fails loudly through `harvestFailure()` and doctor
 * rather than silently producing nothing.
 */
const harvestCli = (command, args, { delivery = 'stdin', verified = false } = {}) =>
  Object.freeze({ command, args: Object.freeze([...args]), delivery, verified });

export const CLIENT_HARVEST_CLI = Object.freeze({
  // VERIFIED: `claude -p` with the payload on stdin returned the exact array
  // asked for. --output-format stream-json was tried first and rejected: its
  // envelopes are themselves JSON containing brackets, which is a parsing
  // hazard for no gain when plain text is already the model's reply.
  'claude-code': harvestCli('claude', ['-p'], { verified: true }),
  // VERIFIED: `codex exec -` reads instructions from stdin (its own --help
  // says so, and a probe returned the array). It prints a banner containing
  // `[workdir, /tmp, $TMPDIR]` before the reply, which is exactly why the
  // reply parser has to try more than the first bracket it finds.
  codex: harvestCli('codex', ['exec', '-'], { verified: true }),
  // VERIFIED both ways. Asked to follow instructions on stdin the agent
  // answered that it was unable to read stdin and exited 0 -- a silent
  // no-findings result indistinguishable from a quiet session. Asked instead
  // to read a payload file it returned the exact array requested, which is
  // why this row is prompt-file. --allow-all-tools is required for
  // non-interactive use by copilot's own help text, and -s drops the stats
  // banner.
  copilot: harvestCli('copilot', ['-s', '--allow-all-tools', '-p'], {
    delivery: 'prompt-file',
    verified: true,
  }),
  // DOCUMENTED: `gemini --help` states that -p runs headless and that the
  // prompt is "Appended to input on stdin (if any)", so the digest rides
  // stdin and the instruction is the flag value. Not executed here: this
  // machine's gemini is unauthenticated and fails in refreshAuth before any
  // prompt is read.
  gemini: harvestCli('gemini', ['-p'], { delivery: 'arg-stdin' }),
  // DOCUMENTED: qwen-code is a fork of gemini-cli and keeps its flag surface.
  qwen: harvestCli('qwen', ['-p'], { delivery: 'arg-stdin' }),
  // DOCUMENTED: `opencode run <message>` is its non-interactive entry point.
  opencode: harvestCli('opencode', ['run'], { delivery: 'prompt-file' }),
  // DOCUMENTED: `crush run <prompt>` runs a single non-interactive prompt.
  crush: harvestCli('crush', ['run', '-q'], { delivery: 'prompt-file' }),
  // DOCUMENTED: `droid exec <prompt>` is Factory's headless mode.
  droid: harvestCli('droid', ['exec'], { delivery: 'prompt-file' }),
  // DOCUMENTED: `amp -x <prompt>` executes a single prompt and exits.
  amp: harvestCli('amp', ['-x'], { delivery: 'prompt-file' }),
  // DOCUMENTED: the Continue CLI installs as `cn` and takes -p for headless.
  continue: harvestCli('cn', ['-p'], { delivery: 'prompt-file' }),

  // NO HEADLESS CLI OF THEIR OWN. These are editor- and extension-hosted:
  // the assistant runs inside the IDE process and ships no command a hook
  // could spawn. Declaring null keeps that a stated fact rather than an
  // omission, and these clients fall back to a configured endpoint --
  // borrowing a neighbouring vendor's CLI would send the digest to a model
  // the user never chose.
  cursor: null,
  cline: null,
  windsurf: null,
  kilo: null,
  roo: null,
  zed: null,
});

/**
 * The base-URL variable for a client, or null when it has none.
 *
 * Normalised and own-property guarded, for the reasons harvestCliFor records:
 * a bare index disagreed with capabilityFor on casing and reached the
 * prototype.
 */
export function proxyEnvFor(client) {
  const key = String(client || '').toLowerCase();
  return Object.hasOwn(CLIENT_PROXY_ENV, key) ? CLIENT_PROXY_ENV[key] : null;
}

/**
 * Splits a configured command line into words, respecting quotes.
 *
 * SPLITTING ON WHITESPACE ALONE IS WRONG ON WINDOWS, and the first test
 * written against this caught it: the natural thing to configure is the
 * interpreter you already have, and on Windows that is
 * `C:\\Program Files\\nodejs\\node.exe`. A bare split turned that into the
 * command `C:\\Program` and reported `C:\\Program exited 1`, which is a
 * diagnostic nobody can act on. Quoting a path with spaces is the ordinary
 * way to write a command line, so it has to mean what it says.
 */
function commandWords(line) {
  const words = [];
  let current = '';
  let quote = '';
  let started = false;
  for (const ch of String(line)) {
    if (quote) {
      if (ch === quote) quote = '';
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (started) words.push(current);
      current = '';
      started = false;
      continue;
    }
    current += ch;
    started = true;
  }
  if (started) words.push(current);
  return words;
}

/**
 * The harvest CLI for a client, or null when it has none.
 *
 * TOKEN_OPTIMIZER_HARVEST_CLI_COMMAND overrides the table entirely, so a
 * client with no row -- or one whose vendor changed its flags after this
 * shipped -- is a configuration away from working rather than a release away.
 * The value is a command and its arguments, and its last word may name a
 * delivery:
 *   (nothing)  the payload goes to the command's stdin.
 *   `{}`       it is written to a file and the path becomes the last
 *              argument -- what an agentic CLI that ignores stdin needs.
 *   `{-}`      the payload goes to stdin and a short instruction becomes the
 *              last argument, for a CLI whose prompt flag demands a value
 *              but which still reads stdin. gemini and qwen are shaped this
 *              way, and without this an override could not reach that shape
 *              at all.
 */
export function harvestCliFor(client, env = process.env) {
  const override = (env.TOKEN_OPTIMIZER_HARVEST_CLI_COMMAND || '').trim();
  if (override) {
    const parts = commandWords(override);
    const last = parts[parts.length - 1];
    const delivery =
      last === '{}' ? 'prompt-file' : last === '{-}' ? 'arg-stdin' : 'stdin';
    if (delivery !== 'stdin') parts.pop();
    const [command, ...args] = parts;
    if (!command) return null;
    return harvestCli(command, args, { delivery });
  }
  // NORMALISED AND OWN-PROPERTY ONLY, matching `capabilityFor` below.
  //
  // A bare index disagreed with its own sibling and reached the prototype.
  // Reproduced: TOKEN_OPTIMIZER_CLIENT=Codex resolved a capability profile
  // through capabilityFor -- which lower-cases -- and NO harvest CLI here, so
  // harvestMode() fell through to off:no-key and an opted-in harvest silently
  // did nothing on a client that plainly has one. And
  // harvestCliFor('constructor') returned a function, whose `command` is
  // undefined, which runHostCli would have handed straight to spawn.
  const key = String(client || '').toLowerCase();
  return Object.hasOwn(CLIENT_HARVEST_CLI, key) ? CLIENT_HARVEST_CLI[key] : null;
}
export const CLIENT_CAPABILITIES = Object.freeze({
  'claude-code': native({
    name: 'Claude Code',
    tier: CAPABILITY_TIERS.CONTINUATION,
    semanticHarvest: 'stop-continuation',
    canDeny: true,
    denyStyle: 'permission',
    stopDecision: 'block',
  }),
  codex: native({
    name: 'Codex',
    tier: CAPABILITY_TIERS.CONTINUATION,
    semanticHarvest: 'stop-continuation',
    canDeny: true,
    denyStyle: 'permission',
    stopDecision: 'block',
  }),
  copilot: native({
    name: 'GitHub Copilot CLI',
    tier: CAPABILITY_TIERS.CONTINUATION,
    semanticHarvest: 'agent-stop-continuation',
    canDeny: true,
    contextStyle: 'top-level',
    denyStyle: 'top-level-permission',
    stopDecision: 'block',
  }),
  gemini: native({
    name: 'Gemini CLI',
    tier: CAPABILITY_TIERS.CONTINUATION,
    semanticHarvest: 'after-agent-retry',
    canDeny: true,
    denyStyle: 'top-level',
    stopDecision: 'deny',
  }),
  qwen: native({
    name: 'Qwen Code',
    tier: CAPABILITY_TIERS.CONTINUATION,
    semanticHarvest: 'stop-continuation',
    canDeny: true,
    denyStyle: 'permission',
    stopDecision: 'block',
  }),
  cursor: native({
    name: 'Cursor',
    tier: CAPABILITY_TIERS.CONTINUATION,
    semanticHarvest: 'stop-followup',
    canDeny: true,
    contextStyle: 'cursor',
    denyStyle: 'cursor',
    stopStyle: 'followup',
    stopDecision: 'block',
  }),
  cline: native({
    name: 'Cline',
    tier: CAPABILITY_TIERS.OBSERVATION,
    semanticHarvest: 'active-model-rule',
    canDeny: true,
    contextStyle: 'cline',
    denyStyle: 'cline',
    stopDecision: 'block',
  }),
  opencode: native({
    name: 'OpenCode',
    tier: CAPABILITY_TIERS.OBSERVATION,
    semanticHarvest: 'active-model-rule',
    canDeny: true,
    denyStyle: 'permission',
    stopDecision: 'block',
  }),
  kilo: native({
    name: 'Kilo',
    tier: CAPABILITY_TIERS.OBSERVATION,
    semanticHarvest: 'active-model-rule',
    canDeny: true,
    denyStyle: 'permission',
    stopDecision: 'block',
  }),
  windsurf: native({
    name: 'Windsurf',
    tier: CAPABILITY_TIERS.OBSERVATION,
    semanticHarvest: 'active-model-rule',
    canDeny: true,
    contextStyle: 'silent',
    denyStyle: 'exit-2',
    stopDecision: 'block',
  }),
  roo: {
    name: 'Roo Code',
    tier: CAPABILITY_TIERS.RULES,
    routing: 'rules',
    structuralCapture: 'mcp-visible-only',
    findingDelivery: 'explicit-mcp',
    semanticHarvest: 'active-model-rule',
    canDeny: false,
  },
  zed: {
    name: 'Zed',
    tier: CAPABILITY_TIERS.RULES,
    routing: 'rules',
    structuralCapture: 'mcp-visible-only',
    findingDelivery: 'explicit-mcp',
    semanticHarvest: 'active-model-rule',
    canDeny: false,
  },
  amp: {
    name: 'Amp',
    tier: CAPABILITY_TIERS.RULES,
    routing: 'rules',
    structuralCapture: 'mcp-visible-only',
    findingDelivery: 'explicit-mcp',
    semanticHarvest: 'active-model-rule',
    canDeny: false,
  },
  continue: {
    name: 'Continue',
    tier: CAPABILITY_TIERS.RULES,
    routing: 'rules',
    structuralCapture: 'mcp-visible-only',
    findingDelivery: 'explicit-mcp',
    semanticHarvest: 'active-model-rule',
    canDeny: false,
  },
  crush: {
    name: 'Crush',
    tier: CAPABILITY_TIERS.RULES,
    routing: 'rules',
    structuralCapture: 'mcp-visible-only',
    findingDelivery: 'explicit-mcp',
    semanticHarvest: 'active-model-rule',
    canDeny: false,
  },
  droid: {
    name: 'Droid (Factory)',
    tier: CAPABILITY_TIERS.RULES,
    routing: 'rules',
    structuralCapture: 'mcp-visible-only',
    findingDelivery: 'explicit-mcp',
    semanticHarvest: 'active-model-rule',
    canDeny: false,
  },
});

export function capabilityFor(client) {
  return CLIENT_CAPABILITIES[String(client || '').toLowerCase()] || null;
}

export function nativeClientProfiles() {
  return Object.fromEntries(
    Object.entries(CLIENT_CAPABILITIES)
      .filter(([, profile]) => profile.structuralCapture === 'native')
      .map(([key, profile]) => [key, { ...profile }])
  );
}

export function capabilitySummary() {
  return Object.entries(CLIENT_CAPABILITIES).map(([client, profile]) => ({
    client,
    name: profile.name,
    tier: profile.tier,
    routing: profile.routing,
    structuralCapture: profile.structuralCapture,
    findingDelivery: profile.findingDelivery,
    semanticHarvest: profile.semanticHarvest,
  }));
}
