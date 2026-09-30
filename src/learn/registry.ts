/**
 * The plugin registry.
 *
 * Built-ins are registered by an explicit import, not by scanning a directory.
 * A scan would make the set of supported agents depend on what happens to be on
 * disk next to this file, which is unpredictable in a bundle and untestable
 * anywhere.
 *
 * AN EXTERNAL PLUGIN IS LOADED ONLY WHEN A USER NAMES IT. There is no entry-point
 * discovery here on purpose: the equivalent would mean any installed package
 * could get its code imported by a tool the user ran for an unrelated reason.
 * TOKEN_OPTIMIZER_LEARN_PLUGINS is a list of module specifiers, and a user who
 * writes one has asked for exactly that module.
 */

import { AgentPlugin, BuiltInAgent } from './plugin.js';
import { claudePlugin } from './plugins/claude.js';
import { codexPlugin } from './plugins/codex.js';

const builtIn = new Map<string, AgentPlugin>([
  [BuiltInAgent.Claude, claudePlugin],
  [BuiltInAgent.Codex, codexPlugin],
]);

const registered = new Map<string, AgentPlugin>();

/** The variable naming extra plugins to import, as ESM specifiers. */
export const PLUGIN_ENV = 'TOKEN_OPTIMIZER_LEARN_PLUGINS';

export class PluginError extends Error {}

/**
 * Add a plugin at runtime.
 *
 * A name that collides with a built-in replaces it, which is how someone fixes
 * our parser for their own layout without waiting for a release.
 */
export function registerAgent(plugin: AgentPlugin): void {
  const name = plugin.name.trim().toLowerCase();
  if (name.length === 0) throw new PluginError('a plugin must have a name');
  registered.set(name, { ...plugin, name });
}

/** Drop everything registered at runtime. For tests, and for nothing else. */
export function resetRegisteredAgents(): void {
  registered.clear();
}

function all(): Map<string, AgentPlugin> {
  return new Map([...builtIn, ...registered]);
}

export function agentNames(): readonly string[] {
  return [...all().keys()].sort();
}

export function agentPlugins(): readonly AgentPlugin[] {
  return agentNames().map((name) => {
    const plugin = all().get(name);
    if (plugin === undefined) throw new PluginError(`plugin ${name} vanished`);
    return plugin;
  });
}

export function agentPlugin(name: string): AgentPlugin {
  const found = all().get(name.trim().toLowerCase());
  if (found === undefined) {
    throw new PluginError(
      `unknown agent "${name}"; known agents: ${agentNames().join(', ')}`
    );
  }
  return found;
}

/** The plugins that have data on this machine. */
export function detectedAgents(): readonly AgentPlugin[] {
  const found: AgentPlugin[] = [];
  for (const plugin of agentPlugins()) {
    try {
      if (plugin.detect()) found.push(plugin);
    } catch {
      // A plugin that throws while looking is one this machine cannot use. That
      // is not a reason to abandon the pass for the agents that do work, and the
      // caller is told which ones were reached by what comes back.
    }
  }
  return found;
}

/**
 * Import the plugins named in the environment.
 *
 * Returns what went wrong rather than throwing, so a typo in the variable costs a
 * line of output and not the run. A module that loads but exports nothing usable
 * is reported the same way -- silently ignoring it would leave a user waiting for
 * results from a plugin that never ran.
 */
export async function loadExternalAgents(
  env: NodeJS.ProcessEnv = process.env
): Promise<readonly string[]> {
  const raw = env[PLUGIN_ENV];
  if (raw === undefined || raw.trim().length === 0) return [];
  const problems: string[] = [];
  for (const spec of raw.split(',').map((part) => part.trim()).filter(Boolean)) {
    try {
      const mod: unknown = await import(spec);
      const exported = (mod as { plugin?: unknown; default?: unknown }).plugin ??
        (mod as { default?: unknown }).default;
      const candidate = typeof exported === 'function'
        ? (exported as () => unknown)()
        : exported;
      if (!isPlugin(candidate)) {
        problems.push(`${spec} does not export a learn plugin`);
        continue;
      }
      registerAgent(candidate);
    } catch (error) {
      problems.push(
        `${spec} could not be loaded: ${error instanceof Error ? error.message : 'unknown error'}`
      );
    }
  }
  return problems;
}

function isPlugin(value: unknown): value is AgentPlugin {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<AgentPlugin>;
  return (
    typeof candidate.name === 'string' &&
    typeof candidate.displayName === 'string' &&
    typeof candidate.detect === 'function' &&
    typeof candidate.discoverProjects === 'function' &&
    typeof candidate.scanProject === 'function' &&
    typeof candidate.contextTarget === 'function'
  );
}