/**
 * The fleet: every project on this machine, seen at once.
 *
 * We ship fifteen client integrations and have never looked across them. The
 * competing product scans transcripts across clients and reports opportunities
 * per project, which is worth having -- but three things are available to us
 * that are not available to a scanner without a graph.
 *
 * FIXES TRANSFER. Findings are anchored by CONTENT, so a vendored file, a
 * generated header or a lock file is the same anchor in every repository that
 * contains it. A skip rule proven in one project can be offered to the others
 * that hold the same bytes, carrying the evidence from where it was measured.
 * The fleet stops being fourteen separate audits and becomes one that gets
 * smarter as a unit.
 *
 * THE MONEY IS CONCENTRATED, so the report is a Pareto rather than a list.
 * Knowing that two of fourteen projects hold most of the waste is what makes a
 * fleet view worth reading at all.
 *
 * AND THE FLEET IS A NATURAL EXPERIMENT. We ship enforcing clients and
 * directive ones, so a machine running both is a comparison nobody else is
 * positioned to make -- because nobody else ships both tiers. It is reported
 * whichever way it falls, with its confound stated: people choose their client
 * and the projects differ, so it is suggestive rather than causal. The
 * per-project holdout arm is the causal measurement and remains the one behind
 * any savings claim.
 *
 * NOTHING LEAVES THE MACHINE. Transcripts contain source code, paths, and
 * whatever people have pasted into a terminal. This module reads them locally,
 * on demand, names every directory it opened, and reports paths rather than
 * contents. There is no background collection: a fleet scan happens because
 * somebody asked for one.
 */

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, existsSync, openSync, readSync, closeSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import { readMetrics, balanceSheet } from './metrics.mjs';
import { cacheHealth, readCacheUsage } from './cache.mjs';
import { activeRules } from './remedy.mjs';
import { monthly, money, priceNote } from './pricing.mjs';
import { wikiDir } from './wiki.mjs';
import { canonicalPath } from './paths.mjs';

/** How many projects an enumerating scan will read before it stops and says so. */
export const DEFAULT_LIMIT = 25;

/** Where the client keeps per-project transcripts. */
export function projectsRoot() {
  return process.env.TOKEN_OPTIMIZER_PROJECTS_ROOT || join(homedir(), '.claude', 'projects');
}

/**
 * The project directory a transcript belongs to.
 *
 * Read from the transcript's own `cwd` rather than un-mangling the directory
 * slug, which is lossy: the slug replaces every non-alphanumeric character with
 * a dash, so `a-b/c` and `a/b-c` produce the same one. Only the head of the file
 * is read, since `cwd` appears on the first rows.
 */
export function projectCwd(transcript, { headBytes = 65_536 } = {}) {
  let fd;
  try {
    fd = openSync(transcript, 'r');
    const buffer = Buffer.alloc(headBytes);
    const read = readSync(fd, buffer, 0, headBytes, 0);
    for (const line of buffer.slice(0, read).toString('utf8').split('\n')) {
      if (!line.startsWith('{')) continue;
      try {
        const row = JSON.parse(line);
        if (row?.cwd) return row.cwd;
      } catch { /* a truncated final line in the head slice */ }
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* already closed */ }
  }
}

/**
 * Which projects this scan will look at.
 *
 * Three modes, because the right amount of consent is not the same for
 * everybody:
 *
 *   explicit    only the paths you name. Nothing is discovered.
 *   enumerate   discover, apply exclusions, stop at `limit` -- and report every
 *               directory read and every one skipped. The default.
 *   all         discover everything, no cap.
 *
 * Every mode reports what it touched, and none of them reads anything until
 * asked.
 */
export function discoverProjects({
  mode = 'enumerate', root = projectsRoot(), only = [], exclude = [], limit = DEFAULT_LIMIT,
} = {}) {
  if (mode === 'explicit') {
    return {
      mode,
      projects: only.map((cwd) => ({ cwd: canonicalPath(cwd), slug: basename(cwd), transcript: null })),
      skipped: [],
    };
  }

  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory());
  } catch {
    return { mode, projects: [], skipped: [], reason: `no transcript directory at ${root}` };
  }

  const projects = [];
  const skipped = [];

  for (const entry of entries) {
    const dir = join(root, entry.name);
    let newest = null;
    try {
      for (const file of readdirSync(dir)) {
        if (!file.endsWith('.jsonl')) continue;
        const path = join(dir, file);
        const at = statSync(path).mtimeMs;
        if (!newest || at > newest.at) newest = { path, at };
      }
    } catch { /* unreadable directory */ }

    if (!newest) {
      skipped.push({ slug: entry.name, why: 'no transcript' });
      continue;
    }
    if (exclude.some((pattern) => entry.name.includes(pattern))) {
      skipped.push({ slug: entry.name, why: 'excluded by pattern' });
      continue;
    }

    projects.push({ slug: entry.name, transcript: newest.path, at: newest.at, cwd: projectCwd(newest.path) });
  }

  projects.sort((a, b) => b.at - a.at);

  if (mode !== 'all' && projects.length > limit) {
    for (const extra of projects.slice(limit)) skipped.push({ slug: extra.slug, why: `beyond the limit of ${limit}` });
    return { mode, projects: projects.slice(0, limit), skipped, root };
  }

  return { mode, projects, skipped, root };
}

const sha256 = (path) => {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex');
  } catch {
    return null;
  }
};

/**
 * What one project costs, and whether enforcement is on there.
 *
 * `enforcing` is measured rather than configured: a substitution event only
 * exists where a refusal actually replaced a read, so its presence is evidence
 * that the veto is live in that project rather than that a config file says so.
 */
/** Never let a malformed log take down a fleet scan. */
function safeBalance(dir) {
  try {
    return balanceSheet(dir);
  } catch {
    return null;
  }
}

export function scanProject(project) {
  const dir = project.cwd ? wikiDir(project.cwd) : null;
  const events = dir && existsSync(dir) ? readMetrics(dir) : [];

  const reads = events.filter((e) => e.kind === 'read');
  const sessions = new Set(reads.map((r) => r.sessionId || 'unknown'));
  const tokens = reads.reduce((sum, r) => sum + (r.tokens || 0), 0);
  const substitutions = events.filter((e) => e.kind === 'substitute').length;

  return {
    slug: project.slug,
    cwd: project.cwd,
    wikiDir: dir,
    transcript: project.transcript,
    hasGraph: Boolean(dir && existsSync(dir)),
    reads: reads.length,
    tokens,
    sessions: sessions.size,
    perSession: sessions.size ? Math.round(tokens / sessions.size) : null,
    perRead: reads.length ? Math.round(tokens / reads.length) : null,
    enforcing: substitutions > 0,
    substitutions,
    // THE BALANCE, PER PROJECT, LABELLED BY HOW EACH LINE IS KNOWN.
    //
    // The fleet view is where 'is this paying for itself' is actually asked,
    // and it had only raw counts to answer with. The two benefit lines stay
    // separate here as everywhere else: one is arithmetic on known file sizes,
    // the other is a causal estimate from the holdout, and summing them would
    // launder an assumption into a measurement.
    balance: dir && existsSync(dir) ? safeBalance(dir) : null,
    anchors: [...new Set(reads.map((r) => r.anchor).filter(Boolean))],
    rules: dir ? activeRules(dir) : [],
    cache: project.transcript ? cacheHealth(readCacheUsage(project.transcript)) : null,
  };
}

/**
 * A fix proven in one project, offered to the others holding the same bytes.
 *
 * Candidates are limited to files each project has ACTUALLY READ, taken from its
 * own event log, rather than walked from disk. That keeps this bounded and
 * keeps it honest: a fix is proposed for a file the project demonstrably opens,
 * not for every matching name on the machine.
 */
export function transferable(scans) {
  const out = [];

  for (const source of scans) {
    for (const rule of source.rules) {
      if (!rule.anchor) continue;
      const hash = sha256(rule.anchor);
      if (!hash) continue;

      const targets = [];
      for (const target of scans) {
        if (target.slug === source.slug) continue;
        if (target.rules.some((r) => r.id === rule.id)) continue; // already has it

        for (const anchor of target.anchors) {
          if (basename(anchor) !== basename(rule.anchor)) continue;
          if (sha256(anchor) !== hash) continue;
          targets.push({ slug: target.slug, cwd: target.cwd, anchor });
          break;
        }
      }

      if (targets.length) {
        out.push({
          rule: rule.id,
          type: rule.type,
          why: rule.why,
          provenIn: source.slug,
          measured: rule.baselinePerSession || null,
          targets,
        });
      }
    }
  }

  return out;
}

/**
 * Enforcing versus directive, across the fleet.
 *
 * The central claim of this product is that a pre-execution veto beats a
 * suggestion, and a machine running both kinds is the only place to check it.
 * Reported whichever way it falls -- a project that measures its own savings
 * against a withheld arm has already accepted that risk everywhere else.
 *
 * The confound is stated rather than buried, because people choose their client
 * and their projects differ, which makes this suggestive and not causal. The
 * per-project holdout arm is the causal measurement.
 */
export function enforcementComparison(scans) {
  const withReads = scans.filter((s) => s.perRead != null);
  const enforcing = withReads.filter((s) => s.enforcing);
  const directive = withReads.filter((s) => !s.enforcing);

  if (!enforcing.length || !directive.length) {
    return {
      comparable: false,
      reason: `need projects of both kinds: ${enforcing.length} enforcing, ${directive.length} directive`,
      enforcing: enforcing.length,
      directive: directive.length,
    };
  }

  const mean = (list) => Math.round(list.reduce((sum, s) => sum + s.perRead, 0) / list.length);

  return {
    comparable: true,
    enforcingPerRead: mean(enforcing),
    directivePerRead: mean(directive),
    enforcingProjects: enforcing.length,
    directiveProjects: directive.length,
    caveat: 'Not a randomised comparison: people choose their client and the projects differ. ' +
      'Treat as suggestive, not causal -- the per-project holdout arm is the causal measurement.',
  };
}

/** The fleet, ranked by what it costs. Most machines are very lopsided. */
export function pareto(scans, { tier = 'opus', sessionsPerMonth = 60 } = {}) {
  const ranked = scans
    .filter((s) => s.perSession)
    .map((s) => ({ ...s, priced: monthly(s.perSession, { tier, sessionsPerMonth }) }))
    .sort((a, b) => b.perSession - a.perSession);

  const total = ranked.reduce((sum, s) => sum + s.perSession, 0);
  return ranked.map((s) => ({ ...s, share: total ? s.perSession / total : null }));
}

/**
 * The whole scan, rendered.
 *
 * Says what it read, because a tool with access to every project on the machine
 * should account for what it opened.
 */
export function renderFleet({ discovery, scans, tier = 'opus', sessionsPerMonth = 60 }) {
  const lines = [];
  const ranked = pareto(scans, { tier, sessionsPerMonth });

  lines.push(`Scanned ${scans.length} project(s) in "${discovery.mode}" mode` +
    `${discovery.root ? ` under ${discovery.root}` : ''}.`);
  lines.push('  nothing left this machine; findings name paths, never file contents.');
  if (discovery.skipped.length) {
    const reasons = new Map();
    for (const skip of discovery.skipped) reasons.set(skip.why, (reasons.get(skip.why) || 0) + 1);
    lines.push(`  skipped ${discovery.skipped.length}: ${[...reasons].map(([why, n]) => `${n} ${why}`).join(', ')}`);
  }

  if (ranked.length) {
    lines.push('', 'Where the cost is:');
    for (const project of ranked.slice(0, 8)) {
      lines.push(`  ${project.slug.padEnd(28)} ${project.perSession.toLocaleString().padStart(9)} tok/session` +
        `${project.priced ? `  ~${money(project.priced.amount)}/mo` : ''}` +
        `${project.share != null ? `  ${Math.round(project.share * 100)}%` : ''}` +
        `${project.enforcing ? '  [enforcing]' : ''}`);
    }
  } else {
    lines.push('', 'No project has enough measured history yet to rank.');
  }

  const moves = transferable(scans);
  if (moves.length) {
    lines.push('', 'Proven somewhere, available elsewhere (same file contents):');
    for (const move of moves.slice(0, 6)) {
      lines.push(`  ${move.type} for ${basename(move.rule.split(':').slice(1).join(':') || move.rule)}`);
      lines.push(`    proven in ${move.provenIn}${move.measured ? ` (${move.measured.toLocaleString()} tok/session)` : ''}` +
        ` -- same contents in ${move.targets.length} other project(s)`);
      for (const target of move.targets.slice(0, 3)) lines.push(`      ${target.slug}`);
    }
  }

  const comparison = enforcementComparison(scans);
  lines.push('', 'Enforcing vs directive, measured across this fleet:');
  if (comparison.comparable) {
    lines.push(`  enforcing  ${comparison.enforcingPerRead.toLocaleString()} tokens/read over ${comparison.enforcingProjects} project(s)`);
    lines.push(`  directive  ${comparison.directivePerRead.toLocaleString()} tokens/read over ${comparison.directiveProjects} project(s)`);
    lines.push(`  ! ${comparison.caveat}`);
  } else {
    lines.push(`  not comparable yet -- ${comparison.reason}`);
  }

  const note = priceNote(tier);
  if (note) lines.push('', note);

  return lines.join('\n');
}
