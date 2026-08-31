/**
 * Standing context: what you pay for every session whether you use it or not.
 *
 * Skills, CLAUDE.md, AGENTS.md, MEMORY.md and agent definitions are one object,
 * not two audit features. They all sit in the prompt prefix of every session, so
 * they are charged per session forever and they are the surface a cache
 * invalidation propagates from.
 *
 * THE EVIDENCE IS MEASURED, NOT ESTIMATED. Competing tools flag unused skills
 * and review memory files with a panel of heuristic auditors; both are opinions
 * about size and age. Two harder signals are available here. The transcript
 * records which skills were actually invoked and which terms ever appeared in
 * the work, so "never used across 43 sessions" is a count. And a claim naming a
 * file or a function can be CHECKED against the code, so a memory entry
 * referring to something that no longer exists is provably stale rather than
 * suspected. Size still ranks the findings; it stops being the evidence.
 *
 * AND THE REMEDY IS NOT DELETION. Every audit tool recommends deleting what is
 * unused, which is exactly why people ignore them: the thing is there because
 * one day it might be needed, and losing it to save tokens is a bad trade a
 * reasonable person refuses. Two better moves, in order:
 *
 *   TRIM     what is used but bloated -- a proposed diff that keeps the
 *            substance and drops the padding.
 *   DEMOTE   what is never used -- moved into the graph as an anchored finding,
 *            costing nothing per session and arriving automatically the moment
 *            you touch the file it concerns.
 *
 * Something both bloated and unused gets both, in that order: trimmed to its
 * substance, then demoted. Nothing is deleted, and no file of yours is edited
 * without a diff and a yes.
 */

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, relative, basename, dirname } from 'node:path';

const estimate = (text) => Math.ceil(String(text || '').length / 4);

/** Sessions of evidence before "never used" means anything. */
export const MIN_SESSIONS = 5;

/** Tokens per session above which trimming is worth proposing. */
export const BLOAT_TOKENS = 400;

/* ------------------------------------------------------------- DISCOVERY */

/** Everything that is loaded whether or not it is needed. */
export function standingFiles(cwd) {
  const found = [];

  const add = (path, kind) => {
    try {
      const text = readFileSync(path, 'utf8');
      // A directory-style skill is named by its DIRECTORY: the file is always
      // SKILL.md, so taking the filename gave every such skill the name
      // "SKILL" -- and an invocation could then never match one.
      const file = basename(path, '.md');
      const name = file === 'SKILL' ? basename(dirname(path)) : file;
      found.push({
        path,
        rel: relative(cwd, path).split('\\').join('/'),
        kind,
        name,
        text,
        tokens: estimate(text),
      });
    } catch { /* not present, or not readable */ }
  };

  for (const name of ['CLAUDE.md', 'AGENTS.md', 'MEMORY.md']) add(join(cwd, name), 'instructions');
  add(join(cwd, '.claude', 'CLAUDE.md'), 'instructions');

  for (const [dir, kind] of [[join(cwd, '.claude', 'skills'), 'skill'], [join(cwd, '.claude', 'agents'), 'agent']]) {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) add(join(dir, entry.name, 'SKILL.md'), kind);
      else if (entry.name.endsWith('.md')) add(join(dir, entry.name), kind);
    }
  }

  return found;
}

/* --------------------------------------------------------------- USAGE */

/**
 * What the transcript says was actually used.
 *
 * Skill invocations are counted by name; everything else is counted by whether
 * its distinctive terms ever appeared in the work at all. Both are counts from
 * the record rather than judgements about the text.
 */
export function usageFrom(transcriptPath, { maxBytes = 8_000_000 } = {}) {
  let text = '';
  try {
    const size = statSync(transcriptPath).size;
    const body = readFileSync(transcriptPath, 'utf8');
    text = size > maxBytes ? body.slice(size - maxBytes) : body;
  } catch {
    return null;
  }

  const skills = new Map();
  const sessions = new Set();
  let corpus = '';

  for (const line of text.split('\n')) {
    if (!line.startsWith('{')) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (row.sessionId) sessions.add(row.sessionId);
    if (row.type === 'user' && typeof row.message?.content === 'string') {
      corpus += `\n${row.message.content}`;
    }
    if (row.type !== 'assistant') continue;

    for (const part of row.message?.content || []) {
      if (part?.type === 'text') corpus += `\n${part.text}`;
      if (part?.type !== 'tool_use') continue;
      // A skill invocation, however the client spells it.
      const name = part.input?.skill || part.input?.command || null;
      if ((part.name === 'Skill' || part.name === 'SlashCommand') && name) {
        const key = String(name).replace(/^\//, '');
        skills.set(key, (skills.get(key) || 0) + 1);
      }
      corpus += `\n${JSON.stringify(part.input || {})}`;
    }
  }

  return { skills, sessions: Math.max(sessions.size, 1), corpus: corpus.toLowerCase() };
}

/** Distinctive words in a piece of standing context, for the "ever applied" test. */
export function distinctiveTerms(text, { limit = 12 } = {}) {
  const common = new Set(['this', 'that', 'with', 'from', 'when', 'then', 'have', 'should', 'always',
    'never', 'must', 'code', 'file', 'files', 'user', 'using', 'used', 'make', 'sure', 'need', 'name']);
  const counts = new Map();
  for (const word of String(text).toLowerCase().match(/[a-z][a-z0-9_]{4,}/g) || []) {
    if (common.has(word)) continue;
    counts.set(word, (counts.get(word) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([word]) => word);
}

/* ------------------------------------------------------------ STALENESS */

const SYMBOL = /\b([A-Za-z_][A-Za-z0-9_]{2,})\s*\(\)/g;
/**
 * File paths mentioned in a line of prose.
 *
 * FOUND BY THE EXTENSION, THEN WALKED BACK. The single pattern this replaces was
 * `/\b([\w./-]+\.(?:ts|...))\b/g`, whose prefix class contains `.` -- so the
 * greedy `+` and the literal `\.` after it compete for every division of the
 * text, at every start position. Measured at 1,044ms on 32,000 characters of
 * `x/x/x/...`, and this runs over lines of real text.
 *
 * Anchoring on the extension gives one match attempt per extension rather than
 * one per character, and the walk backwards visits each character at most twice.
 */
const PATH_EXTENSION =
  /\.(?:ts|tsx|js|jsx|mjs|cjs|py|cs|go|rs|java|rb|php|sql|json|ya?ml)\b/g;

/** How far back a path may reach. Longer than any real one, short enough to bound the walk. */
const MAX_PATH_CHARS = 256;

function pathsIn(line) {
  const found = [];

  for (const match of line.matchAll(PATH_EXTENSION)) {
    const end = match.index + match[0].length;
    let start = match.index;
    const floor = Math.max(0, match.index - MAX_PATH_CHARS);

    while (start > floor && /[\w./-]/.test(line[start - 1])) start -= 1;

    // The pattern this replaces began with `\b`, so a match could only start on
    // a word character: `./a/b.ts` was captured as `a/b.ts`, without the `./`.
    // The walk backwards has no such rule of its own, and keeping the prefix
    // would hand canonicalisation a different string for the same file.
    while (start < end && !/\w/.test(line[start])) start += 1;

    // A bare `.ts` is not a path: something has to precede the dot. After the
    // trim above, that is exactly the question of whether anything survived in
    // front of the extension -- comparing the candidate's own prefix instead got
    // this wrong, because trimming `.ts` down to `ts` left a `t` to find.
    if (start < match.index) found.push(line.slice(start, end));
  }

  return found;
}

/**
 * Claims in a file that can be checked against the code, and whether they hold.
 *
 * PROVABLE rather than suspected: a line naming `runMigration()` in `db.ts` is
 * either true of the current tree or it is not, and no amount of heuristic
 * review is as good as looking. Lines naming nothing checkable are left alone
 * rather than guessed at -- an audit that flags prose it cannot verify is
 * generating work, not finding it.
 */
export function staleClaims(entry, cwd) {
  const out = [];
  const lines = String(entry.text || '').split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const paths = pathsIn(line);
    if (!paths.length) continue;

    for (const rawPath of paths) {
      const candidate = join(cwd, rawPath);
      if (!existsSync(candidate)) {
        // A path that does not resolve may simply be illustrative, so only a
        // path-looking token with a real directory prefix counts.
        if (!rawPath.includes('/')) continue;
        out.push({
          line: i + 1,
          claim: line.trim().slice(0, 140),
          why: `${rawPath} does not exist`,
          provable: true,
        });
        continue;
      }

      const symbols = [...line.matchAll(SYMBOL)].map((m) => m[1]);
      if (!symbols.length) continue;

      let source = '';
      try {
        source = readFileSync(candidate, 'utf8');
      } catch {
        continue;
      }
      for (const symbol of symbols) {
        if (source.includes(symbol)) continue;
        out.push({
          line: i + 1,
          claim: line.trim().slice(0, 140),
          why: `${rawPath} no longer contains ${symbol}`,
          provable: true,
        });
      }
    }
  }

  return out;
}

/* -------------------------------------------------------------- VERDICT */

/**
 * What to do about one piece of standing context.
 *
 * The order matters and is the whole design: TRIM keeps what is used and drops
 * the padding; DEMOTE moves what is never used somewhere it costs nothing.
 * Something that is both gets trimmed first and demoted second, so what lands
 * in the graph is the substance rather than the padding.
 */
export function verdictFor(entry, usage, cwd) {
  const stale = staleClaims(entry, cwd);

  const invocations = entry.kind === 'skill' || entry.kind === 'agent'
    ? (usage?.skills.get(entry.name) ?? 0)
    : null;

  const terms = distinctiveTerms(entry.text);
  const applied = usage && terms.length
    ? terms.filter((term) => usage.corpus.includes(term)).length
    : null;

  const enoughEvidence = usage && usage.sessions >= MIN_SESSIONS;
  const neverUsed = enoughEvidence && (
    invocations === 0 || (invocations === null && applied === 0)
  );
  const bloated = entry.tokens >= BLOAT_TOKENS;

  const actions = [];
  if (stale.length) {
    actions.push({
      action: 'fix',
      kind: 'yours',
      why: `${stale.length} claim(s) no longer hold against the code`,
      diff: stale.map((s) => `${entry.rel}:${s.line}\n- ${s.claim}\n+ (update or remove: ${s.why})`).join('\n'),
    });
  }
  if (bloated) {
    actions.push({
      action: 'trim',
      kind: 'yours',
      why: `${entry.tokens.toLocaleString()} tokens in every session's prefix`,
      diff: `${entry.rel}: keep the rules, drop the examples and restatements. ` +
        'Proposed as a diff for review -- we do not edit your files.',
    });
  }
  if (neverUsed) {
    actions.push({
      action: 'demote',
      kind: 'ours',
      why: invocations === 0
        ? `invoked 0 times across ${usage.sessions} sessions`
        : `none of its distinctive terms appeared in ${usage.sessions} sessions`,
      // Nothing is deleted. It becomes an anchored finding, surfaced on contact.
      reversible: true,
    });
  }

  return {
    entry: entry.rel,
    kind: entry.kind,
    tokens: entry.tokens,
    sessions: usage?.sessions ?? null,
    invocations,
    termsApplied: applied,
    stale,
    neverUsed: Boolean(neverUsed),
    bloated,
    // Evidence is a count or it is nothing: without enough sessions we report
    // the cost and decline to call anything unused.
    evidence: enoughEvidence ? 'measured' : 'not enough sessions yet',
    actions,
  };
}

/** Every piece of standing context, worst first. */
export function auditStanding(cwd, transcriptPath) {
  const usage = transcriptPath ? usageFrom(transcriptPath) : null;
  return standingFiles(cwd)
    .map((entry) => verdictFor(entry, usage, cwd))
    .sort((a, b) => {
      // Provably wrong outranks merely expensive: a stale instruction actively
      // misleads, where a large one only costs money.
      const weight = (v) => (v.stale.length ? 1_000_000 : 0) + (v.neverUsed ? v.tokens * 2 : v.tokens);
      return weight(b) - weight(a);
    });
}

/** The report. */
export function renderStanding(verdicts, { sessionsPerMonth = 60 } = {}) {
  if (!verdicts.length) return 'No standing context files found.';

  const lines = [];
  const total = verdicts.reduce((sum, v) => sum + v.tokens, 0);
  lines.push(`${verdicts.length} file(s) in every session's prefix, ${total.toLocaleString()} tokens total.`);

  for (const verdict of verdicts) {
    const facts = [];
    if (verdict.invocations !== null) facts.push(`invoked ${verdict.invocations}x`);
    if (verdict.termsApplied !== null && verdict.invocations === null) {
      facts.push(`${verdict.termsApplied} of its terms ever appeared`);
    }
    if (verdict.sessions) facts.push(`over ${verdict.sessions} sessions`);

    lines.push('', `  ${verdict.entry} -- ${verdict.tokens.toLocaleString()} tok/session` +
      `${facts.length ? ` (${facts.join(', ')})` : ''}`);

    if (verdict.evidence !== 'measured') lines.push(`      ${verdict.evidence}; reporting cost only`);
    for (const stale of verdict.stale.slice(0, 3)) {
      lines.push(`      ! line ${stale.line}: ${stale.why} -- PROVABLY STALE`);
    }
    for (const action of verdict.actions) {
      lines.push(`      -> ${action.action}: ${action.why}` +
        `${action.kind === 'yours' ? ' (proposed diff, needs your yes)' : ' (ours to do, reversible)'}`);
    }
    if (!verdict.actions.length) lines.push('      nothing to do -- used, current, and not oversized');
  }

  return lines.join('\n');
}
