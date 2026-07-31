/**
 * Progressive disclosure at the MCP boundary.
 *
 * There is exactly one place every tool result passes through, so that is where
 * this attaches -- rather than each of the ninety-odd tools deciding for itself
 * whether its output is too big, which is how a policy becomes ninety
 * inconsistent policies.
 *
 * The hooks cannot do this job. A PreToolUse hook can refuse a call but cannot
 * see its output; a PostToolUse hook sees the output only after the host has
 * already put it in context, and no hook can replace a built-in tool's result
 * (anthropics/claude-code#32105). Our OWN tool results are the part we control
 * completely, and they are the ones users route their large reads through.
 *
 * The real work lives in hooks-core/disclose.mjs and hooks-core/expand.mjs,
 * imported dynamically for the same reasons as the wiki routes: they are plain
 * ESM the clients execute with no build step, and a missing graph must degrade
 * to "return the output unchanged" rather than break a tool call.
 */

import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { dirname } from 'path';

const here = dirname(fileURLToPath(import.meta.url));

function coreUrl(name: string): string {
  return pathToFileURL(path.join(here, '..', '..', 'hooks-core', name)).href;
}

interface DisclosureModules {
  disclose: any;
  expand: any;
  wiki: any;
}

let cached: DisclosureModules | null = null;

async function modules(): Promise<DisclosureModules | null> {
  if (cached) return cached;
  try {
    const [disclose, expand, wiki] = await Promise.all([
      import(coreUrl('disclose.mjs')),
      import(coreUrl('expand.mjs')),
      import(coreUrl('wiki.mjs')),
    ]);
    cached = { disclose, expand, wiki };
    return cached;
  } catch {
    return null;
  }
}

interface ToolResult {
  content?: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

/** The file this call is about, if it names one. */
function anchorsOf(args: Record<string, unknown> | undefined): string[] {
  if (!args) return [];
  const out: string[] = [];
  for (const key of ['file_path', 'filePath', 'path', 'file']) {
    const value = args[key];
    if (typeof value === 'string' && value) out.push(value);
  }
  const list = args.files ?? args.paths;
  if (Array.isArray(list)) {
    for (const value of list) if (typeof value === 'string') out.push(value);
  }
  return out;
}

/**
 * What the caller is trying to find out.
 *
 * A search tool states its question in its arguments, which is exactly the
 * signal a positional truncator throws away.
 */
function questionOf(
  args: Record<string, unknown> | undefined
): string | undefined {
  if (!args) return undefined;
  for (const key of ['query', 'pattern', 'question', 'search', 'q']) {
    const value = args[key];
    if (typeof value === 'string' && value) return value;
  }
  return undefined;
}

/** Every text part of a tool result, joined. */
function textOf(result: ToolResult): string {
  return (result?.content || [])
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text as string)
    .join('\n');
}

/**
 * Replaces an oversized tool result with a preview and a pointer.
 *
 * Errors pass through untouched: a truncated failure is a support ticket, and
 * the whole value of an error message is the part a size policy would cut.
 */
export async function discloseResult(
  toolName: string,
  args: Record<string, unknown> | undefined,
  result: ToolResult,
  costMs?: number
): Promise<ToolResult> {
  if (!result || result.isError) return result;

  const body = textOf(result);
  if (!body) return result;

  const mods = await modules();
  if (!mods) return result;

  try {
    const dir = mods.wiki.wikiDir(process.cwd());
    const anchors = anchorsOf(args);
    const question = questionOf(args);

    // Nothing is disclosed until it has been stored, or the pointer in the
    // preview would name something unreachable.
    const shape = mods.disclose.parseShape(body).shape;
    const ref = mods.expand.capture(dir, body, {
      tool: toolName,
      shape,
      anchors,
      costMs: Number.isFinite(costMs) ? costMs : null,
    });

    // The refit from this tool and shape's own expansion history, so previews
    // that keep getting expanded stop being the same previews.
    const { boosts } = mods.expand.previewPolicy(dir, {
      tool: toolName,
      shape,
    });

    const graph = anchors.length ? mods.wiki.load(dir) : null;
    const out = mods.disclose.disclose(dir, body, {
      graph,
      question,
      anchors,
      tool: toolName,
      boosts,
      ref,
    });
    if (!out) return result;

    return {
      ...result,
      content: [{ type: 'text', text: out.text }],
    };
  } catch {
    // Disclosure is an optimisation. It must never be the reason a tool fails.
    return result;
  }
}

/** Follows a pointer: serves from the store, records the miss, and promotes. */
export async function expandRef(input: {
  ref: string;
  section?: string;
  reason?: string;
  claim?: string;
  anchor?: string;
}): Promise<ToolResult> {
  const mods = await modules();
  if (!mods) {
    return {
      content: [
        {
          type: 'text',
          text: 'Expansion is unavailable: the graph modules could not be loaded.',
        },
      ],
      isError: true,
    };
  }

  const dir = mods.wiki.wikiDir(process.cwd());
  const out = mods.expand.resolve(dir, input.ref, { section: input.section });
  if (!out) {
    return {
      content: [
        {
          type: 'text',
          text: `No stored output for reference ${input.ref}. It may have been captured in another project.`,
        },
      ],
      isError: true,
    };
  }

  // The labelled datum: the preview was wrong, and this is what was wanted.
  mods.expand.recordExpansion(dir, {
    ref: input.ref,
    section: input.section,
    asked: input.section || input.reason || null,
  });

  // And the reason it does not happen twice.
  if (input.claim && input.anchor) {
    mods.expand.promote(dir, {
      ref: input.ref,
      claim: input.claim,
      anchor: input.anchor,
      section: input.section,
    });
  }

  return { content: [{ type: 'text', text: out.text }] };
}

/** The tool definition, kept next to the implementation it describes. */
export const EXPAND_TOOL = {
  name: 'expand',
  description:
    'Retrieve the full output behind a preview reference, served from the local store rather than by re-running anything. ' +
    'Pass `section` to say which named part of the preview you needed -- that is what teaches the next preview to keep it. ' +
    'Pass `claim` and `anchor` to record what you learned, so the same expansion never happens again.',
  inputSchema: {
    type: 'object',
    properties: {
      ref: {
        type: 'string',
        description: 'The reference printed in the preview',
      },
      section: {
        type: 'string',
        description:
          'Which omitted section you needed (e.g. "passing tests", "library and runtime frames")',
      },
      reason: {
        type: 'string',
        description:
          'Why the preview was not enough, if no single section covers it',
      },
      claim: {
        type: 'string',
        description:
          'What the expanded content established, to carry forward as a finding',
      },
      anchor: { type: 'string', description: 'The file that claim is about' },
    },
    required: ['ref'],
  },
} as const;
