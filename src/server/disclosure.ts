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
import { liftTextPart } from './text-part.js';

const here = dirname(fileURLToPath(import.meta.url));

/** One server process is one session. See the capture call below. */
const SESSION_ID = `mcp-${process.pid}-${Date.now().toString(36)}`;

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
  _meta?: Record<string, unknown>;
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
/**
 * The reply as it leaves here when disclosure declines.
 *
 * A DECLINED DISCLOSURE IS NOT A FINISHED REPLY. Everything under the threshold
 * leaves with its largest string field still escaped inside a JSON string, and
 * measured on three thousand characters of this repository's own source read
 * through smart_read that escape is a sixth to a quarter of the whole reply --
 * 255 tokens of 1,089 on tool-profile.ts. Lifting it into its own text part
 * withholds nothing (see restoreTextPart) and is the only step that recovers it,
 * because the preview path recovers it already: parseShape renders a long
 * string field through a nested shape pass, which de-escapes it on the way.
 *
 * So this runs on every path that returns the tool's own payload, and never on
 * the preview path, where the body must stay one JSON document for parseShape
 * to read.
 */
function asSentParts(result: ToolResult): ToolResult {
  const { content, lifted } = liftTextPart(
    (result?.content || []) as Array<{ type: string; text: string }>
  );
  if (!lifted) return result;
  return { ...result, content };
}

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
  if (!mods) return asSentParts(result);

  try {
    const dir = mods.wiki.wikiDir(process.cwd());
    const anchors = anchorsOf(args);
    const question = questionOf(args);

    // Nothing is disclosed until it has been stored, or the pointer in the
    // preview would name something unreachable.
    const shape = mods.disclose.parseShape(body).shape;
    // The refit from this tool and shape's own expansion history, so previews
    // that keep getting expanded stop being the same previews.
    //
    // READ BEFORE THE CAPTURE BELOW, not after. `previewPolicy` counts served
    // previews from the capture log, so capturing this reply first put it in
    // its own evidence -- as a preview that had been served and not expanded,
    // which it cannot have been yet. On a fresh store that alone read as a
    // 1-for-1 hold record and the rate said this shape always holds.
    const { boosts, holdRateLower } = mods.expand.previewPolicy(dir, {
      tool: toolName,
      shape,
    });

    const ref = mods.expand.capture(dir, body, {
      tool: toolName,
      shape,
      anchors,
      // Captures were recorded with sessionId: null, so preview quality and
      // expansion history could not be grouped by session at all -- every
      // capture looked like it came from nowhere. The MCP server has no session
      // id from the client, but one process IS one session, so a per-process id
      // is both true and sufficient for grouping.
      sessionId: SESSION_ID,
      costMs: Number.isFinite(costMs) ? costMs : null,
    });

    const graph = anchors.length ? mods.wiki.load(dir) : null;
    const out = mods.disclose.disclose(dir, body, {
      graph,
      question,
      anchors,
      tool: toolName,
      boosts,
      ref,
      /**
       * How often a preview of this shape is NOT followed, as a lower bound.
       *
       * The bound rather than the point estimate, because this decides whether
       * to spend the caller's tokens on a preview: a shape gets the benefit of
       * its hold record only to the extent the record supports it, and a new
       * shape -- which has none -- is charged for the remainder in full.
       */
      holdRate: holdRateLower,
      /**
       * Stores what the preview is about to withhold, and returns the pointer
       * the preview will print.
       *
       * THE HANDLE USED TO NAME THE WHOLE BODY, so following it paid for the
       * preview a second time. Measured on a 1,270-token file read through
       * smart_read: a 1,192-token preview and then 1,778 tokens to expand it,
       * 2,970 for 1,270 of content, with the duplicated preview the biggest
       * term in the bill. A caller holding a preview needs the remainder.
       *
       * Captured with the SAME anchors and tool as the body, so staleness stays
       * answerable for the remainder exactly as it is for the whole: the
       * artifact store is keyed on content, and these two differ.
       */
      captureWithheld: (withheld: string) =>
        mods.expand.capture(dir, withheld, {
          tool: toolName,
          shape,
          anchors,
          sessionId: SESSION_ID,
          costMs: Number.isFinite(costMs) ? costMs : null,
        }),
    });
    if (!out) return asSentParts(result);

    return {
      ...result,
      content: [{ type: 'text', text: out.text }],
      _meta: {
        ...(result._meta || {}),
        tokenOptimizer: {
          // SPREAD, NOT REPLACED. A tool's declared baseline arrives on this
          // same key, and overwriting the object dropped it for exactly the
          // tools whose reply disclosure chose to trim -- the ones with the
          // largest before to declare.
          ...(result._meta?.tokenOptimizer || {}),
          // THE REFERENCE THE PREVIEW ACTUALLY PRINTED, which is now the
          // remainder rather than the body. record-tool-analytics debits an
          // expansion against the entry whose disclosureRef matches the ref the
          // caller passed to `expand`, so recording a reference the preview
          // never advertised would silently stop every debit from matching.
          disclosureRef: typeof out.handle === 'string' ? out.handle : ref,
          disclosureMode: out.mode,
        },
      },
    };
  } catch {
    // Disclosure is an optimisation. It must never be the reason a tool fails.
    return asSentParts(result);
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

  return {
    content: [{ type: 'text', text: out.text }],
    _meta: { tokenOptimizer: { expansionRef: input.ref } },
  };
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
