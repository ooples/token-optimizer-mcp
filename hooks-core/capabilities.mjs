import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

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
 *
 * TOKEN_OPTIMIZER_MCP_CAPABILITIES_BUNDLED is the WEAKER grade and is read only
 * when nothing stronger is present. A client entry point writes it at install
 * time to say "this package shipped an MCP declaration beside these hooks",
 * which a broken or unregistered server satisfies exactly as well as a working
 * one. It contributes names, never proof. See #469: a session was told it had
 * "positive runtime inventory evidence" for tools that the host had not
 * registered and no call could reach.
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
  if (proven) {
    addInventoryValue(env.TOKEN_OPTIMIZER_MCP_CAPABILITIES, names);
    return { proven, names };
  }

  // The install-time default, which is a claim about the package rather than
  // about this session. Named so the grade cannot be laundered: writing it into
  // TOKEN_OPTIMIZER_MCP_CAPABILITIES is what made a fabricated list read as
  // proof for every plugin install (#469).
  addInventoryValue(env.TOKEN_OPTIMIZER_MCP_CAPABILITIES_BUNDLED, names);
  return { proven: false, names };
}

/**
 * The tool-not-found replies a host sends when a DECLARED MCP tool never
 * reached the session's tool registry.
 *
 * Deliberately narrow. A wiki_write that fails because the claim carried no
 * anchor, or a smart_read that fails on a missing path, says nothing about
 * whether the tool exists -- treating those as absence would disable the whole
 * subsystem on the first ordinary error. Only "there is no such tool" counts.
 */
const TOOL_ABSENT =
  // `is not available` is QUALIFIED deliberately. On its own it matched
  // ordinary failures -- "File is not available" -- and a match suppresses a
  // working tool for the rest of the session, so the loosest alternative in
  // this pattern was also the most expensive one to get wrong.
  /no such tool|tool not found|unknown tool|no tool named|not a registered tool|(?:tool|server)[^.\n]{0,80}?is not available|method not found|-32601|server not connected|mcp server .* not (?:found|connected|running)/i;

/**
 * Whether a failed call's message means THE TOOL DOES NOT EXIST.
 *
 * Exported so the transcript reader can apply the same test without a second
 * copy of the pattern. It takes text and returns a boolean, which is what lets
 * the caller that holds transcript text classify in place and hand back only a
 * tool name -- no transcript bytes cross the boundary.
 */
export function isToolAbsentMessage(text) {
  return TOOL_ABSENT.test(String(text || ''));
}

/**
 * Grade a COMPLETED optimizer MCP call -- the only direct evidence either way.
 *
 * Every other signal in this file is a declaration: a host listing names, or a
 * package saying it shipped a server. An actual call is the thing those
 * declarations are predictions about, so it settles the question for that one
 * tool. #469 is the case that needs it: the server launched and listed 19 tools
 * standalone, the hooks advertised them, and not one of them could be called in
 * the session. Nothing short of a call distinguishes that from a healthy
 * install, because the host never told the hooks either way.
 *
 * Kept per-name and apart from `optimizerTools`, which holds a whole inventory
 * a host supplied. Folding one observation into that list would shrink the
 * inventory to the single tool that happened to be called first.
 */
export function observeOptimizerToolCall(
  state,
  toolName,
  { ok = false, text = '', at = Date.now() } = {}
) {
  const name = optimizerToolName(toolName);
  if (!state || !name || !HOOK_MCP_TOOL_SET.has(name)) return state;
  // TWO TIMESTAMPS PER NAME, AND THE LATER ONE WINS.
  //
  // An MCP server can be started, reloaded or reconnected mid-session -- the
  // reporter of #469 ran `/plugin` and `/reload-plugins` -- so a suppression
  // has to be revocable or a user who fixes their install never gets the tools
  // back. A plain list cannot do that here, for two reasons that both bite:
  // the transcript scan re-reads the SAME failure on every later event and
  // would re-add a name that had just been cleared, and `saveState` merges
  // concurrent hook processes field by field, where a union resurrects a
  // removal. Comparing a last-absent against a last-ok instant is monotonic,
  // order-independent and merges as a per-key max, exactly like `actCounts`.
  if (ok) return markOptimizerToolOk(state, name, at);
  if (!isToolAbsentMessage(text)) return state;
  return markOptimizerToolAbsent(state, name, at);
}

/** Per-name instant maps, created lazily so an untouched state stays clean. */
function stampTool(state, field, name, at) {
  const stamps = { ...(state[field] || {}) };
  // AN UNKNOWN INSTANT IS THE OLDEST ONE, NOT THE NEWEST.
  //
  // This read `Number(at) || Date.now()`, which defeated the whole mechanism:
  // a transcript refusal carries `at` 0 when its entry has no parsable
  // timestamp, and the transcript is re-scanned on EVERY hook event, so the
  // same old refusal was re-stamped at the current time again and again and
  // always outranked a later success. A repaired install could never come back.
  // The comment below claimed monotonicity while the code did the opposite.
  const parsed = Number(at);
  const when = parsed > 0 ? parsed : 1;
  // MONOTONIC per name, so re-reading an older observation cannot pull a later
  // one backwards.
  stamps[name] = Math.max(Number(stamps[name]) || 0, when);
  state[field] = stamps;
  return state;
}

/**
 * Record that a named optimizer tool is not in this session's tool registry.
 *
 * Separate from `observeOptimizerToolCall` because the two callers hold
 * different things: a post-tool event hands over a result to be classified,
 * while the transcript reader has already classified its own text and can only
 * hand back a name and an instant. Both end here, so the stored shape has one
 * writer.
 */
export function markOptimizerToolAbsent(state, toolName, at = Date.now()) {
  const name = optimizerToolName(toolName);
  if (!state || !name || !HOOK_MCP_TOOL_SET.has(name)) return state;
  return stampTool(state, 'optimizerToolAbsentAt', name, at);
}

/** Record that a named optimizer tool answered a call. Revokes an absence. */
export function markOptimizerToolOk(state, toolName, at = Date.now()) {
  const name = optimizerToolName(toolName);
  if (!state || !name || !HOOK_MCP_TOOL_SET.has(name)) return state;
  return stampTool(state, 'optimizerToolOkAt', name, at);
}

/** Names a call in this session proved absent, and no later call brought back. */
export function unreachableOptimizerTools(state = {}) {
  const absentAt = state?.optimizerToolAbsentAt || {};
  const okAt = state?.optimizerToolOkAt || {};
  const out = new Set();
  for (const [name, when] of Object.entries(absentAt)) {
    if (!HOOK_MCP_TOOL_SET.has(name)) continue;
    if ((Number(when) || 0) > (Number(okAt[name]) || 0)) out.add(name);
  }
  return out;
}

/** Rehydrate the most recently proven inventory for this exact hook session. */
export function optimizerToolsForHook(raw, state = {}, env = process.env) {
  // A TOOL A CALL PROVED ABSENT IS DROPPED AT EVERY GRADE (#469), including a
  // host's own inventory: the host said it registered the tool and the call
  // says otherwise, and the call is the later and more direct observation.
  const absent = unreachableOptimizerTools(state);
  const without = (evidence) =>
    absent.size === 0
      ? evidence
      : {
          proven: evidence.proven,
          names: new Set(
            [...evidence.names].filter((name) => !absent.has(name))
          ),
        };

  const current = optimizerToolEvidence(raw, env);
  if (current.proven) return without(current);
  if (
    Number.isFinite(state.optimizerToolsObservedAt) &&
    state.optimizerToolsObservedAt > 0 &&
    Array.isArray(state.optimizerTools)
  ) {
    return without({
      proven: true,
      names: new Set(
        state.optimizerTools.filter((name) => HOOK_MCP_TOOL_SET.has(name))
      ),
    });
  }
  // CARRY THE BUNDLED NAMES RATHER THAN AN EMPTY SET. This used to return
  // nothing at all, which was unreachable while the install-time default was
  // written into the proven variable. Now that the default grades honestly,
  // returning an empty set here would silently switch routing advice off for
  // every plugin install -- a regression dressed as a fix. The names still
  // steer advice; `proven` still gates anything that costs the user a call.
  return without({ proven: false, names: current.names });
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
 * The clients we can launch for the user, and what upstream each one talks to.
 *
 * WHY A DEFAULT UPSTREAM IS A SAFETY DECISION, not a convenience. The proxy forwards to exactly one
 * endpoint, so routing a client means naming the provider it was already going to use. Name the
 * wrong one and this ships that client's credentials to a different company -- so a default appears
 * here only for a client with ONE provider, and every other client is routed only when the user has
 * already told us their endpoint through its own variable.
 *
 * `command` is the binary the user types, which is not always the client id: Continue ships `cn`.
 * It matches the harvest table below, which was verified against the installed CLIs.
 */
export const MANAGED_CLIENTS = Object.freeze({
  // Anthropic is Claude Code's provider unless ANTHROPIC_BASE_URL says otherwise, and that is
  // already this proxy's own default upstream.
  'claude-code': Object.freeze({
    command: 'claude',
    defaultUpstream: 'https://api.anthropic.com',
  }),
  // Codex resolves its own upstream from ~/.codex/config.toml, including the ChatGPT and API-key
  // split; runClient asks that resolver rather than assuming one here.
  codex: Object.freeze({ command: 'codex', defaultUpstream: null }),
  // NOT a single-provider CLI, which is why it has no default. Gemini CLI carries three separate
  // transports: a Gemini API key talks to generativelanguage.googleapis.com, a Google login talks
  // to the Code Assist endpoint (cloudcode-pa.googleapis.com, via CODE_ASSIST_ENDPOINT), and Vertex
  // reads GOOGLE_VERTEX_BASE_URL. GOOGLE_GEMINI_BASE_URL governs only the first, so defaulting to
  // it would route API-key sessions and silently miss the other two -- the same wrong-endpoint
  // guess this table exists to refuse. Gemini is routed once its own variable names an endpoint.
  gemini: Object.freeze({ command: 'gemini', defaultUpstream: null }),
  // MULTI-PROVIDER CLIENTS. Each picks its provider in its own configuration, so there is no single
  // endpoint to assume: they are routed when their variable already names one, and left alone when
  // it does not. Adding a default here later needs evidence per client, not a plausible guess.
  opencode: Object.freeze({ command: 'opencode', defaultUpstream: null }),
  qwen: Object.freeze({ command: 'qwen', defaultUpstream: null }),
  crush: Object.freeze({ command: 'crush', defaultUpstream: null }),
  droid: Object.freeze({ command: 'droid', defaultUpstream: null }),
  continue: Object.freeze({ command: 'cn', defaultUpstream: null }),
  copilot: Object.freeze({ command: 'copilot', defaultUpstream: null }),
  amp: Object.freeze({ command: 'amp', defaultUpstream: null }),
});

/** The client ids we can launch, in a stable order. */
export function managedClientIds() {
  return Object.keys(MANAGED_CLIENTS);
}

/** The client id behind a command name, or null. `claude` is Claude Code. */
export function clientForCommand(command) {
  const wanted = String(command || '').toLowerCase();
  for (const [id, entry] of Object.entries(MANAGED_CLIENTS)) {
    if (entry.command === wanted) return id;
  }
  return null;
}

/**
 * Where each client's hooks are installed, and what they are called there.
 *
 * ONE TABLE, READ BY BOTH SIDES. These destinations existed only as English inside
 * scripts/generate-client-configs.mjs -- "copy hooks/ to .cursor/hooks/token-optimizer/" -- which
 * is a fine thing to print and a useless thing to check against. The doctor could therefore
 * examine exactly two installs, Claude Code's and Codex's, and every other client fell through to
 * whatever detectInstall found in Claude Code's registry (#408). A destination that is written
 * down once can be printed by the installer AND looked for by the diagnosis, and the drift gate in
 * that generator now fails if the two disagree.
 *
 * `base` is what `dir` is relative to: 'home' for a client that installs hooks once per machine,
 * 'project' for one that reads them from the repository it is opened in. `entries` names the files
 * by role, because the roles are shared and the filenames are not: Cline alone uses extensionless
 * wrappers named after the event.
 *
 * A NULL `dir` IS AN ANSWER, NOT A GAP. Gemini and Qwen install through their own extension
 * mechanism, which picks the directory itself; nowhere in this repository records what it picks.
 * Writing a plausible path here would make the doctor report a missing install for every user of
 * those two clients, which is worse than saying we do not know.
 */
export const CLIENT_HOOK_INSTALLS = Object.freeze({
  codex: Object.freeze({
    source: 'integrations/codex/hooks',
    base: 'home',
    dir: '.codex/hooks',
    entries: Object.freeze({
      sessionStart: 'session-start.mjs',
      preTool: 'pre-tool.mjs',
      postTool: 'post-tool.mjs',
      stop: 'stop.mjs',
    }),
  }),
  copilot: Object.freeze({
    source: 'integrations/copilot/.github/hooks',
    base: 'project',
    dir: '.github/hooks',
    entries: Object.freeze({
      sessionStart: 'session-start.mjs',
      preTool: 'pre-tool.mjs',
      postTool: 'post-tool.mjs',
      stop: 'stop.mjs',
    }),
  }),
  opencode: Object.freeze({
    source: 'integrations/opencode/hooks',
    base: 'project',
    dir: '.opencode/hooks/token-optimizer',
    entries: Object.freeze({
      sessionStart: 'session-start.mjs',
      preTool: 'pre-tool.mjs',
      postTool: 'post-tool.mjs',
    }),
  }),
  cursor: Object.freeze({
    source: 'integrations/cursor/hooks',
    base: 'project',
    dir: '.cursor/hooks/token-optimizer',
    entries: Object.freeze({
      sessionStart: 'session-start.mjs',
      preTool: 'pre-tool.mjs',
      postTool: 'post-tool.mjs',
      stop: 'stop.mjs',
    }),
  }),
  windsurf: Object.freeze({
    source: 'integrations/windsurf/hooks',
    base: 'project',
    dir: '.windsurf/hooks/token-optimizer',
    entries: Object.freeze({
      preTool: 'pre-tool.mjs',
      postTool: 'post-tool.mjs',
    }),
  }),
  kilo: Object.freeze({
    source: 'integrations/kilo/hooks',
    base: 'project',
    dir: '.kilo/hooks/token-optimizer',
    entries: Object.freeze({
      sessionStart: 'session-start.mjs',
      preTool: 'pre-tool.mjs',
      postTool: 'post-tool.mjs',
    }),
  }),
  // THE ONE CLIENT THAT DOES NOT USE OUR FILENAMES. Cline dispatches on the event name, so the
  // wrappers are extensionless and named after the event, with .ps1 siblings for Windows.
  cline: Object.freeze({
    source: 'integrations/cline/hooks',
    base: 'project',
    dir: '.clinerules/hooks',
    entries: Object.freeze({
      sessionStart: 'TaskStart',
      preTool: 'PreToolUse',
      postTool: 'PostToolUse',
    }),
  }),
  gemini: Object.freeze({
    source: 'integrations/gemini/hooks',
    base: null,
    dir: null,
    why: 'installed by gemini extensions install, which chooses the extension directory itself; this repository has never recorded that path, so the doctor must not guess at one',
    entries: Object.freeze({
      sessionStart: 'session-start.mjs',
      preTool: 'pre-tool.mjs',
      postTool: 'post-tool.mjs',
      stop: 'stop.mjs',
    }),
  }),
  qwen: Object.freeze({
    source: 'integrations/qwen/hooks',
    base: null,
    dir: null,
    why: 'installed through Qwen Code settings, which records the extension location itself; this repository has never recorded that path, so the doctor must not guess at one',
    entries: Object.freeze({
      sessionStart: 'session-start.mjs',
      preTool: 'pre-tool.mjs',
      postTool: 'post-tool.mjs',
      stop: 'stop.mjs',
    }),
  }),
});

/** Where this client's hooks live, or null when it has no hook integration at all. */
export function hookInstallFor(client) {
  return CLIENT_HOOK_INSTALLS[String(client || '').toLowerCase()] || null;
}

/**
 * The endpoint a client is already using, or null when we cannot know it.
 *
 * A value that already points at loopback is one of our own routes from an earlier session: it is
 * not an upstream, and forwarding to it would make the proxy talk to itself.
 */
export function upstreamFor(client, env = process.env) {
  const entry = MANAGED_CLIENTS[client];
  if (!entry) return null;
  const variable = CLIENT_PROXY_ENV[client];
  const configured = variable ? String(env[variable] || '').trim() : '';
  if (!configured) return entry.defaultUpstream;
  try {
    const host = new URL(configured).hostname
      .replace(/^\[|\]$/g, '')
      .toLowerCase();
    const loopback =
      host === 'localhost' ||
      host === '::1' ||
      /^127[.]\d{1,3}[.]\d{1,3}[.]\d{1,3}$/.test(host);
    if (!loopback) return configured;
    // A LOOPBACK VALUE IS ONLY OURS IF WE RECORDED WRITING IT. Treating every loopback endpoint as
    // our own route meant a user running their own local gateway had it replaced by the provider's
    // public endpoint -- we would route around the very thing they put in front of the provider.
    // Ours is recognised by the manifest; anything else is somebody's real upstream and is kept.
  } catch {
    return null;
  }
  const recorded = ourRoute(configured, client, env);
  return recorded ? recorded.upstream || recorded.previous : configured;
}

/**
 * Did we write this endpoint, for this client's variable?
 *
 * Read as a plain file rather than through the compiled module, because this file is copied into
 * eleven client integrations that do not ship `dist/`.
 */
function ourRoute(value, client, env) {
  try {
    const home =
      env.TOKEN_OPTIMIZER_HOME || join(homedir(), '.token-optimizer');
    const manifest = JSON.parse(
      readFileSync(join(home, 'default-routing.json'), 'utf8')
    );
    if (manifest?.schema !== 1) return false;
    const variable = CLIENT_PROXY_ENV[client];
    const matches = Object.values(manifest.entries || {}).filter(
      (entry) => entry?.value === value && entry?.variable === variable
    );
    if (!matches.length) return false;
    const upstreams = new Set(
      matches.map((entry) => entry.upstream || entry.previous)
    );
    if (upstreams.size !== 1 || ![...upstreams][0]) {
      const error = new Error(
        'Ambiguous proxy ownership; restore the provider endpoint before launching.'
      );
      error.code = 'AMBIGUOUS_PROXY_OWNERSHIP';
      throw error;
    }
    return matches[0];
  } catch (error) {
    if (error.code === 'AMBIGUOUS_PROXY_OWNERSHIP') throw error;
    // No record means we did not write it, so it is not ours to replace.
    return false;
  }
}

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
const harvestCli = (
  command,
  args,
  { delivery = 'stdin', verified = false } = {}
) =>
  Object.freeze({
    command,
    args: Object.freeze([...args]),
    delivery,
    verified,
  });

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
  return Object.hasOwn(CLIENT_HARVEST_CLI, key)
    ? CLIENT_HARVEST_CLI[key]
    : null;
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
