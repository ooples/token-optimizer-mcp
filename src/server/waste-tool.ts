/**
 * The waste audit, exposed as a tool.
 *
 * Detection that nothing can reach is a report nobody opens, so the four
 * surfaces need a way in: this is the one for the report and for applying or
 * reverting a fix. The briefing reaches the model through the session-start
 * hook, and the veto through the routing decision -- both without anyone
 * calling anything.
 *
 * Applying is offered rather than performed on a schedule: an audit that
 * rewrites the project's rules the moment somebody looks at it is a surprise,
 * and a surprise is what gets a tool uninstalled.
 */

import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { dirname } from 'path';

const here = dirname(fileURLToPath(import.meta.url));

function coreUrl(name: string): string {
  return pathToFileURL(path.join(here, '..', '..', 'hooks-core', name)).href;
}

interface WasteModules {
  waste: any;
  remedy: any;
  wiki: any;
}

let cached: WasteModules | null = null;

async function modules(): Promise<WasteModules | null> {
  if (cached) return cached;
  try {
    const [waste, remedy, wiki] = await Promise.all([
      import(coreUrl('waste.mjs')),
      import(coreUrl('remedy.mjs')),
      import(coreUrl('wiki.mjs')),
    ]);
    cached = { waste, remedy, wiki };
    return cached;
  } catch {
    return null;
  }
}

const text = (body: string, isError = false) => ({
  content: [{ type: 'text', text: body }],
  isError,
});

export async function wasteAudit(input: {
  action?: 'report' | 'apply' | 'revert';
  id?: string;
}): Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}> {
  const mods = await modules();
  if (!mods)
    return text(
      'The waste audit is unavailable: the graph modules could not be loaded.',
      true
    );

  const dir = mods.wiki.wikiDir(process.cwd());
  const action = input?.action || 'report';

  if (action === 'revert') {
    if (!input.id)
      return text('Reverting needs the rule id shown in the report.', true);
    return mods.remedy.revertRemedy(dir, input.id)
      ? text(`Reverted ${input.id}. The rule is no longer in force.`)
      : text(`No active rule with id ${input.id}.`, true);
  }

  let graph = null;
  try {
    graph = mods.wiki.load(dir);
  } catch {
    // A missing graph costs the question-level detectors and nothing else.
  }

  const detections = mods.waste.detect(dir, graph);

  if (action === 'apply') {
    const chosen = input.id
      ? detections.filter(
          (d: any) =>
            `${d.remedy?.type}:${d.remedy?.anchor || ''}` === input.id ||
            d.id === input.id
        )
      : detections.filter((d: any) => d.remedy?.kind === 'ours');

    if (!chosen.length) return text('Nothing to apply.', true);

    const applied: string[] = [];
    const proposed: string[] = [];
    for (const detection of chosen) {
      const rule = mods.remedy.applyRemedy(dir, detection);
      if (rule) {
        applied.push(
          `  applied ${rule.id} -- ${rule.why} (revert with action="revert", id="${rule.id}")`
        );
        continue;
      }
      // Anything belonging to the user comes back as a diff and is not touched.
      const suggestion = mods.remedy.proposal(detection);
      if (suggestion)
        proposed.push(
          `  proposed ${suggestion.file}: ${suggestion.why}\n${suggestion.diff}`
        );
    }

    return text(
      [
        applied.length
          ? `Applied ${applied.length} fix(es):\n${applied.join('\n')}`
          : 'No fixes were ours to apply.',
        proposed.length
          ? `\nNeeds your confirmation -- nothing has been changed:\n${proposed.join('\n')}`
          : '',
      ]
        .filter(Boolean)
        .join('\n')
    );
  }

  const report = mods.remedy.wasteReport(dir, detections);
  return text(
    report?.text ||
      'No waste detected yet. The derived detectors need a few sessions of history.'
  );
}

export const WASTE_TOOL = {
  name: 'waste_audit',
  description:
    'Report behavioural token waste in this project, ranked by cost per session and compared against the previous week. ' +
    "Detectors are a shipped floor plus patterns derived from this project's own history, each carrying what it has " +
    'actually saved. Use action="apply" to put the fixes we own into force (reversible and measured), or action="revert" ' +
    'with an id to undo one. Changes to your own files are only ever proposed as a diff.',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['report', 'apply', 'revert'],
        description: 'Default "report"',
      },
      id: {
        type: 'string',
        description: 'Rule id, required for revert and optional for apply',
      },
    },
  },
} as const;
