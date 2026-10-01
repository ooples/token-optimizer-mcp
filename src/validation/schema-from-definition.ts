/**
 * Builds a Zod schema from the JSON Schema a tool already publishes.
 *
 * WHY THIS EXISTS: validation used to be hand-written beside the advertised
 * definitions, and the two drifted in both directions. 43 of the 101 validated
 * tools pointed at a `z.record(z.string(), z.any())` placeholder that accepts
 * anything, and of the remaining 58, 18 had Zod schemas missing keys their own
 * advertised schema publishes -- so turning strictness on would have refused
 * documented options. Deriving removes the class of bug rather than the
 * instances: there is one description of a tool's arguments, and it is the one
 * the caller is shown.
 *
 * WHAT IT DOES NOT DO: it never applies a JSON Schema `default`. Parsed args go
 * straight to the tool body, and tools distinguish an absent option from a
 * supplied one (`options.useCache !== false`); materialising defaults here would
 * change behaviour that is not ours to change. The schema's defaults remain
 * documentation for the caller, which is what they were.
 */

import { z } from 'zod';

/** The subset of JSON Schema the tool definitions use. */
export interface JsonSchemaNode {
  type?: string | string[];
  enum?: unknown[];
  const?: unknown;
  properties?: Record<string, JsonSchemaNode>;
  required?: string[];
  items?: JsonSchemaNode;
  additionalProperties?: boolean | JsonSchemaNode;
  oneOf?: JsonSchemaNode[];
  anyOf?: JsonSchemaNode[];
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  pattern?: string;
  format?: string;
  description?: string;
  default?: unknown;
}

/**
 * Regex timeout guard. A `pattern` comes from our own definitions rather than
 * from a caller, but a pattern is still compiled and run against caller text,
 * so it gets a bounded run like every other regex in this codebase.
 */
const PATTERN_TIMEOUT_MS = 1000;

/**
 * The `format` values the definitions publish, and what each one accepts.
 *
 * Five keys published one of these and nothing checked it: analyze_project_
 * tokens.startDate/endDate as `date`, and smart_cache_api.since plus
 * smart_glob.modifiedAfter/modifiedBefore as `date-time`. A published format
 * that is not applied is a rule every caller is shown and no request is held
 * to, so each is derived here.
 *
 * A format NOT listed here throws when the schema is built, rather than being
 * skipped: the whole point of deriving validation from the publication is that
 * a rule cannot be advertised without being enforced, and a silent skip is how
 * these five came to be decorative.
 */
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const DATE_TIME =
  /^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}(:\d{2})?(\.\d+)?([Zz]|[+-]\d{2}:\d{2})?$/;

/** A real calendar day, so 2026-02-30 is refused rather than rolled over. */
const isCalendarDate = (value: string): boolean => {
  const parts = value.split('-').map((part) => Number(part));
  const parsed = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
  return (
    parsed.getUTCFullYear() === parts[0] &&
    parsed.getUTCMonth() === parts[1] - 1 &&
    parsed.getUTCDate() === parts[2]
  );
};

const FORMAT_CHECKS: Record<string, (value: string) => boolean> = {
  date: (value) => DATE_ONLY.test(value) && isCalendarDate(value),
  'date-time': (value) =>
    DATE_TIME.test(value) && !Number.isNaN(Date.parse(value)),
};

const union = (options: z.ZodTypeAny[]): z.ZodTypeAny =>
  z.union(options as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]]);

const scalar = (node: JsonSchemaNode, type: string): z.ZodTypeAny => {
  switch (type) {
    case 'string': {
      let s = z.string();
      if (typeof node.minLength === 'number') s = s.min(node.minLength);
      if (typeof node.maxLength === 'number') s = s.max(node.maxLength);
      if (typeof node.pattern === 'string') {
        const compiled = new RegExp(node.pattern);
        return s.refine(
          (value) => {
            const started = Date.now();
            const ok = compiled.test(value);
            if (Date.now() - started > PATTERN_TIMEOUT_MS) return false;
            return ok;
          },
          { message: `must match ${node.pattern}` }
        );
      }
      if (typeof node.format === 'string') {
        const check = FORMAT_CHECKS[node.format];
        if (check === undefined)
          throw new Error(
            `schema-from-definition: published format "${node.format}" has no check; add one rather than publishing a rule nothing applies`
          );
        // Same bounded run as a published `pattern`: both compile a literal
        // regex here and test it against caller text.
        return s.refine(
          (value) => {
            const started = Date.now();
            const ok = check(value);
            if (Date.now() - started > PATTERN_TIMEOUT_MS) return false;
            return ok;
          },
          { message: `must be a valid ${node.format}` }
        );
      }
      return s;
    }
    case 'number':
    case 'integer': {
      let n = type === 'integer' ? z.number().int() : z.number();
      if (typeof node.minimum === 'number') n = n.min(node.minimum);
      if (typeof node.maximum === 'number') n = n.max(node.maximum);
      /*
       * The exclusive bounds, which this deriver used to skip. A skipped
       * keyword is worse than an absent one: the definition advertises a rule,
       * tools/list serves it, and nothing holds the request to it -- the exact
       * drift that deleting the hand-written schema layer was meant to end.
       * published-schema-keywords-are-derived.test.ts now fails on any
       * keyword appearing in a definition that this file does not read.
       */
      if (typeof node.exclusiveMinimum === 'number')
        n = n.gt(node.exclusiveMinimum);
      if (typeof node.exclusiveMaximum === 'number')
        n = n.lt(node.exclusiveMaximum);
      return n;
    }
    case 'boolean':
      return z.boolean();
    case 'null':
      return z.null();
    case 'array': {
      const inner = node.items ? zodFor(node.items, false) : z.unknown();
      let arr = z.array(inner);
      if (typeof node.minItems === 'number') arr = arr.min(node.minItems);
      if (typeof node.maxItems === 'number') arr = arr.max(node.maxItems);
      return arr;
    }
    case 'object':
      return objectFor(node, false);
    default:
      return z.unknown();
  }
};

/**
 * Nested objects follow what they declare, and the declaration is usually
 * nothing -- a `checkConfig` or a `chartConfig` is a payload whose shape varies
 * by operation and which no definition spells out. Refusing undeclared keys
 * there would reject working calls on the strength of a schema that was never
 * written, so a nested object is strict only where it lists its properties and
 * says `additionalProperties: false`. The TOP level is different: every argument
 * a tool accepts is published, so an unpublished one is a mistake worth naming.
 */
const objectFor = (node: JsonSchemaNode, topLevel: boolean): z.ZodTypeAny => {
  const properties = node.properties;
  if (!properties || Object.keys(properties).length === 0) {
    // `properties: {}` at the top level means the tool takes no arguments, and
    // two do: cache_audit and get_cache_stats are both called with none.
    // Accepting a record there would have left the only two tools whose whole
    // argument list is "nothing" as the two that accept anything.
    if (topLevel) return z.object({}).strict();
    if (
      node.additionalProperties &&
      typeof node.additionalProperties === 'object'
    )
      return z.record(z.string(), zodFor(node.additionalProperties, false));
    return z.record(z.string(), z.unknown());
  }
  const required = new Set(node.required ?? []);
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [key, child] of Object.entries(properties)) {
    const built = zodFor(child, false);
    if (!required.has(key)) {
      shape[key] = built.optional();
      continue;
    }
    /*
     * A required key whose node names no type derives to z.unknown(), and
     * z.unknown() ACCEPTS undefined -- so `required` was published, served by
     * tools/list and enforced on nothing. Measured on a typeless `payload`
     * that export operations require: `{ operation: 'export', format: 'csv' }`
     * validated, and only the tool refused it.
     *
     * The probe is taken here rather than keyed off `type` so it also covers
     * any future node that happens to admit undefined.
     */
    shape[key] = built.safeParse(undefined).success
      ? built.refine((value) => value !== undefined, { message: 'Required' })
      : built;
  }
  /*
   * A `required` key the node does not describe still has to be present. That
   * is how a conditional branch is written: optimization_storage's store branch
   * pins `operation` to a constant and then names the five fields a store
   * needs, whose types are published once in the sibling property list. Reading
   * `required` only through `properties` dropped exactly those five.
   */
  for (const key of required)
    if (!(key in shape))
      shape[key] = z.custom((value) => value !== undefined, {
        message: 'Required',
      });
  const built = z.object(shape);
  if (topLevel || node.additionalProperties === false) return built.strict();
  return built.passthrough();
};

const zodFor = (node: JsonSchemaNode, topLevel: boolean): z.ZodTypeAny => {
  if (!node || typeof node !== 'object') return z.unknown();

  if ('const' in node) return z.literal(node.const as never);

  if (Array.isArray(node.enum) && node.enum.length > 0) {
    const literals: z.ZodTypeAny[] = node.enum.map((value) =>
      z.literal(value as z.Primitive)
    );
    return literals.length === 1 ? literals[0] : union(literals);
  }

  const branches = node.oneOf ?? node.anyOf;
  if (Array.isArray(branches) && branches.length > 0) {
    const built = branches.map((branch) => zodFor(branch, false));
    const choice = built.length === 1 ? built[0] : union(built);
    /*
     * A branch list does not replace the keywords beside it. cognition_record
     * publishes `properties`, `required` AND an `anyOf` saying that `kind` and
     * `semanticObject` are required unless the operation is verify-evidence --
     * all of it applies at once, which is what json schema means by sibling
     * keywords. Deriving the branches alone dropped every published property
     * and left the tool accepting any object with the right disjunction.
     */
    const siblings = { ...node, oneOf: undefined, anyOf: undefined };
    if (
      siblings.type === undefined &&
      !siblings.properties &&
      !siblings.required
    )
      return choice;
    return z.intersection(zodFor(siblings, topLevel), choice);
  }

  /*
   * `required` with no `properties` is how a conditional branch names the
   * fields that branch needs, the shapes being published once in the sibling
   * list. Deriving it as a free-form object would make the branch vacuous and
   * the disjunction meaningless, so presence is what gets checked here.
   *
   * It has to be a custom check and not `z.unknown()`: measured, an unknown-
   * typed key in a zod object is satisfied by a missing key, so a shape built
   * from unknowns accepts the empty object and enforces nothing.
   */
  if (
    !node.type &&
    !node.properties &&
    Array.isArray(node.required) &&
    node.required.length
  ) {
    const shape: Record<string, z.ZodTypeAny> = {};
    for (const key of node.required)
      shape[key] = z.custom((value) => value !== undefined, {
        message: 'Required',
      });
    return z.object(shape).passthrough();
  }

  /*
   * `properties` with no `type` is an object schema -- json schema infers it,
   * and that is exactly how a branch in a published anyOf is written:
   * `{ properties: { operation: { const: 'store' } }, required: [...] }`.
   * Falling through to `unknown` below made every such branch accept anything,
   * and a union of vacuous branches enforces nothing. Measured before the fix:
   * optimization_storage accepted a `store` carrying none of its five payload
   * fields, and context_delta accepted a `compute-delta` with no content.
   */
  if (!node.type && node.properties) return objectFor(node, topLevel);

  if (Array.isArray(node.type)) {
    const built = node.type.map((type) => scalar(node, type));
    return built.length === 1 ? built[0] : union(built);
  }

  if (typeof node.type === 'string')
    return node.type === 'object'
      ? objectFor(node, topLevel)
      : scalar(node, node.type);

  // No type, no enum, no branches: four properties across the surface are
  // declared as free-form payloads (cache_compression.data, smart_websocket
  // .message and two more). `unknown` accepts them without pretending to check.
  return z.unknown();
};

/** Build the top-level argument schema for one tool definition. */
export const schemaFromDefinition = (
  inputSchema: JsonSchemaNode
): z.ZodTypeAny => zodFor(inputSchema ?? { type: 'object' }, true);
