/**
 * wiki_write — the agent records a conclusion while it still holds the context.
 *
 * The wiki design named this tool ("Model-invoked `wiki_write` exists for the
 * agent to record something deliberately") but it was never built, so the only
 * route into the graph was a post-hoc extraction that itself was never wired.
 * The result was a graph with a full structural skeleton and zero findings.
 *
 * WHY THE AGENT AND NOT ONLY THE HARVEST. The harvest reads a transcript
 * afterwards with a cheap model and infers what was learned. The session that
 * did the work already knows, at no marginal cost and with nothing leaving the
 * machine. The design's objection to agent writes was that "anything opt-in
 * does not happen" — true of a suggestion, but this project answered exactly
 * that problem elsewhere by ENFORCING tool routing rather than advising it.
 *
 * The two paths are complements: this captures what the working session
 * concluded; the harvest, when enabled, catches what it forgot to record.
 */

import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { dirname } from 'path';

const here = dirname(fileURLToPath(import.meta.url));

/** Resolves hooks-core relative to the built output, which lives in dist/tools/intelligence. */
function coreUrl(name: string): string {
  return pathToFileURL(path.join(here, '..', '..', '..', 'hooks-core', name))
    .href;
}

export interface WikiWriteOptions {
  /** The claim itself. What was concluded, in a sentence someone can act on. */
  claim: string;
  /**
   * Files (or `file#symbol`) the claim is about. Required, and not decorative:
   * an unanchored finding can never be invalidated when the code changes, so it
   * would be served as permanently current. Anchors that do not resolve are
   * dropped and the finding is refused rather than stored unfalsifiable.
   */
  anchors: string[];
  /** finding | decision | failure | command | map. */
  type?: string;
  /**
   * Optional regex matched against a command about to run. Anchors answer
   * "which file"; a trigger answers "when". Without one, a claim about running
   * something can only surface if someone opens the file it is anchored to,
   * which is not when the advice is needed.
   */
  trigger?: string;
  /** 0..1. Defaults to 0.9 — deliberate, but still a model's assertion. */
  confidence?: number;
  /** Recorded for provenance so a claim can be traced to the session. */
  sessionId?: string;
  /** Overrides the project the finding belongs to. Defaults to the anchor's repo. */
  projectRoot?: string;
}

export interface WikiWriteResult {
  success: boolean;
  written: number;
  keys: string[];
  /** Anchors that named nothing on disk, so could not carry a claim. */
  unresolvedAnchors: string[];
  project?: string;
  error?: string;
}

const FINDING_TYPES = ['finding', 'decision', 'failure', 'command', 'map', 'feedback'];

export async function wikiWrite(
  options: WikiWriteOptions
): Promise<WikiWriteResult> {
  const empty = {
    written: 0,
    keys: [] as string[],
    unresolvedAnchors: [] as string[],
  };

  const claim = String(options?.claim ?? '').trim();
  if (claim.length < 8) {
    return {
      success: false,
      ...empty,
      error: 'claim must be a sentence, not a fragment',
    };
  }

  const anchors = Array.isArray(options?.anchors)
    ? options.anchors.filter((a) => typeof a === 'string' && a.trim())
    : [];
  if (!anchors.length) {
    return {
      success: false,
      ...empty,
      error:
        'anchors are required: a finding with nothing to anchor to can never be ' +
        'invalidated, so it would be served as current forever',
    };
  }

  const type = FINDING_TYPES.includes(String(options?.type))
    ? String(options.type)
    : 'finding';
  const confidence =
    Number.isFinite(options?.confidence) &&
    (options!.confidence as number) > 0 &&
    (options!.confidence as number) <= 1
      ? (options!.confidence as number)
      : 0.9;

  try {
    const [wiki, harvestWrite, curate] = await Promise.all([
      import(coreUrl('wiki.mjs')),
      import(coreUrl('harvest-write.mjs')),
      import(coreUrl('curate.mjs')),
    ]);

    // The finding belongs to the project the ANCHOR is in, not to wherever the
    // session happens to be running. A session that touches a second repository
    // would otherwise file its conclusions in the wrong graph, or in none.
    const project =
      options.projectRoot ??
      wiki.projectRootFor(anchors[0].split('#')[0], process.cwd());
    const dir = wiki.wikiDir(project);

    const keys: string[] = harvestWrite.writeHarvested(
      dir,
      [{ type, claim, confidence, anchors, trigger: options.trigger }],
      {
        sessionId: options.sessionId ?? null,
        origin: curate.ORIGIN_AGENT,
        // Confines anchors to this project: indexFile READS what it anchors and
        // stores a snapshot, so an unconstrained path would copy any readable
        // file on the machine into the graph.
        projectRoot: project,
      }
    );

    // Reported UNCONDITIONALLY, not only when nothing was written. A finding
    // with three anchors of which one is a typo is stored against the other two
    // and counts as a success, so gating this on failure hid exactly the case
    // worth telling the caller about: the claim is narrower than they asked for,
    // and the misspelled file will never invalidate it.
    const graph = wiki.load(dir);
    const unresolvedAnchors = anchors.filter((a) => {
      const [file, symbol] = a.split('#');
      const id = symbol
        ? wiki.nodeId('symbol', `${file}#${symbol}`)
        : wiki.nodeId('file', wiki.canonicalKey('file', file));
      return !graph.nodes.has(id);
    });

    return {
      success: keys.length > 0,
      written: keys.length,
      keys,
      unresolvedAnchors,
      project,
      error: keys.length
        ? undefined
        : 'no anchor resolved to a file on disk, so the finding was refused',
    };
  } catch (error) {
    return {
      success: false,
      ...empty,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export const WIKI_WRITE_TOOL_DEFINITION = {
  name: 'wiki_write',
  description:
    "Record a durable finding in this project's knowledge graph so a later session " +
    'retrieves it instead of re-deriving it. Use it the moment you conclude something ' +
    'that cost real work and is not obvious from the code: a dead end and why, a ' +
    'decision and its rejected alternatives, a command that finally worked, or how a ' +
    'subsystem fits together. Anchor it to the files it is about — the anchor is what ' +
    'lets the claim be invalidated when that code changes, and what makes it surface ' +
    'automatically when the file is next touched. Costs nothing and sends nothing off ' +
    'the machine.',
  inputSchema: {
    type: 'object',
    properties: {
      claim: {
        type: 'string',
        description:
          'The conclusion, in one actionable sentence. "X fails because Y" beats "investigated X".',
      },
      anchors: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Files the claim is about, as absolute paths, or "path#symbol" to anchor to one function.',
      },
      type: {
        type: 'string',
        enum: FINDING_TYPES,
        description:
          'failure = a dead end and why (highest value: nothing else records it). ' +
          'decision = a choice and what was rejected. command = an invocation that worked. ' +
          'map = how a subsystem fits together.',
      },
      confidence: {
        type: 'number',
        description:
          '0..1, default 0.9. Lower it when the claim is plausible but unverified.',
      },
      sessionId: {
        type: 'string',
        description: 'Optional session id, for provenance.',
      },
      trigger: {
        type: 'string',
        description:
          'Optional regex matched against a command about to run, e.g. "\\bnpx jest\\b". ' +
          'Anchors say which FILE a claim is about; a trigger says WHEN it is relevant. ' +
          'Set it on anything about running something, or the claim can only surface ' +
          'when someone happens to open the file it is anchored to.',
      },
      projectRoot: {
        type: 'string',
        description:
          'Optional. Defaults to the repository containing the first anchor.',
      },
    },
    required: ['claim', 'anchors'],
  },
};
