import { describe, it, expect } from '@jest/globals';
import { z } from 'zod';

import { TOOL_DEFINITIONS } from '../../src/server/tool-definitions.js';
import { toolSchemaMap } from '../../src/validation/tool-schemas.js';
import { getValidatedTools } from '../../src/validation/validator.js';

/**
 * Validation and the published schema must be the same description of a tool.
 *
 * They were not. The map was hand-written beside the definitions instead of
 * from them, and measured against a live tools/list it had drifted both ways:
 *
 *   - 43 of 101 entries were `GenericToolOptionsSchema`, a
 *     `z.record(z.string(), z.any())` that accepts anything, so for those tools
 *     the published `required` array and property list were documentation only;
 *   - 18 of the remaining 58 were missing keys their own published schema
 *     advertises, so turning strictness on would have refused smart_glob's
 *     `path` or smart_grep's `wholeWord` -- documented options;
 *   - 7 advertised tools had no entry at all, and were answered before the
 *     validating path so nobody noticed.
 *
 * The map is derived now, which is why this file checks the PROPERTY rather
 * than a list of tools: parity and strictness hold for whatever the surface
 * grows into, and a new tool cannot arrive unvalidated.
 */
describe('validation is derived from the published schema', () => {
  const definitions = TOOL_DEFINITIONS.filter(
    (definition) => typeof definition.name === 'string'
  );

  it('validates every advertised tool', () => {
    const validated = new Set(getValidatedTools());
    const missing = definitions
      .map((definition) => definition.name)
      .filter((name) => !validated.has(name));
    expect(missing).toEqual([]);
    expect(Object.keys(toolSchemaMap).length).toBe(definitions.length);
  });

  /**
   * Walks past the wrappers a derived schema can be built behind -- an
   * intersection with a conditional refinement, an effect -- to the object
   * whose keys are the tool's arguments.
   */
  const shapeOf = (schema: unknown): Record<string, unknown> | null => {
    const node = schema as { _def?: Record<string, unknown> };
    const def = node?._def;
    if (!def) return null;
    const shape = def.shape;
    if (typeof shape === 'function')
      return (shape as () => Record<string, unknown>)();
    if (shape && typeof shape === 'object')
      return shape as Record<string, unknown>;
    if (def.left) return shapeOf(def.left);
    if (def.schema) return shapeOf(def.schema);
    return null;
  };

  it('accepts exactly the properties each tool publishes', () => {
    const mismatched: string[] = [];
    for (const definition of definitions) {
      const published = Object.keys(
        (definition.inputSchema as { properties?: Record<string, unknown> })
          ?.properties ?? {}
      );
      const shape = shapeOf(toolSchemaMap[definition.name]);
      if (!shape) {
        // No object shape is only correct where nothing is published, and the
        // two tools in that position take no arguments at all.
        if (published.length) mismatched.push(`${definition.name}: no shape`);
        continue;
      }
      const accepted = Object.keys(shape).sort();
      const expected = [...published].sort();
      if (accepted.join(',') !== expected.join(','))
        mismatched.push(
          `${definition.name}: accepts [${accepted}] publishes [${expected}]`
        );
    }
    expect(mismatched).toEqual([]);
  });

  it('refuses an argument no tool publishes', () => {
    const leaky: string[] = [];
    for (const [name, schema] of Object.entries(toolSchemaMap)) {
      const result = (schema as z.ZodType<unknown>).safeParse({
        __not_a_published_option__: 1,
      });
      if (result.success) leaky.push(name);
    }
    expect(leaky).toEqual([]);
  });

  /**
   * The positive control. A test that only ever sends a bogus key cannot tell
   * a strict schema from one that rejects everything, which would pass the
   * check above while refusing every real call -- so each tool must also
   * accept a request built from its own published schema.
   */
  type JsonNode = {
    type?: string | string[];
    enum?: unknown[];
    const?: unknown;
    properties?: Record<string, JsonNode>;
    required?: string[];
    items?: JsonNode;
    oneOf?: JsonNode[];
    anyOf?: JsonNode[];
    minimum?: number;
    minLength?: number;
    minItems?: number;
  };

  const firstOf = (
    branches: JsonNode[] | undefined,
    key: string
  ): JsonNode | undefined => {
    for (const branch of branches ?? [])
      if (branch.properties?.[key]) return branch.properties[key];
    return undefined;
  };

  const sampleFor = (node: JsonNode): unknown => {
    if (!node || typeof node !== 'object') return null;
    if ('const' in node) return node.const;
    if (Array.isArray(node.enum) && node.enum.length) return node.enum[0];
    const branches = node.oneOf ?? node.anyOf;
    const type = Array.isArray(node.type) ? node.type[0] : node.type;
    if (branches && branches.length && !node.properties && type !== 'object')
      return sampleFor(branches[0]);
    switch (type) {
      case 'string':
        return 'x'.repeat(Math.max(1, node.minLength ?? 1));
      case 'number':
      case 'integer':
        return node.minimum ?? 1;
      case 'boolean':
        return true;
      case 'null':
        return null;
      case 'array': {
        // minItems matters: a published `minItems: 1` means the empty array is
        // not a valid request, so sampling [] would fail the control on a tool
        // whose schema is correct.
        const count = Math.max(node.minItems ?? 0, 0);
        return Array.from({ length: count }, () => sampleFor(node.items ?? {}));
      }
      case 'object':
      default: {
        if (
          type !== 'object' &&
          !node.properties &&
          !node.required &&
          !branches
        )
          return null;
        const out: Record<string, unknown> = {};
        const required = new Set(node.required ?? []);
        /*
         * A sibling branch list is part of the contract, not an alternative to
         * it, so the sample has to satisfy one branch -- the first. Sampling
         * the flat property list alone built a request missing whatever the
         * conditional branch adds, and the control then read as the schema
         * refusing its own valid input.
         */
        if (branches && branches.length) {
          const first = branches[0];
          for (const key of first.required ?? []) required.add(key);
          for (const [key, child] of Object.entries(first.properties ?? {}))
            out[key] = sampleFor(child);
        }
        for (const key of required)
          if (!(key in out))
            out[key] = sampleFor(
              node.properties?.[key] ?? firstOf(branches, key) ?? {}
            );
        return out;
      }
    }
  };

  it('accepts a request built from each published schema', () => {
    const refused: string[] = [];
    for (const definition of definitions) {
      const input = definition.inputSchema as Parameters<typeof sampleFor>[0];
      const args = sampleFor({ ...input, type: 'object' }) as Record<
        string,
        unknown
      >;
      const result = (
        toolSchemaMap[definition.name] as z.ZodType<unknown>
      ).safeParse(args);
      if (!result.success)
        refused.push(
          `${definition.name}: ${result.error.issues
            .map(
              (issue) => `${issue.path.join('.') || 'root'} ${issue.message}`
            )
            .join('; ')}`
        );
    }
    expect(refused).toEqual([]);
  });

  it('does not invent values the caller did not send', () => {
    // A derived schema must not materialise a json-schema `default`: tools read
    // `options.useCache !== false`, so handing them a key the caller never sent
    // changes behaviour. 328 defaults are declared across the surface.
    const invented: string[] = [];
    for (const definition of definitions) {
      const result = (
        toolSchemaMap[definition.name] as z.ZodType<unknown>
      ).safeParse(
        sampleFor({ ...(definition.inputSchema as object), type: 'object' }) as
          | Record<string, unknown>
          | undefined
      );
      if (!result.success) continue;
      const sent = Object.keys(
        sampleFor({
          ...(definition.inputSchema as object),
          type: 'object',
        }) as Record<string, unknown>
      ).sort();
      const back = Object.keys(result.data as Record<string, unknown>).sort();
      if (sent.join(',') !== back.join(','))
        invented.push(`${definition.name}: sent [${sent}] got [${back}]`);
    }
    expect(invented).toEqual([]);
  });
});
