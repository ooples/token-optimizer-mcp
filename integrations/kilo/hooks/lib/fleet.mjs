// GENERATED FILE -- do not edit.
// Source of truth: hooks-core/fleet.mjs. Regenerate with `npm run sync:hooks`.
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
import { canonicalPath, isFsSafePath } from './paths.mjs';

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
  if (!isFsSafePath(transcript)) return null;
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
  resolveCwd = true,
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
    let files = [];
    try {
      files = readdirSync(dir);
    } catch { /* unreadable directory */ }

    for (const file of files) {
      if (!file.endsWith('.jsonl')) continue;
      const path = join(dir, file);
      // Scoped to the one file deliberately. Transcripts under the discovery root are being
      // written and rotated by OTHER live sessions while this scan enumerates them, so a file
      // present at readdirSync can be gone at statSync. Wrapping the whole loop meant one such
      // race abandoned the directory's remaining transcripts -- reporting a project with several
      // of them as 'no transcript', or silently deriving its cwd from a stale one.
      try {
        const at = statSync(path).mtimeMs;
        if (!newest || at > newest.at) newest = { path, at };
      } catch { /* rotated away mid-scan; the other transcripts still count */ }
    }

    if (!newest) {
      skipped.push({ slug: entry.name, why: 'no transcript' });
      continue;
    }
    if (isExcluded(entry.name, exclude)) {
      skipped.push({ slug: entry.name, why: 'excluded by pattern' });
      continue;
    }

    projects.push({ slug: entry.name, transcript: newest.path, at: newest.at });
  }

  projects.sort((a, b) => b.at - a.at);

  let kept = projects;
  if (mode !== 'all' && projects.length > limit) {
    for (const extra of projects.slice(limit)) skipped.push({ slug: extra.slug, why: `beyond the limit of ${limit}` });
    kept = projects.slice(0, limit);
  }

  // RESOLVED HERE, NOT DURING DISCOVERY. projectCwd opens a transcript and reads 64 KB of it, so
  // resolving during the loop read every transcript on the machine and threw most of them away --
  // 400 opened to keep 25. It also made the dry run a lie: fleet-tool.ts calls discoverProjects
  // before it branches on dryRun, so "Nothing was read" was printed after reading the head of
  // every transcript on the machine. Sorting needs only `at`, so nothing is lost by waiting.
  //
  // resolveCwd: false is what makes the dry run a real consent step. Reading 64 KB of a
  // transcript IS reading the material consent is being asked about -- transcripts hold source
  // code, paths and whatever has been pasted into a terminal -- so a gate that reads it before
  // asking is not a gate. The slug is the cwd with its punctuation dashed out, so the listing
  // still identifies each project.
  if (!resolveCwd) return { mode, projects: kept.map((p) => ({ ...p, cwd: null })), skipped, root };

  const resolved = [];
  const seen = new Map();
  for (const project of kept) {
    const raw = projectCwd(project.transcript);
    // Canonicalised as explicit mode already does. The client mints one directory per cwd
    // SPELLING, so the same repo opened as C:\Users\me\repo, c:\users\me\repo and /c/Users/me/repo
    // yields three slugs -- and wikiDir maps all three onto the same case-insensitive Windows
    // directory, so readMetrics returns the SAME event log each time. Left undeduped, the project
    // is counted once per spelling: its pareto share multiplies, and it contributes that many
    // identical points to whichever arm of enforcementComparison it lands in.
    const cwd = raw ? canonicalPath(raw) : null;
    if (cwd && seen.has(cwd)) {
      skipped.push({ slug: project.slug, why: `duplicate of ${seen.get(cwd)} (same cwd)` });
      continue;
    }
    if (cwd) seen.set(cwd, project.slug);
    resolved.push({ ...project, cwd });
  }

  return { mode, projects: resolved, skipped, root };
}

/**
 * The directory slug the client mints for a cwd: every non-alphanumeric character becomes a dash.
 */
export function slugifyCwd(cwd) {
  return String(cwd).replace(/[^a-zA-Z0-9]/g, '-');
}

/**
 * Does an exclude pattern apply to this project directory?
 *
 * Matched against the slugified form as well as the literal one. `exclude` is documented as
 * "substrings to skip" and is the only scoping control the tool offers, but the thing being
 * matched is the MANGLED slug -- so every pattern spelled the way a user would spell it could
 * never match: `C:\work\private` (colon, backslashes), `~/work/private` (slashes, tilde),
 * `node_modules` (underscore) and `my.project` (dot) all failed silently, and the project was
 * scanned -- transcript head read, metrics and rules read, slug printed in the report -- with no
 * diagnostic that the exclusion had not taken.
 */
function isExcluded(slug, exclude) {
  return exclude.some((pattern) => {
    const raw = String(pattern ?? '');
    if (!raw) return false; // an empty pattern is in every string; excluding everything is never meant
    return slug.includes(raw) || slug.includes(slugifyCwd(raw));
  });
}

/**
 * Size and content digest for one file, or null if it cannot be read.
 *
 * isFsSafePath first, and not as belt-and-braces: this is a copy of wiki.mjs's contentHash with
 * that check dropped. libuv's UTF-8-to-UTF-16 conversion on Windows asserts
 * `code_point < 0x10FFFF`, so a path containing U+10FFFF makes statSync/readFileSync **abort the
 * process** rather than throw -- paths.mjs documents the assert and notes there is nothing to
 * catch afterwards, so the try/catch below cannot save the scan. The paths reaching here are
 * external input of exactly the guarded kind: `rule.anchor` out of a project's rules.json and
 * `target.anchors` out of its event log. The blast radius is the whole MCP server process.
 */
function measure(path) {
  if (!isFsSafePath(path)) return null;
  try {
    const size = statSync(path).size;
    return { size, hash: createHash('sha256').update(readFileSync(path)).digest('hex') };
  } catch {
    return null;
  }
}

/**
 * Per-scan digest cache.
 *
 * `transferable` compares inside a triple loop -- every source project, every rule, every other
 * project, every anchor whose basename matches -- and `target.anchors` is every distinct file the
 * project read within the 5000-event window, routinely hundreds of paths. Common basenames
 * (index.ts, package.json, __init__.py) match many of them. At the default cap of 25 projects
 * with ~20 rules each that was tens of thousands of synchronous whole-file reads and SHA-256
 * passes on the MCP server's only thread, with `mode: 'all'` removing the project cap entirely.
 * The same file was re-read once per rule-project pair.
 */
function digestCache() {
  const cache = new Map();
  return (path) => {
    if (!cache.has(path)) cache.set(path, measure(path));
    return cache.get(path);
  };
}

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
  // project.cwd comes out of a transcript's JSON -- the same external, unvalidated input that
  // reaches sha256 -- and existsSync aborts the process rather than throwing on a path holding
  // U+10FFFF. See measure() above.
  const dir = project.cwd && isFsSafePath(project.cwd) ? wikiDir(project.cwd) : null;
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
  const digest = digestCache();

  for (const source of scans) {
    for (const rule of source.rules) {
      // BOTH SHAPES. `if (!rule.anchor) continue` skipped every composite rule: remedy.mjs lists
      // 'composite' among the remedy types this product applies itself, and applyRemedy stores
      // those with `anchors` plural and `anchor` undefined. So composites were invisible to
      // transfer analysis -- never offered to another project, never in the report's "proven
      // somewhere, available elsewhere" block, and never counted as skipped either.
      const wanted = rule.anchors?.length ? rule.anchors : (rule.anchor ? [rule.anchor] : []);
      if (!wanted.length) continue;

      // A multi-anchor remedy is only meaningful where EVERY file it was proven against is
      // present with matching contents; a partial match is a different situation, not a weaker
      // version of this one.
      const required = wanted.map((a) => ({ anchor: a, base: basename(a), measured: digest(a) }));
      if (required.some((r) => !r.measured)) continue;

      const targets = [];
      for (const target of scans) {
        if (target.slug === source.slug) continue;
        if (target.rules.some((r) => r.id === rule.id)) continue; // already has it

        const matched = [];
        for (const need of required) {
          const hit = target.anchors.find((anchor) => {
            if (basename(anchor) !== need.base) return false;
            const found = digest(anchor);
            // Size first: two files of different lengths cannot share contents, and statSync is
            // orders of magnitude cheaper than hashing a whole file that cannot match anyway.
            return Boolean(found) && found.size === need.measured.size && found.hash === need.measured.hash;
          });
          if (!hit) break;
          matched.push(hit);
        }
        if (matched.length !== required.length) continue;

        targets.push({ slug: target.slug, cwd: target.cwd, anchor: matched[0], anchors: matched });
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

  // POOLED, NOT AN AVERAGE OF AVERAGES.
  //
  // Averaging each project's per-read average gives every project equal weight regardless of how
  // much evidence stands behind it: a project with 2 reads counted as much as one with 30,000.
  // An enforcing arm of [2 reads totalling 300k -> 150,000/read; 5,000 reads at 500; 4,000 at 400]
  // reported 50,300 tokens/read where the pooled figure over the same 9,002 reads is about 530.
  // Set against a directive arm around 800, renderFleet then printed that enforcing costs ~60x
  // MORE per read -- the exact inverse of the truth, under a heading calling this the check on
  // the central claim of this product, with nothing in the caveat to hint that one two-read
  // project drove the whole result. scanProject already returns both tokens and reads, so the
  // pooled statistic needs no new measurement.
  const pool = (list) => {
    const tokens = list.reduce((sum, s) => sum + (s.tokens || 0), 0);
    const reads = list.reduce((sum, s) => sum + (s.reads || 0), 0);
    return { perRead: reads ? Math.round(tokens / reads) : null, reads, tokens };
  };

  const e = pool(enforcing);
  const d = pool(directive);

  return {
    comparable: true,
    enforcingPerRead: e.perRead,
    directivePerRead: d.perRead,
    enforcingProjects: enforcing.length,
    directiveProjects: directive.length,
    // The read counts are exposed rather than kept internal: they are how a reader tells a
    // fleet-wide result from one project's noise, which is the whole question here.
    enforcingReads: e.reads,
    directiveReads: d.reads,
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
    const arm = (label, perRead, projects, reads) =>
      `  ${label}  ${perRead == null ? 'no reads yet' : `${perRead.toLocaleString()} tokens/read`}` +
      ` over ${projects} project(s), ${reads.toLocaleString()} read(s)`;
    lines.push(arm('enforcing', comparison.enforcingPerRead, comparison.enforcingProjects, comparison.enforcingReads));
    lines.push(arm('directive', comparison.directivePerRead, comparison.directiveProjects, comparison.directiveReads));
    lines.push(`  ! ${comparison.caveat}`);
  } else {
    lines.push(`  not comparable yet -- ${comparison.reason}`);
  }

  const note = priceNote(tier);
  if (note) lines.push('', note);

  return lines.join('\n');
}
