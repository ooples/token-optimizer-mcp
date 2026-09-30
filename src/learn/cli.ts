#!/usr/bin/env node
/**
 * `token-optimizer learn` -- what did past sessions in this project keep failing at?
 *
 * Every local coding agent already keeps a transcript of what it tried. The failures
 * in those transcripts are the cheapest training data there is about a project: a
 * command that does not exist here, a path nobody has, a tool that keeps being
 * handed a directory. Each one costs a call and an apology every time it recurs, and
 * writing the answer into the instructions file the agent reads first costs nothing.
 *
 * NOTHING HERE TOUCHES THE NETWORK, and nothing is written without --write. The
 * transcripts hold the user's own source, so the pass reads them locally, reports
 * paths with the home directory reduced to `~`, and by default only prints.
 */

import { cwd } from 'node:process';
import { resolve } from 'node:path';
import { AnalysisResult, ProjectInfo } from './models.js';
import { AgentPlugin, ScanOptions } from './plugin.js';
import {
  PLUGIN_ENV,
  agentNames,
  agentPlugin,
  detectedAgents,
  loadExternalAgents,
} from './registry.js';
import { analyse } from './analyze.js';
import { describeAnalysis, writeRecommendations } from './report.js';

interface Options {
  readonly agent: string | null;
  readonly projectPath: string;
  readonly since: Date | null;
  readonly maxSessions: number | null;
  readonly write: boolean;
  readonly listProjects: boolean;
  readonly json: boolean;
  readonly help: boolean;
}

const USAGE = [
  'token-optimizer-learn [options]',
  '',
  'Reads local agent transcripts for this project and reports the failures that',
  'keep repeating, as rules worth putting in the agent instructions file.',
  '',
  `  --agent <name>       one of: ${agentNames().join(', ')}, or auto (default)`,
  '  --project <path>     which project to analyse (default: the current directory)',
  '  --since <days>       ignore sessions older than this many days',
  '  --max-sessions <n>   read at most this many sessions, newest first',
  '  --write              write the block into the agent instructions file',
  '  --projects           list the projects this agent has sessions for, and stop',
  '  --json               print the analysis as JSON instead of prose',
  '  --help',
  '',
  'Nothing is written unless --write is given.',
  `Extra plugins: set ${PLUGIN_ENV} to a comma-separated list of module specifiers.`,
].join('\n');

export function parseArguments(argv: readonly string[]): Options {
  let agent: string | null = null;
  let projectPath = cwd();
  let since: Date | null = null;
  let maxSessions: number | null = null;
  let write = false;
  let listProjects = false;
  let json = false;
  let help = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] ?? '';
    const next = (): string => {
      const value = argv[index + 1];
      if (value === undefined) throw new Error(`${argument} needs a value`);
      index += 1;
      return value;
    };
    switch (argument) {
      case '--agent':
        agent = next().toLowerCase();
        break;
      case '--project':
        projectPath = resolve(next());
        break;
      case '--since': {
        const days = Number(next());
        if (!Number.isFinite(days) || days <= 0) {
          throw new Error('--since needs a positive number of days');
        }
        since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
        break;
      }
      case '--max-sessions': {
        const count = Number(next());
        if (!Number.isInteger(count) || count <= 0) {
          throw new Error('--max-sessions needs a positive whole number');
        }
        maxSessions = count;
        break;
      }
      case '--write':
        write = true;
        break;
      case '--projects':
        listProjects = true;
        break;
      case '--json':
        json = true;
        break;
      case '--help':
      case '-h':
        help = true;
        break;
      default:
        throw new Error(`unknown option: ${argument}`);
    }
  }
  if (agent === 'auto') agent = null;
  return { agent, projectPath, since, maxSessions, write, listProjects, json, help };
}

/** Same directory, allowing for a trailing separator and Windows' casing. */
function samePath(left: string | null, right: string): boolean {
  if (left === null) return false;
  const tidy = (value: string): string =>
    value.replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase();
  return tidy(left) === tidy(right);
}

function projectFor(plugin: AgentPlugin, path: string): ProjectInfo | null {
  for (const project of plugin.discoverProjects()) {
    if (samePath(project.projectPath, path)) return project;
  }
  return null;
}

/** The plugins to run: the one named, or every one with data on this machine. */
export function selectPlugins(agent: string | null): readonly AgentPlugin[] {
  if (agent !== null) return [agentPlugin(agent)];
  return detectedAgents();
}

export interface RunOutcome {
  readonly lines: readonly string[];
  readonly results: readonly AnalysisResult[];
  readonly exitCode: number;
}

export async function run(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env
): Promise<RunOutcome> {
  let options: Options;
  try {
    options = parseArguments(argv);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { lines: [reason, '', USAGE], results: [], exitCode: 2 };
  }
  if (options.help) {
    return { lines: [USAGE], results: [], exitCode: 0 };
  }
  const lines: string[] = [];
  for (const problem of await loadExternalAgents(env)) {
    // Reported, not fatal. A user with a broken third-party plugin still wants the
    // answer for the agents that do work.
    lines.push(`PLUGIN: ${problem}`);
  }
  let plugins: readonly AgentPlugin[];
  try {
    plugins = selectPlugins(options.agent);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { lines: [...lines, reason], results: [], exitCode: 2 };
  }
  if (plugins.length === 0) {
    lines.push(
      'no agent transcripts found on this machine',
      `looked for: ${agentNames().join(', ')}`
    );
    return { lines, results: [], exitCode: 0 };
  }
  if (options.listProjects) {
    for (const plugin of plugins) {
      lines.push(`${plugin.displayName}:`);
      const projects = plugin.discoverProjects();
      if (projects.length === 0) lines.push('  none');
      for (const project of projects) {
        lines.push(`  ${project.projectPath ?? project.dataPath} (${project.sessionCount})`);
      }
    }
    return { lines, results: [], exitCode: 0 };
  }
  const results: AnalysisResult[] = [];
  for (const plugin of plugins) {
    const project = projectFor(plugin, options.projectPath);
    if (project === null) {
      lines.push(`${plugin.displayName}: no sessions recorded for this project`);
      continue;
    }
    const unreadable: string[] = [];
    const scan: ScanOptions = {
      onUnreadable: (path) => unreadable.push(path),
      ...(options.since === null ? {} : { since: options.since }),
      ...(options.maxSessions === null ? {} : { maxSessions: options.maxSessions }),
    };
    const sessions = plugin.scanProject(project, scan);
    const result = analyse(plugin.displayName, project, sessions, unreadable);
    results.push(result);
    lines.push(...describeAnalysis(result));
    if (!options.write) continue;
    if (result.recommendations.length === 0) {
      lines.push('  nothing to write');
      continue;
    }
    const target = plugin.contextTarget();
    const outcome = writeRecommendations(options.projectPath, target.contextFile, result, {
      dryRun: false,
    });
    lines.push(
      outcome.unchanged
        ? `  ${target.contextFile} already said this`
        : `  ${outcome.replaced ? 'replaced the block in' : 'added a block to'} ${target.contextFile}`
    );
  }
  if (options.json) {
    return { lines: [JSON.stringify(results, null, 2)], results, exitCode: 0 };
  }
  return { lines, results, exitCode: 0 };
}

async function main(): Promise<void> {
  const outcome = await run(process.argv.slice(2));
  for (const line of outcome.lines) console.log(line);
  process.exitCode = outcome.exitCode;
}

// Only when run as a program. Imported by the tests, which call run() directly.
const invoked = process.argv[1] ?? '';
if (invoked.endsWith('cli.js') || invoked.endsWith('cli.ts')) {
  void main();
}