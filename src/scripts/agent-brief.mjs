#!/usr/bin/env node
/**
 * token-optimizer-agent-brief: draft, approve, show and remove the agent brief
 * (src/hooks-core/agent-brief.mjs, #567).
 *
 *   draft   [--project] [--cwd DIR]   compile the instruction files into a draft to review
 *   approve [--project]               make the reviewed draft the brief agents receive
 *   show    [--project] [--task TEXT] print the brief, or what an agent with TEXT would get
 *   remove  [--project]               stop routing agents with the brief (kept as .removed)
 *
 * Without --project the brief is the user's own, sent in every project; with it,
 * the brief is this project's, sent after the user's.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  briefFor,
  briefPaths,
  draftBrief,
  instructionFiles,
  parseBrief,
  renderWorkerAgent,
  workerAgentPath,
} from '../hooks-core/agent-brief.mjs';

const args = process.argv.slice(2);
const command = args[0];
const flag = (name) => args.includes(name);
const option = (name) => {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
};
const cwd = option('--cwd') || process.cwd();
const scope = flag('--project') ? 'project' : 'global';
const target = briefPaths({ cwd })[scope];
const draftPath = `${target.replace(/\.md$/, '')}.draft.md`;
const kb = (n) => `${(n / 1024).toFixed(1)} KB`;

function summary(text) {
  const sections = parseBrief(text);
  const always = sections.filter((s) => !s.when);
  const size = (list) => list.reduce((n, s) => n + s.heading.length + s.text.length, 0);
  return `${sections.length} sections: ${always.length} sent always (${kb(size(always))}), ${sections.length - always.length} only when a task mentions their words (${kb(size(sections) - size(always))})`;
}

if (command === 'draft') {
  const found = instructionFiles({ cwd });
  const paths = scope === 'global' ? [...found.global, ...found.project] : found.project;
  const files = paths.map((path) => ({ path, text: readFileSync(path, 'utf8') }));
  if (!files.length) {
    console.log('No instruction files (CLAUDE.md, .claude/CLAUDE.md, CLAUDE.local.md) found to compile.');
    process.exit(1);
  }
  const draft = draftBrief(files);
  mkdirSync(dirname(draftPath), { recursive: true });
  writeFileSync(draftPath, draft);
  const source = files.reduce((n, f) => n + f.text.length, 0);
  console.log(`Compiled ${files.length} instruction file(s), ${kb(source)}:`);
  for (const f of files) console.log(`  ${f.path}`);
  console.log(`Draft: ${draftPath} (${kb(draft.length)}; ${summary(draft)}).`);
  console.log('Review it -- delete what a delegated agent does not need, add what it does -- then run:');
  console.log(`  token-optimizer-agent-brief approve${scope === 'project' ? ' --project' : ''}`);
} else if (command === 'approve') {
  if (!existsSync(draftPath)) {
    console.log(`No draft at ${draftPath}. Run: token-optimizer-agent-brief draft${scope === 'project' ? ' --project' : ''}`);
    process.exit(1);
  }
  if (existsSync(target)) renameSync(target, `${target}.${Date.now()}.bak`);
  renameSync(draftPath, target);
  console.log(`Approved: ${target} (${summary(readFileSync(target, 'utf8'))}).`);
  // The always-sent rules go into an agent's system prompt, cached across spawns.
  const agentPath = workerAgentPath(scope === 'project' ? 'project' : 'user', { cwd });
  mkdirSync(dirname(agentPath), { recursive: true });
  writeFileSync(agentPath, renderWorkerAgent(scope === 'project' ? 'project' : 'user', { cwd }));
  console.log(`Generated the worker agent ${agentPath}.`);
  console.log('From the next session on, general-purpose agents start as that worker -- without CLAUDE.md,');
  console.log('auto-memory or the skill list, with these rules instead. TOKEN_OPTIMIZER_AGENT_ROUTE=off turns that off.');
  if (scope === 'global') console.log('A project brief, if approved, needs approve --project again to pick these rules up.');
} else if (command === 'show') {
  const task = option('--task');
  if (task !== null) {
    const brief = briefFor(task, { cwd });
    console.log(brief ? brief : 'No approved brief applies: agents start as asked.');
  } else {
    const paths = briefPaths({ cwd });
    for (const [name, path] of Object.entries(paths)) {
      if (!path) continue;
      console.log(existsSync(path) ? `${name}: ${path} (${summary(readFileSync(path, 'utf8'))})` : `${name}: none (${path})`);
    }
  }
} else if (command === 'remove') {
  if (!existsSync(target)) {
    console.log(`No approved brief at ${target}.`);
  } else {
    renameSync(target, `${target}.${Date.now()}.removed`);
    const agentPath = workerAgentPath(scope === 'project' ? 'project' : 'user', { cwd });
    if (existsSync(agentPath)) renameSync(agentPath, `${agentPath}.${Date.now()}.removed`);
    console.log(`Removed ${target} and its worker agent; agents start as asked again.`);
  }
} else {
  console.log('usage: token-optimizer-agent-brief draft|approve|show|remove [--project] [--cwd DIR] [--task TEXT]');
  process.exit(command ? 1 : 0);
}
