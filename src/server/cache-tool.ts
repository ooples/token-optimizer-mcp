/**
 * The cache audit, exposed as a tool.
 *
 * Reports what the cache actually did, from the client's own transcript, and
 * attributes every invalidation it can to the file and line that caused it --
 * because a hit rate says the cache missed and cannot say why.
 *
 * Every number here is measured or absent. Where the transcript is unavailable
 * the constructs are still reported, without prices, rather than with invented
 * ones.
 */

import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { dirname } from 'path';

const here = dirname(fileURLToPath(import.meta.url));

function coreUrl(name: string): string {
  return pathToFileURL(path.join(here, '..', '..', 'hooks-core', name)).href;
}

interface CacheModules {
  cache: any;
  keepwarm: any;
  wiki: any;
}

let cached: CacheModules | null = null;

async function modules(): Promise<CacheModules | null> {
  if (cached) return cached;
  try {
    const [cache, keepwarm, wiki] = await Promise.all([
      import(coreUrl('cache.mjs')),
      import(coreUrl('keepwarm.mjs')),
      import(coreUrl('wiki.mjs')),
    ]);
    cached = { cache, keepwarm, wiki };
    return cached;
  } catch {
    return null;
  }
}

const say = (body: string, isError = false) => ({
  content: [{ type: 'text', text: body }],
  isError,
});

export async function cacheAudit(): Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}> {
  const mods = await modules();
  if (!mods)
    return say(
      'The cache audit is unavailable: the graph modules could not be loaded.',
      true
    );

  const cwd = process.cwd();
  const dir = mods.wiki.wikiDir(cwd);
  const lines: string[] = [];

  const turns = mods.cache.readCacheUsage(mods.cache.transcriptFor(cwd));
  const health = mods.cache.cacheHealth(turns);

  if (health) {
    lines.push("Measured, from this client's own transcript:");
    lines.push(`  cache reads ......... ${health.read.toLocaleString()}`);
    lines.push(`  cache writes ........ ${health.written.toLocaleString()}`);
    lines.push(
      `  hit rate ............ ${Math.round((health.hitRate || 0) * 100)}%`
    );
    lines.push(
      `  warm prefix ......... ${health.prefixTokens.toLocaleString()} tokens`
    );
    lines.push(
      `  saved vs no cache ... ${health.savedVersusNoCache.toLocaleString()} tokens`
    );

    const models = Object.keys(health.models);
    if (models.length > 1) {
      const cost = mods.cache.modelSwitchCost(turns);
      lines.push(
        `  ! ${models.length} models used in this session -- each switch re-writes the prefix ` +
          `(about ${cost.rewriteCost.toLocaleString()} tokens at its current size)`
      );
    }
  } else {
    lines.push(
      "No cache measurements available: this client's transcript could not be read."
    );
    lines.push('The attribution below still applies, without prices.');
  }

  // Attribution: the half a hit rate cannot give.
  const blame = mods.cache.attributeInvalidation(
    cwd,
    health?.prefixTokens ?? null
  );
  if (blame.length) {
    lines.push('', 'Attributed cause:');
    for (const hit of blame.slice(0, 6)) {
      const price =
        hit.costPerSession != null
          ? `about ${hit.costPerSession.toLocaleString()} tokens re-written per session`
          : 'price unknown without a transcript measurement';
      lines.push(`  ! ${hit.file}:${hit.line} has ${hit.why} -- ${price}`);
      lines.push(`      ${hit.excerpt}`);
    }
    lines.push(
      '  These are your files, so they are proposed and never edited: remove the changing'
    );
    lines.push(
      '  value, or move that section to the end of the file so less sits behind it.'
    );
  } else {
    lines.push(
      '',
      'Attributed cause: nothing volatile found in the project instruction files.'
    );
  }

  // Keep-warm, decided rather than defaulted.
  const decision = mods.keepwarm.shouldKeepWarm(dir, {
    prefixTokens: health?.prefixTokens,
  });
  lines.push('', `Keep-warm: ${decision.action} -- ${decision.reason}`);

  const trip = mods.keepwarm.tripwire(dir);
  if (trip.tripped) lines.push(`  tripwire: ${trip.reason}`);

  return say(lines.join('\n'));
}

export const CACHE_TOOL = {
  name: 'cache_audit',
  description:
    'Report prompt-cache economics for this project: measured hit rate, cache-write spend and warm prefix size read from ' +
    "the client's own transcript, plus the file and line responsible for each invalidation priced by how much sits behind " +
    "it. Also reports whether keep-warm is worth buying at each TTL tier, decided from this project's observed gaps.",
  inputSchema: { type: 'object', properties: {} },
} as const;
