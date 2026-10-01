import { z } from 'zod';

import { TOOL_DEFINITIONS } from '../server/tool-definitions.js';
import {
  schemaFromDefinition,
  type JsonSchemaNode,
} from './schema-from-definition.js';

/* ------------------------------------------------------------------------ *
 * ONE description of each tool's arguments.
 *
 * This file used to hold a second one: 101 hand-written zod schemas, one per
 * tool, maintained beside the definition `tools/list` publishes rather than
 * from it. Measured against a live tools/list the two had drifted in both
 * directions -- 43 entries pointed at a `z.record(z.any())` that accepts
 * anything, 18 of the real ones were missing keys their own published schema
 * advertises, 7 tools had no entry at all, and 3 keys were invented here and
 * read by no tool (smart_diff.ref, smart_branch.branch, smart_status.filePath).
 *
 * Reconciling the two copies would have left the second copy. So everything
 * the hand-written layer carried that the publication did not was PUBLISHED
 * instead -- the git-ref/path/filter/package patterns, the length and numeric
 * bounds, `clear_cache.confirm: const true`, the ISO-timestamp formats, and
 * the conditional requirements of optimization_storage and context_delta as
 * sibling `anyOf` branches -- and then this layer was deleted. A caller can
 * now discover every rule that will be applied to their request, which was
 * never true while the rules lived in a file no caller is served.
 *
 * Before deleting it, the two were fuzzed against each other: 4,720
 * comparisons over 19 adversarial string values, 6 numerics and 5 array
 * shapes per published key. 304 disagreements, every one of them the derived
 * schema refusing what the hand-written one allowed -- 264 against a published
 * `enum`, 40 against a published item type. Zero in the other direction, which
 * is the direction that would have been a regression.
 *
 * The one real weakening the fuzz caught was ours and is fixed in the
 * definitions: wiki_query.limit and get_optimization_report.topN had been
 * published as `number, minimum 0` where both implementations clamp with
 * `Math.max(1, ...)`, so they now publish `integer, minimum 1`.
 * ------------------------------------------------------------------------ */

const deriveToolSchemaMap = (): Record<string, z.ZodType<any>> => {
  const map: Record<string, z.ZodType<any>> = {};
  for (const definition of TOOL_DEFINITIONS) {
    const name = definition.name;
    if (typeof name !== 'string') continue;
    const derived = schemaFromDefinition(
      definition.inputSchema as JsonSchemaNode
    );
    map[name] = derived;
  }
  return map;
};

export const toolSchemaMap: Record<
  string,
  z.ZodType<any>
> = deriveToolSchemaMap();
