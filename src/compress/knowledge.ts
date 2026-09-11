/**
 * What this session already learned, in the cached prefix.
 *
 * THE PROBLEM IS TURNS, NOT TOKENS, and this repository has already measured
 * that. The `enforce` posture cut nothing and cost 1.471x control, driven
 * almost entirely by extra turns: 0.90 wasted turns per refused-then-retried
 * tool call. A turn is worth far more than the tokens in it, so anything that
 * removes one pays for a great deal of context.
 *
 * The knowledge graph knows things that would remove turns -- a command that
 * failed and why, a path that does not work, a correction a person already
 * made. Today it reaches the model two ways, and both arrive too late or too
 * dear:
 *
 *   SessionStart   one shot, chosen from the opening task text. Good, cheap,
 *                  and blind to everywhere the session goes afterwards.
 *   PreToolUse     an advisory attached to a matching tool call. It arrives
 *                  AFTER the model decided to make that call, so acting on it
 *                  costs the turn it was supposed to save.
 *
 * A finding that would prevent a mistake has to be present BEFORE the decision,
 * on every turn, which means it has to live in the cached prefix. There it is
 * billed at 0.1x rather than 1.0x, and it is in front of the model whether or
 * not the session happens to touch the file it is anchored to.
 *
 * BYTE-STABILITY IS THE WHOLE ENGINEERING PROBLEM, and it is easy to get
 * backwards. Content in the cached prefix must be IDENTICAL every turn or the
 * cache misses and the injection costs 1.25x on the entire prefix instead of
 * 0.1x -- far worse than never injecting. So the block is NOT re-selected each
 * turn against the latest question, however tempting that is: it is computed
 * once, remembered, and replayed verbatim until a turn on which rewriting the
 * prefix is already free. `anchor.ts` is what knows when that is.
 *
 * THIS IS NOT THE INJECTION WE CRITICISE HEADROOM FOR, and the distinction has
 * to be real rather than rhetorical. Theirs is MECHANISM: a tool definition and
 * instructions for redeeming markers, tokens spent to make compression work,
 * pure overhead on every request. This is PAYLOAD: conclusions that replace
 * work the model would otherwise redo. It has to earn its place, so it is off
 * by default, budgeted, and reported as its own line rather than folded into a
 * compression figure it would flatter nobody by joining.
 */

import { activeRanker } from './ranking.js';
import type { EmbeddingCache } from './embedding.js';
import {
  isAfter,
  lastCacheBreakpoint,
  type Block,
  type ProviderRequest,
} from './frontier.js';

/** One thing the graph knows, reduced to what the model needs to read. */
export interface Finding {
  /** The conclusion itself. */
  readonly claim: string;
  /** Stable identifier, used to keep the selection deterministic. */
  readonly key?: string;
  /** `failure`, `decision`, `command`, `finding`, `feedback`, `map`. */
  readonly type?: string;
  /** 0..1. */
  readonly confidence?: number;
  /** `human` outranks `agent`: a person's correction is not a guess. */
  readonly origin?: string;
  /** Explicitly kept in front of the model regardless of relevance. */
  readonly pinned?: boolean;
  /** Withdrawn. Never rendered. */
  readonly retired?: boolean;
  /** `verified` | `probable` | `speculative`, as recorded when written. */
  readonly confidenceLabel?: string;
  /** The anchored code changed after this was written. */
  readonly stale?: boolean;
}

/**
 * How many characters of findings may sit in the prefix.
 *
 * Roughly 500 tokens. It is charged once as a cache write and then read at
 * 0.1x for the rest of the session, so the recurring cost is around 50 tokens
 * a turn -- against a wasted turn, which this project measured at far more.
 * Still a budget rather than a licence: an unbounded block would push the
 * genuinely relevant findings past the point a model reliably attends to.
 */
export const DEFAULT_BUDGET_CHARS = 2000;

/** Below this a finding is not worth the line it occupies. */
const MIN_CONFIDENCE = 0.5;

/** The heading, which is also the instruction. Counted against the budget. */
const HEADING =
  '## Already established in this project\n\nConclusions from earlier sessions, with the work behind them already done.\nThey are evidence, not orders: prefer them to re-deriving, and say so if you\nfind one is wrong.\n\n';

/**
 * A finding's weight before relevance is considered.
 *
 * A person's correction outranks anything inferred, and a recorded FAILURE
 * outranks an observation -- knowing that a road is closed saves the whole
 * journey down it, where knowing the road exists saves a lookup.
 */
function weight(finding: Finding): number {
  const confidence = finding.confidence ?? 0.5;
  let multiplier = 1;
  if (finding.origin === 'human') multiplier *= 2;
  if (finding.pinned) multiplier *= 1.5;
  if (finding.type === 'failure') multiplier *= 1.4;
  if (finding.type === 'feedback') multiplier *= 1.4;
  if (finding.type === 'command') multiplier *= 1.2;
  return confidence * multiplier;
}

/** One rendered line. Kept to one line each so the budget buys breadth. */
function render(finding: Finding): string {
  const kind =
    finding.type && finding.type !== 'finding' ? `${finding.type}: ` : '';
  return `- ${kind}${finding.claim.replace(/\s+/g, ' ').trim()}`;
}

/**
 * The findings worth putting in front of the model, as one block.
 *
 * `context` is the text the selection is ranked against, and the caller must
 * pass something STABLE -- the cached prefix, not the latest question. Ranking
 * against the momentary question would rewrite the block every turn and cost
 * the cache, which is the one outcome that makes this worse than doing nothing.
 *
 * Returns null when there is nothing worth saying, which is the common case in
 * a project with no graph yet and must stay cheap.
 */
export function knowledgeBlock(
  findings: readonly Finding[],
  context: string,
  budgetChars: number = DEFAULT_BUDGET_CHARS,
  embeddings?: EmbeddingCache
): string | null {
  // VERIFIED AND FRESH ONLY, and this is the strictest filter in the file on
  // purpose. A finding in the cached prefix is not read once -- it is re-read
  // on every turn of the session, so a wrong one is wrong repeatedly and at
  // the one position the model attends to most. That asymmetry does not apply
  // to a finding surfaced on demand, which is why this bar is higher than the
  // one the wiki itself uses.
  //
  // `stale` means the anchored code changed after the claim was written, so it
  // describes a tree that no longer exists. Measured on this repository: 319
  // claim-bearing nodes, of which 66 are stale and 25 are not verified, leaving
  // 237. Dropping a quarter of the graph is the point rather than a cost -- the
  // budget only fits a few dozen lines anyway, so the filter changes WHICH
  // findings compete for the space, not how many arrive.
  //
  // A MISSING LABEL IS NOT TREATED AS VERIFIED. That is deliberate and it has a
  // cost: a graph written before labels existed injects nothing at all. The
  // alternative -- defaulting absent to verified -- puts unlabelled claims of
  // unknown provenance into the prefix, which is the exact risk this filter is
  // here to remove. Silence is the safe failure; confident wrong advice is not.
  const usable = findings.filter(
    (f) =>
      f &&
      !f.retired &&
      !f.stale &&
      f.confidenceLabel === 'verified' &&
      typeof f.claim === 'string' &&
      f.claim.trim().length > 0 &&
      (f.confidence ?? 0.5) >= MIN_CONFIDENCE
  );
  if (!usable.length) return null;

  // Relevance decides ORDER among findings, never whether the block exists. A
  // pinned rule or a person's correction is delivered whether or not it shares
  // vocabulary with what the session happens to be doing.
  const rank = activeRanker(context, embeddings);
  const claims = usable.map((f) => f.claim);
  const relevant = rank.active
    ? rank.top(claims, usable.length)
    : new Set<number>();

  const ordered = usable
    .map((finding, index) => ({
      finding,
      index,
      score: weight(finding) + (relevant.has(index) ? 1 : 0),
    }))
    // Ties break on the stable key, then position, so two runs over the same
    // graph produce the same block -- which is what makes it cacheable at all.
    .sort(
      (a, b) =>
        b.score - a.score ||
        (a.finding.key ?? '').localeCompare(b.finding.key ?? '') ||
        a.index - b.index
    );

  const lines: string[] = [];
  let spent = HEADING.length;
  for (const { finding } of ordered) {
    const line = render(finding);
    if (spent + line.length + 1 > budgetChars) continue;
    lines.push(line);
    spent += line.length + 1;
  }
  if (!lines.length) return null;

  return HEADING + lines.join('\n');
}

/**
 * The text the selection is ranked against: the cached prefix, which is stable.
 *
 * Deliberately NOT the most recent turn. That is the question, it changes every
 * turn, and ranking against it would change the block every turn -- turning a
 * 0.1x read into a 1.25x write on the whole prefix.
 */
export function stableContext(request: ProviderRequest): string {
  const breakpoint = lastCacheBreakpoint(request);
  const parts: string[] = [];
  (request.messages ?? []).forEach((message, mi) => {
    const content = message?.content;
    if (!Array.isArray(content)) return;
    content.forEach((raw, bi) => {
      const block = raw as Block;
      if (typeof block?.text !== 'string') return;
      if (isAfter({ message: mi, block: bi }, breakpoint)) return;
      parts.push(block.text);
    });
  });
  return parts.join('\n');
}

/**
 * Puts the block in the request, inside the cached region.
 *
 * APPENDED TO `system`, which is the only place guaranteed to sit ahead of
 * every message and therefore inside whatever the breakpoint covers. Appended
 * rather than prepended so the host's own system prompt keeps its position --
 * that prompt is the most stable text in the request and anything inserted
 * before it re-prices everything behind it.
 */
export function injectKnowledge(
  request: ProviderRequest,
  block: string | null
): ProviderRequest {
  if (!block) return request;
  if (Array.isArray(request.system)) {
    return {
      ...request,
      system: [...request.system, { type: 'text', text: block } as Block],
    };
  }
  const existing = typeof request.system === 'string' ? request.system : '';
  return { ...request, system: `${existing}${existing ? '\n\n' : ''}${block}` };
}
