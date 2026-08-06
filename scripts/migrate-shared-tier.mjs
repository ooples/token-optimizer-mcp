#!/usr/bin/env node
/**
 * One-off back-fill: carry existing portable lessons up into the shared tier.
 *
 * Promotion happens at harvest time, so every lesson learned before the shared
 * tier existed stays in the project that taught it. On the machine that motivated
 * the feature that was all of them -- 35 live lessons, one graph.
 *
 * Safe to run repeatedly: promotion dedupes on claim text, so a second pass adds
 * nothing and a graph that gained findings contributes only the new ones.
 *
 * Usage:
 *   node scripts/migrate-shared-tier.mjs [--dry-run] [root ...]
 *
 * With no roots it scans the parents of this checkout for sibling projects that
 * already have a graph, which is the ordinary layout. Roots may also be given
 * explicitly, which is what the tests do.
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const HERE = dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const core = (n) => pathToFileURL(join(HERE, '..', 'hooks-core', n)).href;

const { promoteExisting } = await import(core('harvest-write.mjs'));
const { sharedDir, load } = await import(core('wiki.mjs'));

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const explicit = args.filter((a) => !a.startsWith('--')).map((a) => resolve(a));

/** A directory is a project for this purpose when it already has a graph. */
const hasGraph = (root) => existsSync(join(root, '.token-optimizer', 'wiki', 'graph.jsonl'));

function discover() {
  const found = [];
  // The checkout itself, then its siblings: the common "all repos in one folder"
  // layout. Deliberately shallow -- a deep scan of a developer's home directory
  // is a surprising thing for a migration to do.
  const self = resolve(HERE, '..');
  const parent = dirname(self);
  const candidates = [self];
  try {
    for (const name of readdirSync(parent)) {
      const p = join(parent, name);
      try {
        if (statSync(p).isDirectory()) candidates.push(p);
      } catch {
        /* unreadable entry */
      }
    }
  } catch {
    /* unreadable parent */
  }
  for (const c of candidates) if (hasGraph(c) && !found.includes(c)) found.push(c);
  return found;
}

const roots = explicit.length ? explicit : discover();
if (!roots.length) {
  console.log('no project graphs found; nothing to migrate');
  process.exit(0);
}

console.log(`shared tier: ${sharedDir()}`);
console.log(`${roots.length} project graph(s)${dryRun ? '  [DRY RUN]' : ''}\n`);

let totalEligible = 0;
let totalPromoted = 0;

for (const root of roots) {
  const dir = join(root, '.token-optimizer', 'wiki');
  if (!hasGraph(root)) {
    console.log(`  ${root}  (no graph)`);
    continue;
  }

  if (dryRun) {
    // Counted the same way the real path counts, so the preview cannot disagree
    // with what a real run would do.
    let eligible = 0;
    try {
      const graph = load(dir);
      const { SHAREABLE_TYPES } = await import(core('harvest-write.mjs'));
      for (const n of graph.nodes.values()) {
        if (n.kind === 'finding' && !n.retired && n.claim && SHAREABLE_TYPES.has(n.type)) eligible += 1;
      }
    } catch {
      /* unreadable graph */
    }
    totalEligible += eligible;
    console.log(`  ${root}\n    eligible: ${eligible}`);
    continue;
  }

  const r = promoteExisting(dir, root);
  totalEligible += r.eligible;
  totalPromoted += r.promoted;
  console.log(
    `  ${root}\n    findings: ${r.considered}  eligible: ${r.eligible}  promoted: ${r.promoted}  already present: ${r.skipped}`
  );
}

console.log(
  dryRun
    ? `\n${totalEligible} lesson(s) would be considered for promotion`
    : `\n${totalPromoted} lesson(s) promoted of ${totalEligible} eligible`
);
