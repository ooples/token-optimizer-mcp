// GENERATED FILE -- do not edit.
// Source of truth: hooks-core/routing.mjs. Regenerate with `npm run sync:hooks`.
/**
 * Model routing, decided by outcomes rather than by a rule of thumb.
 *
 * The competing approach sizes a task up front -- short task, few files, use
 * the small model -- and never checks whether that was right. A guess made
 * before the work and never compared against the result is not routing advice,
 * it is a preference with a confident tone.
 *
 * The loop can be closed here, because the client's transcript records which
 * model ran each turn AND what happened: which tools were called, which files
 * were touched, and which tool results came back as errors. That turns routing
 * into a measurement about THIS codebase --
 *
 *   multi-file refactor: the small model needed a retry in 7 of 9 attempts,
 *   the large model in 1 of 9
 *
 * -- rather than a generalisation about tasks. Heuristics still ship, as the
 * cold start, and are progressively outvoted by evidence. Same shape as the
 * waste detectors: a floor so day one is not blank, and a project-specific
 * layer that eventually knows better.
 *
 * A WRONG CALL IS NOT SYMMETRIC, and treating routing accuracy as one number
 * hides that. An overpowered model wastes money on a task that would have
 * succeeded anyway. An underpowered one burns a retry, sometimes a revert, and
 * the user's attention -- and frequently costs MORE in total than the expensive
 * model would have. Both directions are priced from this project's observed
 * rates, and the threshold falls out of the arithmetic instead of being a taste
 * setting.
 *
 * NOTHING HERE EDITS YOUR FILES. Writing routing advice into CLAUDE.md means
 * permanent prefix weight, a staleness guard to stop it going off, and an edit
 * to somebody else's file. The advice goes to the surfaces we already own.
 */

import { readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** Episodes of a (shape, model) pair before its measurement outvotes the heuristic. */
export const MIN_EPISODES = 5;

/**
 * Error rate above which a tier is not a candidate at any price.
 *
 * THE ONE POLICY CONSTANT HERE, and it earns its place: token arithmetic alone
 * will happily route work to a model that fails most of the time, because four
 * cheap turns still cost fewer tokens than one expensive one. What that
 * calculation cannot see is the half of the cost that is not in tokens -- the
 * failed attempt, the revert, and the user watching it happen. A tier that
 * needs a retry in more than half its episodes is a false economy, so it is
 * excluded rather than merely priced.
 */
export const MAX_ERROR_RATE = 0.5;

/**
 * Relative cost per token, by model tier.
 *
 * Approximate published ratios, not prices -- absolute prices change and a
 * hardcoded dollar figure goes stale silently. Override with
 * TOKEN_OPTIMIZER_MODEL_COSTS as JSON when they move.
 */
export function modelCosts() {
  const raw = process.env.TOKEN_OPTIMIZER_MODEL_COSTS;
  if (raw) {
    try {
      return JSON.parse(raw);
    } catch { /* fall through to the defaults */ }
  }
  return { haiku: 1, sonnet: 3, opus: 15 };
}

/** Which tier a model id belongs to. */
export function tierOf(model) {
  const name = String(model || '').toLowerCase();
  if (name.includes('haiku')) return 'haiku';
  if (name.includes('sonnet')) return 'sonnet';
  if (name.includes('opus')) return 'opus';
  return null;
}

/* ------------------------------------------------------------- OBSERVATION */

const FILE_KEYS = ['file_path', 'filePath', 'path', 'notebook_path'];

/**
 * Splits a transcript into episodes: one user request and everything the
 * assistant did about it.
 *
 * The episode is the right unit because the interesting outcome -- did this
 * take one turn or five, did anything error -- is a property of the whole
 * attempt, not of any single turn inside it.
 */
export function readEpisodes(path, { maxBytes = 6_000_000 } = {}) {
  if (!path) return [];
  let text;
  try {
    const size = statSync(path).size;
    const body = readFileSync(path, 'utf8');
    text = size > maxBytes ? body.slice(size - maxBytes) : body;
  } catch {
    return [];
  }

  const episodes = [];
  let current = null;

  const close = () => {
    if (current && current.turns > 0) episodes.push({ ...current, files: [...current.files], tools: [...current.tools] });
    current = null;
  };

  for (const line of text.split('\n')) {
    if (!line.startsWith('{')) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }

    // A real user message -- a string body rather than a tool result -- starts
    // a new episode.
    if (row.type === 'user' && typeof row.message?.content === 'string') {
      close();
      current = { at: Date.parse(row.timestamp) || null, models: new Set(), tools: new Set(), files: new Set(), turns: 0, errors: 0, results: 0 };
      continue;
    }
    if (!current) continue;

    if (row.type === 'assistant') {
      current.turns += 1;
      if (row.message?.model) current.models.add(row.message.model);
      for (const part of row.message?.content || []) {
        if (part?.type !== 'tool_use') continue;
        current.tools.add(part.name);
        for (const key of FILE_KEYS) {
          const value = part.input?.[key];
          if (typeof value === 'string' && value) current.files.add(value);
        }
      }
      continue;
    }

    if (row.type === 'user' && Array.isArray(row.message?.content)) {
      for (const part of row.message.content) {
        if (part?.type !== 'tool_result') continue;
        current.results += 1;
        if (part.is_error) current.errors += 1;
      }
    }
  }

  close();
  return episodes.map((e) => ({ ...e, models: [...e.models] }));
}

/* ---------------------------------------------------------------- SHAPES */

const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit', 'smart_edit', 'smart_write']);
const TEST_PATTERN = /\b(test|jest|pytest|vitest|dotnet test|npm test|go test)\b/i;

/**
 * What kind of work this was.
 *
 * Deliberately coarse. A fine-grained taxonomy splits the evidence into cells
 * too small to measure, and a routing table with one episode per row is a table
 * of anecdotes.
 */
export function classifyShape(episode) {
  const tools = new Set(episode.tools || []);
  const edited = [...tools].some((t) => EDIT_TOOLS.has(t));
  const files = (episode.files || []).length;
  const ranTests = [...tools].some((t) => TEST_PATTERN.test(t)) || (episode.tools || []).includes('Bash');

  if (edited && files >= 3) return 'multi-file-change';
  if (edited) return 'single-file-change';
  if (files > 0 || tools.has('Grep') || tools.has('Glob') || tools.has('smart_grep')) return 'investigation';
  if (ranTests) return 'build-or-test';
  return 'conversation';
}

/** Day-one routing, before this project has said anything. */
export const HEURISTIC = {
  'multi-file-change': 'opus',
  'single-file-change': 'sonnet',
  investigation: 'sonnet',
  'build-or-test': 'haiku',
  conversation: 'haiku',
};

/* ------------------------------------------------------------ MEASUREMENT */

/**
 * Observed outcomes per shape and model tier.
 *
 * `meanTurns` is the cost multiplier that matters: a cheap model that takes
 * three turns where an expensive one takes one is not cheap.
 */
export function outcomeTable(episodes) {
  const table = {};

  for (const episode of episodes) {
    const shape = classifyShape(episode);
    // An episode that changed model midway cannot be attributed to either.
    const tiers = new Set((episode.models || []).map(tierOf).filter(Boolean));
    if (tiers.size !== 1) continue;
    const tier = [...tiers][0];

    table[shape] = table[shape] || {};
    const cell = table[shape][tier] = table[shape][tier] || { episodes: 0, turns: 0, errors: 0, results: 0, errored: 0 };
    cell.episodes += 1;
    cell.turns += episode.turns;
    cell.errors += episode.errors;
    cell.results += episode.results;
    if (episode.errors > 0) cell.errored += 1;
  }

  for (const shape of Object.keys(table)) {
    for (const tier of Object.keys(table[shape])) {
      const cell = table[shape][tier];
      cell.meanTurns = cell.turns / cell.episodes;
      cell.errorRate = cell.episodes ? cell.errored / cell.episodes : 0;
      cell.measured = cell.episodes >= MIN_EPISODES;
    }
  }
  return table;
}

/**
 * Expected cost of running this shape on this tier, in relative units.
 *
 * Turns and errors both multiply: a retry is another whole attempt, so a tier
 * that fails a third of the time is not a third worse, it is a third of another
 * attempt more expensive.
 */
export function expectedCost(tier, cell) {
  const unit = modelCosts()[tier];
  if (unit == null) return null;
  if (!cell) return { tier, cost: unit, basis: 'heuristic' };
  return {
    tier,
    cost: unit * cell.meanTurns * (1 + cell.errorRate),
    meanTurns: cell.meanTurns,
    errorRate: cell.errorRate,
    episodes: cell.episodes,
    basis: cell.measured ? 'measured' : 'thin',
  };
}

/**
 * The recommendation, with BOTH errors priced.
 *
 * Reporting one accuracy number would hide the asymmetry that makes routing
 * hard: over-powering wastes money on work that would have succeeded, and
 * under-powering buys a retry, a revert and an interruption. The threshold is
 * not a setting here -- it is wherever the two expected costs cross.
 */
export function route(shape, table = {}) {
  const cells = table[shape] || {};
  const tiers = Object.keys(modelCosts());

  const options = tiers
    .map((tier) => expectedCost(tier, cells[tier]))
    .filter(Boolean)
    .sort((a, b) => a.cost - b.cost);

  const measured = options.filter((o) => o.basis === 'measured');
  const heuristic = HEURISTIC[shape] || 'sonnet';

  if (!measured.length) {
    return {
      shape,
      recommend: heuristic,
      basis: 'heuristic',
      reason: `no measured history for ${shape} yet; routing on the shipped default`,
      options,
    };
  }

  // Excluded before ranking, not discounted within it. See MAX_ERROR_RATE.
  const eligible = measured.filter((o) => o.errorRate <= MAX_ERROR_RATE);
  const excluded = measured.filter((o) => o.errorRate > MAX_ERROR_RATE);

  if (!eligible.length) {
    return {
      shape,
      recommend: heuristic,
      basis: 'heuristic',
      reason: `every measured tier for ${shape} needed a retry in more than ` +
        `${Math.round(MAX_ERROR_RATE * 100)}% of episodes; falling back to the shipped default`,
      excluded: excluded.map((o) => ({ tier: o.tier, errorRate: o.errorRate })),
      options,
    };
  }

  const best = eligible[0];
  // Compared against MEASURED tiers only. Ranking a measured expected cost
  // against another tier's bare per-token price would compare a number that
  // includes retries against one that does not.
  const cheapest = measured[0];
  const strongest = measured[measured.length - 1];

  return {
    shape,
    recommend: best.tier,
    basis: 'measured',
    // What each mistake would cost, from this project's own rates.
    overpowered: strongest.tier === best.tier ? null : {
      tier: strongest.tier,
      wasted: Number((strongest.cost - best.cost).toFixed(2)),
    },
    underpowered: cheapest.tier === best.tier ? null : {
      tier: cheapest.tier,
      expectedCost: Number(cheapest.cost.toFixed(2)),
      errorRate: cheapest.errorRate,
      excluded: cheapest.errorRate > MAX_ERROR_RATE,
    },
    reason: `${shape}: ${best.tier} costs ${best.cost.toFixed(2)} in expectation over ${best.episodes} episodes ` +
      `(${Math.round(best.errorRate * 100)}% needed a retry)`,
    options,
  };
}

/* -------------------------------------------------------------- DELIVERY */

/**
 * The at-the-decision note, including what the switch itself costs.
 *
 * Advice to change model that ignores the warm prefix it discards is
 * incomplete: on a long session the re-write can cost more than the routing
 * saves, and the right answer becomes "switch at the next natural break"
 * rather than "switch" or "do not".
 */
export function routingNote(shape, table, { currentModel, switchCost } = {}) {
  const decision = route(shape, table);
  const current = tierOf(currentModel);
  if (current && current === decision.recommend) return null;

  const lines = [decision.reason];

  if (decision.underpowered) {
    lines.push(`  ${decision.underpowered.tier} looks cheaper per token, but needed a retry in ` +
      `${Math.round(decision.underpowered.errorRate * 100)}% of episodes -- expected cost ${decision.underpowered.expectedCost}` +
      `${decision.underpowered.excluded ? ', which is why it is not a candidate here at any price' : ''}.`);
  }
  if (decision.overpowered) {
    lines.push(`  ${decision.overpowered.tier} would spend ${decision.overpowered.wasted} more than needed here.`);
  }

  if (switchCost?.prefixTokens) {
    lines.push(`  Switching now also discards a ${switchCost.prefixTokens.toLocaleString()}-token warm prefix ` +
      `(~${switchCost.rewriteCost.toLocaleString()} tokens to re-write); consider switching at the next break.`);
  }

  return { shape, recommend: decision.recommend, basis: decision.basis, text: lines.join('\n') };
}

/**
 * Routing facts for the session-start briefing.
 *
 * NUMBER-FREE ON PURPOSE. This text sits near the front of the prompt prefix,
 * and a count that ticks up as evidence accumulates would change the prefix
 * every session and invalidate the cache behind it -- the optimizer paying for
 * its own advice. Shape and tier are stable for long stretches; the numbers
 * live in the report, where changing costs nothing.
 */
export function routingBriefing(table) {
  const lines = [];
  for (const shape of Object.keys(table)) {
    const decision = route(shape, table);
    if (decision.basis !== 'measured') continue;
    if (decision.recommend === HEURISTIC[shape]) continue; // nothing learned worth saying
    lines.push(`${shape.replace(/-/g, ' ')} work goes better on ${decision.recommend} in this project.`);
  }
  return lines.length ? lines.join('\n') : null;
}

/**
 * The briefing, memoised.
 *
 * Parsing a transcript costs half a second on a large one, and this runs on the
 * SessionStart path where it blocks the user's first turn. Measured at 0.5s
 * against a 70 MB transcript, which is not a price worth paying every session
 * for a fact that changes about once a week.
 *
 * Recomputing rarely is also the CORRECT behaviour rather than a compromise:
 * this text lands in the prompt prefix, so a briefing that shifted whenever a
 * few more episodes accumulated would invalidate the cache behind it. Stability
 * is the feature; the memo is how it is bought.
 */
export function cachedRoutingBriefing(dir, transcriptPath, { growthBytes = 4_000_000, maxAgeMs = 24 * 60 * 60 * 1000 } = {}) {
  const memoPath = join(dir, 'routing-brief.json');
  let stat;
  try {
    stat = statSync(transcriptPath);
  } catch {
    return null;
  }

  try {
    const memo = JSON.parse(readFileSync(memoPath, 'utf8'));
    const fresh = memo.path === transcriptPath
      && Math.abs(stat.size - memo.size) < growthBytes
      && Date.now() - memo.at < maxAgeMs;
    if (fresh) return memo.text || null;
  } catch { /* no memo, or an unreadable one; recompute */ }

  const text = routingBriefing(outcomeTable(readEpisodes(transcriptPath)));
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(memoPath, JSON.stringify({ path: transcriptPath, size: stat.size, at: Date.now(), text }), { mode: 0o600 });
  } catch { /* the memo is an optimisation; failing to write it costs latency, not correctness */ }

  return text;
}

/** The full table, numbers and all, for the audit surface. */
export function routingReport(table) {
  const shapes = Object.keys(table);
  if (!shapes.length) return null;

  const lines = [];
  for (const shape of shapes) {
    const decision = route(shape, table);
    lines.push(`${shape} -> ${decision.recommend} (${decision.basis})`);
    for (const tier of Object.keys(table[shape])) {
      const cell = table[shape][tier];
      const cost = expectedCost(tier, cell);
      lines.push(`    ${tier.padEnd(7)} ${cell.episodes} episode(s), ` +
        `${cell.meanTurns.toFixed(1)} turns avg, ${Math.round(cell.errorRate * 100)}% needed a retry, ` +
        `expected cost ${cost.cost.toFixed(2)}${cell.measured ? '' : ' [too few episodes to trust]'}`);
    }
  }
  return lines.join('\n');
}
