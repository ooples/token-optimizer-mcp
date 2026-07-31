/**
 * The one thing to run.
 *
 * There were four audit tools before this and no obvious entry point, which is
 * precisely the gap the competing product's users describe about its six
 * agents. This is not a fifth report: it collects every finding the other
 * surfaces can produce -- waste detectors, cache attribution, routing -- ranks
 * them by measured cost per session, prices them, and hands back a queue where
 * each line names what to do about it.
 *
 * The specialised tools remain, for when you want the whole cache picture or
 * the full routing table. This is what you run when you do not know which of
 * them to run.
 */

import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { dirname } from 'path';

const here = dirname(fileURLToPath(import.meta.url));

function coreUrl(name: string): string {
  return pathToFileURL(path.join(here, '..', '..', 'hooks-core', name)).href;
}

interface AuditModules {
  audit: any;
  waste: any;
  cache: any;
  routing: any;
  wiki: any;
}

let cached: AuditModules | null = null;

async function modules(): Promise<AuditModules | null> {
  if (cached) return cached;
  try {
    const [audit, waste, cache, routing, wiki] = await Promise.all([
      import(coreUrl('audit.mjs')),
      import(coreUrl('waste.mjs')),
      import(coreUrl('cache.mjs')),
      import(coreUrl('routing.mjs')),
      import(coreUrl('wiki.mjs')),
    ]);
    cached = { audit, waste, cache, routing, wiki };
    return cached;
  } catch {
    return null;
  }
}

const say = (body: string, isError = false) => ({ content: [{ type: 'text', text: body }], isError });

export async function tokenAudit(input: {
  full?: boolean;
  tier?: string;
  sessionsPerMonth?: number;
  decline?: string;
}): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  const mods = await modules();
  if (!mods) return say('The audit is unavailable: the graph modules could not be loaded.', true);

  const cwd = process.cwd();
  const dir = mods.wiki.wikiDir(cwd);

  if (input?.decline) {
    mods.audit.decline(dir, input.decline);
    return say(`Noted. ${input.decline} will stop being suggested after ${mods.audit.DECLINE_LIMIT} declines.`);
  }

  let graph = null;
  try {
    graph = mods.wiki.load(dir);
  } catch { /* no graph costs the question-level detectors and nothing else */ }

  const findings = [...mods.waste.detect(dir, graph)];

  // Cache invalidation is waste with a file and a line attached, so it belongs
  // in the same queue rather than in a report of its own.
  try {
    const transcript = mods.cache.transcriptFor(cwd);
    const health = mods.cache.cacheHealth(mods.cache.readCacheUsage(transcript));
    for (const hit of mods.cache.attributeInvalidation(cwd, health?.prefixTokens ?? null)) {
      findings.push({
        id: 'cache-invalidation',
        title: `${hit.file}:${hit.line} has ${hit.why}, invalidating everything after it`,
        costPerSession: hit.costPerSession,
        file: hit.file,
        remedy: hit.remedy,
      });
    }

    // Routing is advice rather than a fix, and is listed as such.
    const table = mods.routing.outcomeTable(mods.routing.readEpisodes(transcript));
    for (const shape of Object.keys(table)) {
      const decision = mods.routing.route(shape, table);
      if (decision.basis !== 'measured' || !decision.underpowered) continue;
      findings.push({
        id: 'model-routing',
        title: `${shape} is being run on ${decision.underpowered.tier}, which needed a retry in ` +
          `${Math.round(decision.underpowered.errorRate * 100)}% of episodes -- ${decision.recommend} costs less in expectation`,
        costPerSession: null,
        remedy: null,
      });
    }
  } catch { /* no transcript: the detector findings still stand on their own */ }

  const out = mods.audit.renderAudit(dir, findings, {
    full: Boolean(input?.full),
    tier: input?.tier || 'opus',
    sessionsPerMonth: input?.sessionsPerMonth || 60,
  });

  // Recording that a finding was raised is what makes the before-and-after
  // measurable later; without it the trend has no point to split on.
  for (const item of findings) {
    try { mods.audit.raise(dir, item); } catch { /* never fail the audit over its own bookkeeping */ }
  }

  return say(out.text);
}

export const AUDIT_TOOL = {
  name: 'token_audit',
  description:
    'The one thing to run. A single ranked queue of what is costing the most in this project -- waste detectors, prompt-cache ' +
    'invalidation attributed to a file and line, and model routing -- each priced per session and per month, each naming how to ' +
    'act on it. Reports what already-applied fixes actually saved, whether habits improved since the advice, and its own token ' +
    'cost; findings worth less than their printing cost are withheld unless full=true. Pass decline="<id>" to stop being told ' +
    'about something.',
  inputSchema: {
    type: 'object',
    properties: {
      full: { type: 'boolean', description: 'Show every finding, including ones cheaper than printing them' },
      tier: { type: 'string', description: 'Pricing tier for the dollar figures (haiku, sonnet, opus). Default opus' },
      sessionsPerMonth: { type: 'number', description: 'Assumption behind the monthly figures. Default 60' },
      decline: { type: 'string', description: 'A finding id you do not want raised again' },
    },
  },
} as const;
