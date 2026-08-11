#!/usr/bin/env node
/**
 * Explicitly backfills the machine project registry from known source roots.
 *
 * The dashboard never scans the filesystem on a web request. Operators choose
 * the roots here; traversal is bounded and ignores dependency/build trees.
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { registerProject, registeredProjects } from '../hooks-core/projects.mjs';

const requestedRoots = process.argv.slice(2).map((root) => resolve(root));
if (requestedRoots.length === 0) {
  console.error('Usage: node scripts/discover-project-graphs.mjs <source-root> [...]');
  process.exit(2);
}

const excluded = new Set([
  '.git',
  'node_modules',
  'bin',
  'obj',
  'dist',
  'coverage',
  'artifacts',
  'TestResults',
]);
const found = [];

function visit(directory, depth = 0, explicitRepository = false) {
  if (depth > 10) return;
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return;
  }

  const store = join(directory, '.token-optimizer', 'wiki', 'graph.jsonl');
  const isRepository = existsSync(join(directory, '.git'));
  if (existsSync(store) || explicitRepository) {
    const graphDir = dirname(store);
    const project = registerProject({
      root: directory,
      graphDir,
      client: explicitRepository ? 'discovery-explicit' : 'discovery',
      name: basename(directory),
    });
    if (project) {
      found.push({
        id: project.id,
        name: project.name,
        captured: existsSync(store),
        bytes: existsSync(store) ? statSync(store).size : 0,
      });
    }
    // A repository may contain nested worktrees, so traversal continues.
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || excluded.has(entry.name)) continue;
    if (entry.name === '.token-optimizer') continue;
    visit(join(directory, entry.name), depth + 1, false);
  }
}

for (const root of requestedRoots)
  visit(root, 0, existsSync(join(root, '.git')));

const deduped = [...new Map(found.map((project) => [project.id, project])).values()];
console.log(
  JSON.stringify(
    {
      roots: requestedRoots,
      discovered: deduped.length,
      projects: deduped,
      registryProjects: registeredProjects().length,
    },
    null,
    2
  )
);
