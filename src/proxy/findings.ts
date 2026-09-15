/**
 * Reading the knowledge graph from the proxy, without making the proxy depend
 * on it.
 *
 * WHY THIS IS A SEPARATE FILE AND NOT AN IMPORT. `hooks-core` is plain ESM
 * resolved by path at call time -- the runtime directory it lives in can be
 * replaced under a running process, which is a failure this package has
 * already had (`Cannot find module .../hooks-core/wiki.mjs` from every wiki
 * call for the rest of a session's life). The compression engines are
 * synchronous pure functions and must not acquire a filesystem dependency, so
 * the graph is read HERE, once, and handed to the strategy as plain data.
 *
 * FAIL SILENT, NOT FAIL LOUD. Every branch that cannot read the graph returns
 * an empty list. The knowledge block is an optimisation on top of a working
 * proxy: a project with no graph, a pruned runtime, a permissions error and a
 * corrupt line all mean the same thing here -- no findings this session, carry
 * on compressing.
 */

import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Finding } from '../compress/knowledge.js';
import { sharedGraphFor } from './graph-scope.js';

/** Where a project keeps its graph, matching `hooks-core/wiki.mjs#wikiDir`. */
function graphDir(root: string): string {
  return join(root, '.token-optimizer', 'wiki');
}

/**
 * Findings plus whether the graph they came from is shared across projects.
 *
 * The flag travels WITH the findings because it qualifies them: on a shared
 * graph a `project` claim is a fact about some tree, and nothing downstream can
 * say which. Returning the two separately invites a caller to use one without
 * the other, which is how `scope` came to be dropped here in the first place.
 */
export interface LoadedFindings {
  readonly findings: Finding[];
  readonly sharedGraph: boolean;
}

export async function loadFindings(root: string): Promise<Finding[]> {
  return (await loadFindingsFrom(root)).findings;
}

/**
 * Loads active findings for one project.
 *
 * Called at proxy startup and then again on a throttled background refresh --
 * never on the request path, which is synchronous. A block that changes
 * mid-conversation cannot sit in a cached prefix, so the refresh does not
 * serve the conversation it runs during; it serves the next one, which is what
 * makes a finding written today reach tomorrow without a restart.
 */
export async function loadFindingsFrom(root: string): Promise<LoadedFindings> {
  const dir = graphDir(root);

  // NO EXISTENCE CHECKS, and not merely to satisfy `n/no-sync`. Every one of
  // them was a second way to say what the catch below already says, and each
  // added a window between the check and the use in which the answer could
  // change -- which is exactly how this package lost its wiki tools once
  // before, to a runtime directory pruned underneath a live session. Missing
  // directory, pruned module, unreadable file and corrupt line all land in the
  // same place, and that place returns no findings and carries on.
  try {
    const here = new URL('.', import.meta.url);
    const moduleUrl = (name: string): string =>
      pathToFileURL(
        new URL(`../../hooks-core/${name}`, here).pathname.replace(
          /^\/([A-Za-z]:)/,
          '$1'
        )
      ).href;

    const [wikiMod, curateMod] = await Promise.all([
      import(moduleUrl('wiki.mjs')),
      import(moduleUrl('curate.mjs')),
    ]);

    const graph = wikiMod.load(dir);
    const active = curateMod.activeFindings(graph) as Record<string, unknown>[];
    const findings = active
      .filter((node) => typeof node.claim === 'string')
      .map((node) => ({
        claim: node.claim as string,
        key: typeof node.key === 'string' ? node.key : undefined,
        type: typeof node.type === 'string' ? node.type : undefined,
        confidence:
          typeof node.confidence === 'number' ? node.confidence : undefined,
        origin: typeof node.origin === 'string' ? node.origin : undefined,
        pinned: node.pinned === true,
        retired: node.retired === true,
        // CARRIED THROUGH, because these two decide whether a finding is safe
        // to put in a cached prefix and both were being dropped here. Measured
        // on this repository: of 319 claim-bearing nodes, 66 are stale and 25
        // are not verified. A stale finding is one whose anchored code has
        // since changed, so it is advice derived from a tree that no longer
        // exists -- and in the prefix it is re-read on every turn.
        confidenceLabel:
          typeof node.confidenceLabel === 'string'
            ? node.confidenceLabel
            : undefined,
        stale: node.stale === true,
        // THE THIRD FIELD THAT DECIDES SAFETY IN A PREFIX, and it was missing.
        // Without it `knowledgeBlock` cannot tell a claim that travels from one
        // that is true only of the tree it came from, so a shared graph serves
        // one project's specifics to another as if they were established fact.
        scope: typeof node.scope === 'string' ? node.scope : undefined,
      }));

    return {
      findings,
      sharedGraph: sharedGraphFor(dir, wikiMod),
    };
  } catch {
    // A pruned runtime, an unreadable directory, a corrupt line. None of them
    // is a reason to stop compressing.
    return { findings: [], sharedGraph: false };
  }
}
