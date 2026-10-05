/**
 * Which agents the pass will run.
 *
 * The registry is deliberately narrower than the design it was modelled on: there is
 * no scan of installed packages and no entry-point group, so an extra plugin is
 * imported only when the user names it. That refusal is the point of these tests --
 * a tool that reads every transcript on a machine must not also execute code it
 * found by looking around -- together with the two ways a named plugin can be wrong,
 * which are reported and survivable rather than fatal.
 */
import { describe, it, expect, afterEach } from '@jest/globals';
import { pathToFileURL } from 'node:url';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  PLUGIN_ENV,
  PluginError,
  agentNames,
  agentPlugin,
  loadExternalAgents,
  registerAgent,
  resetRegisteredAgents,
} from '../../../src/learn/registry.js';
import { BuiltInAgent, type AgentPlugin } from '../../../src/learn/plugin.js';

const stub = (name: string): AgentPlugin => ({
  name,
  displayName: name,
  detect: async () => false,
  discoverProjects: async () => [],
  scanProject: async () => [],
  contextTarget: () => ({ contextFile: 'AGENTS.md', memoryFile: null }),
});

describe('registry', () => {
  afterEach(() => {
    resetRegisteredAgents();
  });

  it('knows the two agents it ships with', () => {
    expect(agentNames()).toContain(BuiltInAgent.Claude);
    expect(agentNames()).toContain(BuiltInAgent.Codex);
    expect(agentPlugin('CLAUDE  ').name).toBe(BuiltInAgent.Claude);
  });

  it('names the agents it knows when asked for one it does not', () => {
    // The message has to carry the list: "unknown agent" alone leaves the user
    // guessing at a spelling, which is another failed call.
    expect(() => agentPlugin('emacs')).toThrow(PluginError);
    expect(() => agentPlugin('emacs')).toThrow(/known agents: .*claude/);
  });

  it('takes a plugin only when it is named, never by looking around', async () => {
    // No package scan and no entry-point group, on purpose. Reading a user's
    // transcripts is already as far as this should go; also importing whatever
    // happens to be installed alongside it is not.
    expect(await loadExternalAgents({})).toEqual([]);
    expect(await loadExternalAgents({ [PLUGIN_ENV]: '  ' })).toEqual([]);
    expect(agentNames()).toHaveLength(2);
  });

  it('registers a named plugin and lets it be chosen', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'learn-plugin-'));
    try {
      const file = join(directory, 'plugin.mjs');
      writeFileSync(
        file,
        [
          'export const plugin = {',
          "  name: 'ACME', displayName: 'Acme',",
          '  detect: () => false, discoverProjects: () => [], scanProject: () => [],',
          "  contextTarget: () => ({ contextFile: 'ACME.md', memoryFile: null }),",
          '};',
        ].join('\n'),
        'utf8'
      );
      const problems = await loadExternalAgents({
        [PLUGIN_ENV]: pathToFileURL(file).href,
      });
      expect(problems).toEqual([]);
      expect(agentPlugin('acme').displayName).toBe('Acme');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('reports a plugin that will not import, and one that is not a plugin', async () => {
    const problems = await loadExternalAgents({
      [PLUGIN_ENV]: 'no-such-module-here, node:os',
    });
    expect(problems).toHaveLength(2);
    expect(problems[0]).toContain('could not be loaded');
    expect(problems[1]).toContain('does not export a learn plugin');
  });

  it('refuses a plugin with no name, because the name is how it is chosen', () => {
    expect(() => registerAgent(stub('   '))).toThrow(PluginError);
  });

  it('matches a registered name however it was capitalised', () => {
    registerAgent(stub('MixedCase'));
    expect(agentPlugin('mixedcase').displayName).toBe('MixedCase');
  });
});
