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
    lines.push('Measured, from the selected Claude Code transcript:');
    lines.push(
      `  Anthropic cache-read input .... ${health.read.toLocaleString()} tokens`
    );
    lines.push(
      `  Anthropic cache-write input ... ${health.written.toLocaleString()} tokens`
    );
    lines.push(
      `  hit rate ............ ${Math.round((health.hitRate || 0) * 100)}%`
    );
    lines.push(
      `  warm prefix ......... ${health.prefixTokens.toLocaleString()} tokens`
    );
    lines.push(
      `  read discount vs uncached ... ${health.inputCostEquivalentAvoidedVersusUncached.toLocaleString()} uncached-input cost-equivalent tokens`
    );
    lines.push(
      '  billing caveat ....... Anthropic-specific equivalent; excluded from universal savings and not an invoice'
    );

    const models = Object.keys(health.models);
    if (models.length > 1) {
      const cost = mods.cache.modelSwitchCost(turns);
      lines.push(
        `  ! ${models.length} models used in this session -- each switch re-writes the prefix ` +
          `(about ${cost.rewriteInputCostEquivalent.toLocaleString()} Anthropic uncached-input cost-equivalent tokens at its current size)`
      );
    }
  } else {
    lines.push(
      'No Anthropic cache measurements available: a Claude Code transcript could not be read.'
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

  // AND THE DECISION IS RECORDED, which is what closes the loop.
  //
  // `recordRefresh` and `recordRefreshOutcome` had no call site anywhere, so
  // `tripwire` could never reach the ten outcomes it demands before it is
  // allowed an opinion -- it returned "only 0/10 refreshes observed" for the
  // life of the project, and `keepWarmDecision` could never learn that its
  // modelled hit rate was wrong. A backstop that cannot reach its own threshold
  // is not a backstop.
  //
  // WHAT IS RECORDED IS THE ADVICE, and the ledger means exactly that: this
  // tool advises, the user acts. `scoreOutstandingRefreshes` then reads the
  // event log to see whether a turn actually arrived inside the window this
  // advice predicted, so what accumulates is "was the recommendation right",
  // which is the question the tripwire and the decision both need answered.
  if (decision.action === 'refresh') {
    try {
      mods.keepwarm.recordRefresh(dir, {
        tier: decision.tier,
        prefixTokens: health?.prefixTokens,
        expectedValue: decision.expectedValue,
      });
    } catch {
      /* the ledger is evidence, never a reason to fail the report */
    }
  }

  const trip = mods.keepwarm.tripwire(dir);
  if (trip.tripped) lines.push(`  tripwire: ${trip.reason}`);
  else if (trip.observed > 0) {
    lines.push(`  ledger: ${trip.reason}`);
  }

  return say(lines.join('\n'));
}

export const CACHE_TOOL = {
  name: 'cache_audit',
  description:
    'Report Anthropic prompt-cache economics for this project: measured cache-read input, cache-write input, hit rate, and warm prefix size read from a Claude Code transcript, plus likely invalidation sources. Cost equivalents are labeled Anthropic-specific, excluded from universal savings, and are not invoices.',
  inputSchema: { type: 'object', properties: {} },
} as const;
