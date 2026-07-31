/**
 * The annotated skeleton: what a refusal returns INSTEAD of a file.
 *
 * THE POINT IS NOT COMPRESSION. Competing tools transform content -- a delta, a
 * structure map, a head/tail slice -- so the model gets fewer bytes of the same
 * thing. Every one of those is strictly worse than the file it replaces.
 *
 * This returns the file's structure PLUS what has been learned about it, which
 * can be strictly BETTER than the file:
 *
 *     auth.ts -- 91 KB, structure + what we know
 *       function verify(token)   ! compares exp against the local clock
 *       class Session
 *         refresh()              only called from the sweeper, never the request path
 *       [decision] per-host retry budgets; global was rejected (deadlocked)
 *       [git] 47 changes in 90d; last three: "fix token expiry", "revert skew
 *             fix", "fix token expiry again"
 *
 * A tool with no knowledge layer cannot produce that, because it has nowhere to
 * keep the middle section. It is the difference between compressing transport
 * and carrying knowledge.
 *
 * COLD FILES ARE NOT KNOWLEDGE-FREE. A file nobody has studied still has a
 * history, and history is knowledge: change frequency, recency, and above all a
 * revert-then-redo pattern in the log is a dead end announcing itself on first
 * contact. That is available on day one, costs a git call, and is exactly the
 * kind of thing a compression tool cannot use even if it had it.
 */

import { execFileSync } from 'node:child_process';
import { dirname } from 'node:path';
import { extractSymbols } from './symbols.mjs';
import { canonicalPath } from './paths.mjs';
import { nodeId, findingsFor } from './wiki.mjs';
import { serve } from './staleness.mjs';

const estimate = (text) => Math.ceil(String(text || '').length / 4);

/**
 * Git signals for a file, or null when git is unavailable or the file is
 * untracked.
 *
 * Bounded and fail-quiet: this runs inside a hook, so a slow or missing git must
 * cost nothing. Nothing here fails the substitution.
 */
export function gitSignals(path, { commits = 5, timeoutMs = 1500 } = {}) {
  const cwd = dirname(path);
  const run = (args) => execFileSync('git', args, {
    cwd, timeout: timeoutMs, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
  }).trim();

  try {
    const log = run(['log', `-n${commits}`, '--format=%ar\t%s', '--', path]);
    if (!log) return null;

    const entries = log.split('\n').map((line) => {
      const tab = line.indexOf('\t');
      return { when: line.slice(0, tab), subject: line.slice(tab + 1) };
    });

    let churn = null;
    try {
      churn = run(['rev-list', '--count', '--since=90.days', 'HEAD', '--', path]);
    } catch { /* shallow clone, or no history window */ }

    return { entries, churn: churn ? Number(churn) : null };
  } catch {
    return null;
  }
}

/**
 * Detects the shape that says "this was tried and undone".
 *
 * A subject repeated on either side of a revert is a dead end the repository is
 * telling you about before anyone has studied the file. It is the single most
 * valuable thing available about a cold file, and it is free.
 */
export function contestedHistory(entries) {
  if (!entries || entries.length < 3) return null;

  const subjects = entries.map((e) => e.subject.toLowerCase());
  const reverted = subjects.findIndex((s) => s.startsWith('revert') || s.includes('revert '));
  if (reverted === -1) return null;

  // A subject that appears both before and after the revert means the change
  // was undone and then re-attempted -- someone went round this loop already.
  for (let i = 0; i < subjects.length; i++) {
    if (i === reverted) continue;
    for (let j = i + 1; j < subjects.length; j++) {
      if (j === reverted) continue;
      if ((i < reverted) !== (j < reverted) && similar(subjects[i], subjects[j])) {
        return `"${entries[i].subject}" was reverted and re-attempted -- this has been round the loop before`;
      }
    }
  }
  return `a revert sits in the recent history ("${entries[reverted].subject}")`;
}

/** Rough subject similarity: enough shared significant words to be the same intent. */
function similar(a, b) {
  const words = (s) => new Set(String(s).split(/\W+/).filter((w) => w.length > 3));
  const left = words(a);
  const right = words(b);
  if (left.size === 0 || right.size === 0) return false;

  let shared = 0;
  for (const word of left) if (right.has(word)) shared++;
  return shared >= 2 || shared / Math.min(left.size, right.size) >= 0.6;
}

/**
 * Builds the substitution for a file.
 *
 * @param {object} graph   Loaded wiki graph.
 * @param {string} rawPath As the caller spelled it -- shown back to them.
 * @param {string} source  File contents.
 * @param {number} budget  Token ceiling for the whole substitution.
 */
export function annotatedSkeleton(graph, rawPath, source, { budget = 1200, git = true } = {}) {
  const path = canonicalPath(rawPath);
  const symbols = extractSymbols(path, source);

  // Findings anchored to this file or the symbols inside it, served through the
  // one function that enforces the stale-plus-diff rule.
  const served = serve(graph, findingsFor(graph, nodeId('file', path), { limit: 40 }));

  // Index findings by the symbol they anchor to, so each one sits beside the
  // code it is about rather than in a separate list the reader must correlate.
  const bySymbol = new Map();
  const fileLevel = [];
  for (const finding of served) {
    const anchor = graph.edges
      .filter((e) => e.edge === 'derived_from' && e.from === finding.id)
      .map((e) => graph.nodes.get(e.to))
      .find(Boolean);

    if (anchor && anchor.kind === 'symbol' && anchor.name) {
      if (!bySymbol.has(anchor.name)) bySymbol.set(anchor.name, []);
      bySymbol.get(anchor.name).push(finding);
    } else {
      fileLevel.push(finding);
    }
  }

  const lines = [];
  let spent = 0;
  const push = (line) => {
    const cost = estimate(line);
    if (spent + cost > budget) return false;
    lines.push(line);
    spent += cost;
    return true;
  };

  const kb = Math.round(source.length / 1024);
  push(`${rawPath} -- ${kb} KB. Structure and what is known about it, instead of the file.`);
  push('');

  // Symbols carrying findings first: the most-studied parts of the file are the
  // parts that survive the budget.
  const ranked = [...symbols].sort((a, b) =>
    (bySymbol.get(b.name)?.length || 0) - (bySymbol.get(a.name)?.length || 0));

  let shown = 0;
  for (const symbol of ranked) {
    const notes = bySymbol.get(symbol.name) || [];
    if (!push(`  ${symbol.name}  (line ${symbol.line})`)) break;
    shown++;
    for (const note of notes) {
      const mark = note.stale ? '! STALE ' : '';
      if (!push(`      ${mark}${note.claim}`)) break;
    }
  }
  if (shown < symbols.length) push(`  ... ${symbols.length - shown} more symbols`);

  if (fileLevel.length) {
    push('');
    for (const finding of fileLevel) {
      const tag = finding.type && finding.type !== 'finding' ? `[${finding.type}] ` : '';
      if (!push(`  ${tag}${finding.stale ? '! STALE ' : ''}${finding.claim}`)) break;
    }
  }

  // COLD FILE: no findings yet. The history is the knowledge we do have, and it
  // is the part a compression tool could never surface.
  if (!served.length && git) {
    const signals = gitSignals(path);
    if (signals) {
      push('');
      push('  Nothing learned about this file yet. From its history:');
      const contested = contestedHistory(signals.entries);
      if (contested) push(`    ! ${contested}`);
      if (signals.churn) push(`    changed ${signals.churn} times in the last 90 days`);
      for (const entry of signals.entries.slice(0, 3)) {
        if (!push(`    ${entry.when}: ${entry.subject}`)) break;
      }
    }
  }

  push('');
  push(`  Call smart_read with path="${rawPath}" for the full contents.`);

  return { text: lines.join('\n'), tokens: spent, findings: served.length, symbols: symbols.length };
}
