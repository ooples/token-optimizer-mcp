/**
 * Model routing, exposed as a tool.
 *
 * The report surface for routing: the full table with the numbers in it, plus
 * an at-the-decision note when the caller names the shape of work it is about
 * to do. The stable, number-free half of the same knowledge reaches the model
 * through the session-start briefing, where a changing digit would cost the
 * prompt cache.
 *
 * Advice only. Nothing here switches a model, and nothing here writes to the
 * user's files -- which is what the alternative approach does, at the cost of
 * permanent prefix weight and a staleness guard to stop the advice going off.
 */

import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { dirname } from 'path';

const here = dirname(fileURLToPath(import.meta.url));

function coreUrl(name: string): string {
  return pathToFileURL(path.join(here, '..', '..', 'hooks-core', name)).href;
}

interface RoutingModules {
  routing: any;
  cache: any;
}

let cached: RoutingModules | null = null;

async function modules(): Promise<RoutingModules | null> {
  if (cached) return cached;
  try {
    const [routing, cache] = await Promise.all([
      import(coreUrl('routing.mjs')),
      import(coreUrl('cache.mjs')),
    ]);
    cached = { routing, cache };
    return cached;
  } catch {
    return null;
  }
}

const say = (body: string, isError = false) => ({ content: [{ type: 'text', text: body }], isError });

export async function modelRouting(input: { shape?: string; currentModel?: string }): Promise<{
  content: Array<{ type: string; text: string }>; isError?: boolean;
}> {
  const mods = await modules();
  if (!mods) return say('Routing is unavailable: the graph modules could not be loaded.', true);

  const cwd = process.cwd();
  const transcript = mods.cache.transcriptFor(cwd);
  const episodes = mods.routing.readEpisodes(transcript);

  if (!episodes.length) {
    return say([
      'No routing history yet: this client\'s transcript could not be read, so there is nothing measured to route on.',
      'Until there is, the shipped defaults apply:',
      ...Object.entries(mods.routing.HEURISTIC).map(([shape, tier]) => `  ${shape} -> ${tier}`),
    ].join('\n'));
  }

  const table = mods.routing.outcomeTable(episodes);
  const lines = [`Measured over ${episodes.length} episode(s) in this project:`, '', mods.routing.routingReport(table) || '  nothing measurable yet'];

  if (input?.shape) {
    // The at-the-decision surface, including what the switch itself costs --
    // advice that ignores the warm prefix it discards is incomplete.
    const switchCost = mods.cache.modelSwitchCost(mods.cache.readCacheUsage(transcript));
    const note = mods.routing.routingNote(input.shape, table, { currentModel: input.currentModel, switchCost });
    lines.push('', note ? note.text : `Already on the right tier for ${input.shape}.`);
  }

  return say(lines.join('\n'));
}

export const ROUTING_TOOL = {
  name: 'model_routing',
  description:
    'Which model tier this project\'s work actually goes better on, measured from episode outcomes in the client transcript ' +
    'rather than guessed from task size. Reports expected cost per tier including retries, and prices BOTH mistakes: what an ' +
    'overpowered model wastes and what an underpowered one costs in retries. Pass `shape` (multi-file-change, ' +
    'single-file-change, investigation, build-or-test, conversation) and `currentModel` for a decision note that also states ' +
    'what switching would cost in discarded prompt cache.',
  inputSchema: {
    type: 'object',
    properties: {
      shape: { type: 'string', description: 'The kind of work about to be done' },
      currentModel: { type: 'string', description: 'The model in use now, e.g. claude-sonnet-5' },
    },
  },
} as const;
