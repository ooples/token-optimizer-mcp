/**
 * The fleet auditor, exposed as a tool.
 *
 * Reads transcripts and graphs from more than one project, which is the widest
 * access anything in this product has -- so the scope is the caller's decision,
 * the default is bounded, and the report says what it opened. Nothing is
 * uploaded and nothing runs in the background: a fleet scan happens because
 * somebody asked for one.
 */

import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { dirname } from 'path';

const here = dirname(fileURLToPath(import.meta.url));

function coreUrl(name: string): string {
  return pathToFileURL(path.join(here, '..', '..', 'hooks-core', name)).href;
}

let cached: { fleet: any } | null = null;

async function modules() {
  if (cached) return cached;
  try {
    cached = { fleet: await import(coreUrl('fleet.mjs')) };
    return cached;
  } catch {
    return null;
  }
}

const say = (body: string, isError = false) => ({ content: [{ type: 'text', text: body }], isError });

export async function fleetAudit(input: {
  mode?: 'enumerate' | 'all' | 'explicit';
  projects?: string[];
  exclude?: string[];
  limit?: number;
  dryRun?: boolean;
  tier?: string;
  sessionsPerMonth?: number;
}): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  const mods = await modules();
  if (!mods) return say('The fleet auditor is unavailable: the modules could not be loaded.', true);

  const discovery = mods.fleet.discoverProjects({
    mode: input?.mode || (input?.projects?.length ? 'explicit' : 'enumerate'),
    only: input?.projects || [],
    exclude: input?.exclude || [],
    limit: input?.limit,
  });

  // The consent step: show what would be opened, open nothing.
  if (input?.dryRun) {
    return say([
      `Would scan ${discovery.projects.length} project(s) in "${discovery.mode}" mode` +
        `${discovery.root ? ` under ${discovery.root}` : ''}:`,
      ...discovery.projects.map((p: any) => `  ${p.slug}${p.cwd ? ` -> ${p.cwd}` : ''}`),
      ...(discovery.skipped.length ? ['', `Would skip ${discovery.skipped.length}:`,
        ...discovery.skipped.slice(0, 10).map((s: any) => `  ${s.slug} (${s.why})`)] : []),
      '',
      'Nothing was read. Run again without dryRun to scan.',
    ].join('\n'));
  }

  if (!discovery.projects.length) {
    return say(discovery.reason
      ? `No projects to scan: ${discovery.reason}`
      : 'No projects found to scan.');
  }

  const scans = discovery.projects.map((project: any) => mods.fleet.scanProject(project));

  return say(mods.fleet.renderFleet({
    discovery,
    scans,
    tier: input?.tier || 'opus',
    sessionsPerMonth: input?.sessionsPerMonth || 60,
  }));
}

export const FLEET_TOOL = {
  name: 'fleet_audit',
  description:
    'Look across every project on this machine at once: which projects hold the cost (ranked with dollar figures), which fixes ' +
    'proven in one project apply to others containing the SAME FILE CONTENTS, and how enforcing clients compare with directive ' +
    'ones as a natural experiment (reported with its confound). Reads transcripts and graphs locally, uploads nothing, and names ' +
    'every directory it opened. Use dryRun=true to see what it would read before it reads anything; mode="explicit" with ' +
    '`projects` to scan only what you name.',
  inputSchema: {
    type: 'object',
    properties: {
      mode: { type: 'string', enum: ['enumerate', 'all', 'explicit'], description: 'enumerate (default, bounded), all (no cap), explicit (only what you list)' },
      projects: { type: 'array', items: { type: 'string' }, description: 'Project directories, for explicit mode' },
      exclude: { type: 'array', items: { type: 'string' }, description: 'Substrings to skip' },
      limit: { type: 'number', description: 'Maximum projects in enumerate mode' },
      dryRun: { type: 'boolean', description: 'List what would be read, and read nothing' },
      tier: { type: 'string', description: 'Pricing tier for dollar figures. Default opus' },
      sessionsPerMonth: { type: 'number', description: 'Assumption behind monthly figures. Default 60' },
    },
  },
} as const;
