import { describe, it, expect } from '@jest/globals';

import { TOOL_DEFINITIONS } from '../../src/server/tool-definitions.js';
import {
  schemaFromDefinition,
  type JsonSchemaNode,
} from '../../src/validation/schema-from-definition.js';

/**
 * Every keyword a published schema uses must be one the deriver reads.
 *
 * WHY: validation is derived from the definition `tools/list` serves, so the
 * published schema is the one description of a tool's arguments. A keyword the
 * deriver does not read breaks that in the quietest possible way -- the rule is
 * advertised to every caller, appears in the definition, and is enforced on
 * nothing. It is strictly worse than not publishing the rule at all, because a
 * caller who reads it believes a check is happening.
 *
 * Measured when this check was written: `exclusiveMinimum` had just been
 * published on smart-summarization.intervalHours and the deriver skipped it, so
 * `intervalHours: 0` would have been accepted by validation and refused only by
 * the tool. The deriver now reads it.
 *
 * HOW: two halves, because either alone is vacuous.
 *   1. A census over every definition: no keyword outside the known sets.
 *   2. A probe per derived keyword: a value that keyword must REJECT. A
 *      keyword listed as derived but silently dropped fails here, which is
 *      what the census on its own cannot see.
 */

/** Keywords that change what validation accepts. Each has a probe below. */
const DERIVED = Object.freeze([
  'additionalProperties',
  'anyOf',
  'const',
  'enum',
  'exclusiveMaximum',
  'exclusiveMinimum',
  'format',
  'items',
  'maxItems',
  'maxLength',
  'maximum',
  'minItems',
  'minLength',
  'minimum',
  'oneOf',
  'pattern',
  'properties',
  'required',
  'type',
]);

/**
 * Keywords that carry no constraint and are not expected to be enforced.
 * `default` is documentation: no tool's handler reads it out of the schema, and
 * a deriver that applied it would start inventing values the caller did not
 * send -- which is the opposite of what this surface needs.
 */
const DOCUMENTED = Object.freeze(['default', 'description', 'examples']);

const keywordsIn = (node: unknown, found: Set<string>): void => {
  if (Array.isArray(node)) {
    for (const entry of node) keywordsIn(entry, found);
    return;
  }
  if (node === null || typeof node !== 'object') return;
  for (const [key, value] of Object.entries(node)) {
    found.add(key);
    // Under `properties` the keys are argument names, not keywords; the same
    // is true of a node reached through `properties`, whose own keys are.
    if (key === 'properties') {
      for (const child of Object.values(value as Record<string, unknown>))
        keywordsIn(child, found);
      continue;
    }
    if (key === 'required' || key === 'enum') continue;
    keywordsIn(value, found);
  }
};

const PUBLISHED_KEYWORDS: Set<string> = (() => {
  const found = new Set<string>();
  for (const definition of TOOL_DEFINITIONS)
    keywordsIn(definition.inputSchema, found);
  return found;
})();

interface Probe {
  keyword: string;
  node: JsonSchemaNode;
  accepts: unknown;
  rejects: unknown;
  /**
   * Dotted path to the sub-node carrying the keyword, when it is not the root.
   * The control deletes the keyword there and re-derives.
   */
  at?: string;
}

/** The sub-node a probe's keyword sits on. */
const nodeAt = (
  node: JsonSchemaNode,
  at: string | undefined
): Record<string, unknown> => {
  let current = node as Record<string, unknown>;
  for (const step of at === undefined ? [] : at.split('.'))
    current = current[step] as Record<string, unknown>;
  return current;
};

/** A deep copy of the probe's node with the keyword removed. */
const withoutKeyword = (probe: Probe): JsonSchemaNode => {
  const copy = JSON.parse(JSON.stringify(probe.node)) as JsonSchemaNode;
  delete nodeAt(copy, probe.at)[probe.keyword];
  return copy;
};

/**
 * One probe per derived keyword: a node using it, a value it must accept and a
 * value it must reject. The rejected value differs from the accepted one ONLY
 * in what the keyword constrains, so a pass cannot come from something else.
 */
const PROBES: readonly Probe[] = Object.freeze([
  { keyword: 'type', node: { type: 'string' }, accepts: 'x', rejects: 5 },
  {
    keyword: 'enum',
    node: { type: 'string', enum: ['a', 'b'] },
    accepts: 'a',
    rejects: 'c',
  },
  { keyword: 'const', node: { const: true }, accepts: true, rejects: false },
  {
    // Nested, so removing the keyword for the control leaves a free-form
    // object rather than changing the top level's strictness.
    keyword: 'properties',
    node: {
      type: 'object',
      properties: {
        inner: { type: 'object', properties: { a: { type: 'number' } } },
      },
    },
    accepts: { inner: { a: 1 } },
    rejects: { inner: { a: 'one' } },
    at: 'properties.inner',
  },
  {
    keyword: 'required',
    node: {
      type: 'object',
      properties: { a: { type: 'number' } },
      required: ['a'],
    },
    accepts: { a: 1 },
    rejects: {},
  },
  {
    keyword: 'items',
    node: { type: 'array', items: { type: 'number' } },
    accepts: [1, 2],
    rejects: [1, 'two'],
  },
  {
    // Nested, because the top level is strict regardless and would prove
    // nothing about the keyword being read.
    keyword: 'additionalProperties',
    node: {
      type: 'object',
      properties: {
        inner: {
          type: 'object',
          properties: { a: { type: 'number' } },
          additionalProperties: false,
        },
      },
    },
    accepts: { inner: { a: 1 } },
    rejects: { inner: { a: 1, b: 2 } },
    at: 'properties.inner',
  },
  {
    keyword: 'anyOf',
    node: { anyOf: [{ type: 'string' }, { type: 'number' }] },
    accepts: 'x',
    rejects: true,
  },
  {
    keyword: 'oneOf',
    node: { oneOf: [{ type: 'string' }, { type: 'number' }] },
    accepts: 7,
    rejects: true,
  },
  {
    keyword: 'minimum',
    node: { type: 'number', minimum: 1 },
    accepts: 1,
    rejects: 0,
  },
  {
    keyword: 'maximum',
    node: { type: 'number', maximum: 2 },
    accepts: 2,
    rejects: 3,
  },
  {
    // The bound is EXCLUSIVE, so the boundary value itself is the rejection:
    // a deriver that read this as `minimum` would accept 0 and pass a weaker
    // probe.
    keyword: 'exclusiveMinimum',
    node: { type: 'number', exclusiveMinimum: 0 },
    accepts: 0.5,
    rejects: 0,
  },
  {
    keyword: 'exclusiveMaximum',
    node: { type: 'number', exclusiveMaximum: 1 },
    accepts: 0.5,
    rejects: 1,
  },
  {
    keyword: 'minLength',
    node: { type: 'string', minLength: 2 },
    accepts: 'ab',
    rejects: 'a',
  },
  {
    keyword: 'maxLength',
    node: { type: 'string', maxLength: 2 },
    accepts: 'ab',
    rejects: 'abc',
  },
  {
    keyword: 'minItems',
    node: { type: 'array', minItems: 1 },
    accepts: [1],
    rejects: [],
  },
  {
    keyword: 'maxItems',
    node: { type: 'array', maxItems: 1 },
    accepts: [1],
    rejects: [1, 2],
  },
  {
    // Published on five keys and applied to none until this check existed:
    // two `date` and three `date-time`. The rejected value is a well-formed
    // date that does not exist, so a check that only tested the shape fails.
    keyword: 'format',
    node: { type: 'string', format: 'date' },
    accepts: '2026-02-28',
    rejects: '2026-02-30',
  },
  {
    keyword: 'pattern',
    node: { type: 'string', pattern: '^a+$' },
    accepts: 'aaa',
    rejects: 'ab',
  },
]);

describe('published schema keywords are derived', () => {
  it('publishes only keywords the deriver reads or deliberately ignores', () => {
    const known = new Set([...DERIVED, ...DOCUMENTED]);
    const unknown = [...PUBLISHED_KEYWORDS]
      .filter((keyword) => !known.has(keyword))
      .sort();
    expect(unknown).toEqual([]);
  });

  it('covers every derived keyword with a probe', () => {
    const probed = new Set(PROBES.map((probe) => probe.keyword));
    expect([...DERIVED].filter((keyword) => !probed.has(keyword))).toEqual([]);
    expect(PROBES.length).toBe(DERIVED.length);
  });

  it.each(PROBES.map((probe) => [probe.keyword, probe] as const))(
    'enforces %s',
    (_keyword, probe) => {
      const schema = schemaFromDefinition(probe.node);
      expect(schema.safeParse(probe.accepts).success).toBe(true);
      expect(schema.safeParse(probe.rejects).success).toBe(false);
      /*
       * The control: the same node with ONLY this keyword deleted must accept
       * the value the keyword rejected. Without it a probe passes whenever
       * anything in the node refuses the value -- a wrong `type`, a strict
       * parent -- and would report the keyword as enforced while the deriver
       * ignored it.
       */
      const control = schemaFromDefinition(withoutKeyword(probe));
      expect(control.safeParse(probe.rejects).success).toBe(true);
    }
  );

  it('still sees the keywords the live definitions use', () => {
    // A census that found nothing would report a clean surface.
    for (const keyword of ['type', 'enum', 'properties', 'required'])
      expect(PUBLISHED_KEYWORDS.has(keyword)).toBe(true);
    expect(PUBLISHED_KEYWORDS.size).toBeGreaterThan(8);
  });
});
