/**
 * Shared parser for reading tool schemas and Options interfaces out of source.
 *
 * ONE COPY, DELIBERATELY. Two tests need this and an earlier attempt kept a second
 * copy in a scratch script; the copies drifted, the stale one reported 11 freshly
 * declared properties as still missing, and the numbers looked plausible enough to
 * believe. A scanner that silently under-reports is worse than no scanner.
 */

export interface InterfaceField {
  name: string;
  optional: boolean;
  type: string;
}

export interface NestedShape {
  /** Keys under the property's `properties:` block. */
  properties: string[];
  /** Names listed in the property's own `required: [...]`. */
  required: string[];
  /** True when the property declares an array whose `items` carry the shape. */
  isArray: boolean;
}

/**
 * Top-level keys of the object literal whose `{` is at `open`.
 *
 * COMMENT-AWARE, and that is not a nicety. Without it an apostrophe inside a `//`
 * comment -- "the caller's argument object" -- opens a string that never closes and
 * every later key is swallowed.
 */
export function topLevelKeys(text: string, open: number): string[] {
  const keys: string[] = [];
  let depth = 0;
  let inString: string | null = null;

  for (let i = open; i < text.length; i++) {
    const c = text[i];

    if (inString) {
      if (c === '\\') i++;
      else if (c === inString) inString = null;
      continue;
    }
    if (c === '/' && text[i + 1] === '/') {
      const end = text.indexOf('\n', i);
      if (end === -1) break;
      i = end;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      if (end === -1) break;
      i = end + 1;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      inString = c;
      continue;
    }
    if (c === '{' || c === '[') {
      depth++;
      continue;
    }
    if (c === '}' || c === ']') {
      depth--;
      if (depth === 0) break;
      continue;
    }
    if (depth === 1 && /[A-Za-z_$]/.test(c)) {
      const m = /^([A-Za-z_$][\w$]*)\s*:/.exec(text.slice(i));
      if (m) {
        keys.push(m[1]);
        i += m[1].length;
      }
    }
  }
  return keys;
}

/** Index just past the matching close brace for the `{` at `open`, or -1. */
function matchingClose(text: string, open: number): number {
  let depth = 0;
  let inString: string | null = null;

  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === '\\') i++;
      else if (c === inString) inString = null;
      continue;
    }
    if (c === '/' && text[i + 1] === '/') {
      const end = text.indexOf('\n', i);
      if (end === -1) return -1;
      i = end;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      if (end === -1) return -1;
      i = end + 1;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      inString = c;
      continue;
    }
    if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** The source text of the `inputSchema.properties` object, or null. */
function schemaPropertiesSlice(text: string): string | null {
  const schema = text.indexOf('inputSchema');
  if (schema === -1) return null;
  const props = text.indexOf('properties:', schema);
  if (props === -1) return null;
  const open = text.indexOf('{', props);
  if (open === -1) return null;
  const close = matchingClose(text, open);
  return close === -1 ? null : text.slice(open, close + 1);
}

/** Names declared directly under `inputSchema.properties`. */
export function declaredProperties(text: string): string[] | null {
  const slice = schemaPropertiesSlice(text);
  if (!slice) return null;

  const top = topLevelKeys(slice, 0);
  if (!top.includes('options')) return top;

  // A few tools take options as a separate argument and nest them under `options`,
  // which is correct for that call shape.
  const optionsKey = slice.indexOf('options:');
  const nested =
    optionsKey === -1 ? -1 : slice.indexOf('properties:', optionsKey);
  if (nested === -1) return top;
  const open = slice.indexOf('{', nested);
  return open === -1 ? top : [...top, ...topLevelKeys(slice, open)];
}

/** Fields of every `export interface *Options` in the file, function/Buffer types dropped. */
export function acceptedOptions(text: string): string[] {
  return acceptedOptionFields(text).map((f) => f.name);
}

/**
 * The same fields WITH their declared types and optionality.
 *
 * Callers must take the type from here rather than re-searching the file for
 * `<name>:`. That search matches the first field of that name ANYWHERE, so a field
 * sharing a name with one in a different interface resolves to the wrong type --
 * observed: `workload?: Partial<WorkloadConfig>` was read as plain `WorkloadConfig`
 * from an unrelated declaration, which made a Partial look like it required all eight
 * of its fields.
 */
export function acceptedOptionFields(text: string): InterfaceField[] {
  return interfaceFieldsMatching(text, /Options$/).filter(
    (f) => !isUnsendable(f.type)
  );
}

/** A type that cannot cross a JSON boundary, so cannot be declared or sent. */
export function isUnsendable(type: string): boolean {
  return (
    type.includes('=>') || /\bFunction\b/.test(type) || /\bBuffer\b/.test(type)
  );
}

/** Fields of one named interface, or [] when it is not declared in this file. */
export function interfaceFields(text: string, name: string): InterfaceField[] {
  const match = new RegExp(`export interface\\s+${name}\\s*\\{`).exec(text);
  return match ? fieldsFrom(text, text.indexOf('{', match.index)) : [];
}

/**
 * Every `*Options` interface in the file, EXPORTED OR NOT.
 *
 * THE `export` KEYWORD WAS NEVER THE POINT, and requiring it put a hole in this
 * guard that nobody could see. 15 of the tools declare their options interface
 * without `export` -- smart_build, smart_test, smart_lint, smart_install,
 * smart_docker, smart_typecheck and the rest -- and the server hands the
 * caller's whole argument object to the implementation regardless. So every one
 * of those tools was exempt from the audit while appearing to pass it, which is
 * the worst state for a ratchet to be in: a new undeclared option added to any
 * of them was reported as clean. That is how a `deadlineMs` added to
 * smart_build during #335 slipped past silently.
 *
 * NESTED DATA SHAPES ARE NOT TOOL OPTIONS, and widening the search brings them
 * in. `TsConfigCompilerOptions` in smart-tsconfig describes the contents of a
 * tsconfig FILE -- `target`, `module`, `strict` -- and no caller ever sends
 * those as MCP arguments; the tool takes `compilerOptions` as a single field
 * and `nestedShape` is what checks inside it. The discriminator is structural
 * rather than a name list: a shape that appears as the TYPE OF A FIELD of some
 * other interface in the same file is nested by construction. A tool's own
 * options interface is passed to a method, never held as a field, so it is
 * never excluded by this -- and the "audits a meaningful number of tools" test
 * is what fails if that ever stops being true.
 */
function interfaceFieldsMatching(
  text: string,
  pattern: RegExp
): InterfaceField[] {
  const declarations = [...text.matchAll(/(?:export\s+)?interface\s+(\w+)\s*\{/g)];

  const usedAsFieldType = new Set<string>();
  for (const m of declarations) {
    for (const field of fieldsFrom(text, text.indexOf('{', m.index))) {
      for (const identifier of field.type.matchAll(/[A-Za-z_$][\w$]*/g)) {
        usedAsFieldType.add(identifier[0]);
      }
    }
  }

  const out: InterfaceField[] = [];
  for (const m of declarations) {
    if (!pattern.test(m[1])) continue;
    if (usedAsFieldType.has(m[1])) continue;
    out.push(...fieldsFrom(text, text.indexOf('{', m.index)));
  }

  const seen = new Set<string>();
  return out.filter((f) =>
    seen.has(f.name) ? false : (seen.add(f.name), true)
  );
}

/** Direct fields of the interface body whose `{` is at `open`. */
function fieldsFrom(text: string, open: number): InterfaceField[] {
  const fields: InterfaceField[] = [];
  let depth = 0;

  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === '{') {
      depth++;
      continue;
    }
    if (c === '}') {
      depth--;
      if (depth === 0) break;
      continue;
    }
    if (depth !== 1 || text[i - 1] !== '\n') continue;

    const line = /^\s*([A-Za-z_$][\w$]*)(\?)?\s*:\s*([^;\n]*)/.exec(
      text.slice(i)
    );
    if (line) {
      fields.push({
        name: line[1],
        optional: Boolean(line[2]),
        type: line[3].trim(),
      });
    }
  }
  return fields;
}

/**
 * The nested shape a schema property declares, or null when it declares none.
 *
 * Reaches through `items` for an array, because that is where an array's element shape
 * lives -- and where two incomplete declarations hid: `logSources` items omitted three
 * fields while the top-level name was present and correct, so a name-only check passed.
 */
export function nestedShape(
  text: string,
  property: string
): NestedShape | null {
  const slice = schemaPropertiesSlice(text);
  if (!slice) return null;

  const key = new RegExp(`(^|\\n)\\s{2,}${property}:\\s*\\{`).exec(slice);
  if (!key) return null;
  const open = slice.indexOf('{', key.index + key[0].length - 1);
  const close = matchingClose(slice, open);
  if (close === -1) return null;

  let block = slice.slice(open, close + 1);
  // The option's OWN type, not any type appearing inside it. A plain regex over
  // the whole block matched a nested array property -- `condition` is an object
  // whose fields include `groupBy` and `filters`, both arrays -- so the parser
  // treated the object as an array, reached into `groupBy.items` (`{ type:
  // 'string' }`, no `properties`), and reported the option as declaring no shape
  // whatsoever. Five correct schemas were condemned that way, which is how it was
  // noticed: a scanner that indicts working code is as useless as one that misses
  // broken code. Same depth-awareness the `required` lookup already needed.
  const isArray = valueAtTopLevel(block, 'type') === 'array';

  if (isArray) {
    const items = block.indexOf('items:');
    if (items === -1) return null;
    const itemsOpen = block.indexOf('{', items);
    const itemsClose = matchingClose(block, itemsOpen);
    if (itemsOpen === -1 || itemsClose === -1) return null;
    block = block.slice(itemsOpen, itemsClose + 1);
  }

  const props = block.indexOf('properties:');
  if (props === -1) return null;
  const propsOpen = block.indexOf('{', props);
  if (propsOpen === -1) return null;

  return {
    properties: topLevelKeys(block, propsOpen),
    required: requiredAtTopLevel(block),
    isArray,
  };
}

/**
 * Fields of an interface that the schema's declaration of `option` fails to
 * declare, or null when the schema does not mention `option` at all.
 *
 * THE NULL CASE IS A DELIBERATE HAND-OFF, not a gap. An option missing from the
 * schema entirely is the name-check's finding, reported there with the right
 * message; repeating it here would make one defect fail two tests and read as
 * two defects.
 *
 * A DECLARED BUT SHAPELESS OPTION IS THIS FUNCTION'S FINDING, and it used to be
 * nobody's. The audit skipped any property with no nested `properties` block on
 * the reasoning that the name-check covered it -- but that check only confirms
 * the NAME exists, so `request: { type: 'object' }` satisfied both while
 * declaring none of its fields and none of its requirements. Every sendable
 * field is reported missing, because none of them is declared.
 */
export function shapeGaps(
  text: string,
  option: string,
  fields: InterfaceField[]
): { missingProperties: string[]; missingRequired: string[] } | null {
  if (!(declaredProperties(text) ?? []).includes(option)) return null;

  const sendable = fields.filter((f) => !isUnsendable(f.type));
  const declared = nestedShape(text, option);

  const properties = declared ? declared.properties : [];
  const required = declared ? declared.required : [];

  return {
    missingProperties: sendable
      .filter((f) => !properties.includes(f.name))
      .map((f) => f.name),
    missingRequired: sendable
      .filter((f) => !f.optional && !required.includes(f.name))
      .map((f) => f.name),
  };
}

/**
 * The quoted value of a key belonging to THIS object, not to one nested in it.
 *
 * Depth-aware for the same reason `requiredAtTopLevel` is: keys like `type`
 * recur at every level of a JSON Schema, so the first textual match is almost
 * never the one being asked about.
 */
function valueAtTopLevel(block: string, key: string): string | null {
  let depth = 0;
  let inString: string | null = null;

  for (let i = 0; i < block.length; i++) {
    const c = block[i];

    if (inString) {
      if (c === '\\') i++;
      else if (c === inString) inString = null;
      continue;
    }
    if (c === '/' && block[i + 1] === '/') {
      const end = block.indexOf('\n', i);
      if (end === -1) break;
      i = end;
      continue;
    }
    // Block comments too. Skipping only `//` left a comment containing
    // `type: 'array'` or a `required:` list being read as declaration -- the
    // same class of defect as the apostrophe that once swallowed eleven
    // properties, and half-applying the lesson does not close it.
    if (c === '/' && block[i + 1] === '*') {
      const end = block.indexOf('*/', i + 2);
      if (end === -1) break;
      i = end + 1;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      inString = c;
      continue;
    }
    if (c === '{' || c === '[') {
      depth++;
      continue;
    }
    if (c === '}' || c === ']') {
      depth--;
      continue;
    }
    if (depth === 1 && block.startsWith(`${key}:`, i)) {
      const m = /^[A-Za-z_$][\w$]*:\s*'([^']*)'/.exec(block.slice(i));
      if (m) return m[1];
    }
  }
  return null;
}

/**
 * The `required: [...]` belonging to THIS object, not to one nested inside it.
 *
 * A plain search for the first `required:` reads the wrong list: alert_manager's
 * `dataSource` contains `cache: { ..., required: ['enabled','ttl'] }`, so a naive regex
 * reported dataSource as requiring `enabled` and `ttl` and its real requirements as
 * missing. That produced a confident, wrong finding about a property I had just fixed
 * correctly -- which is how it was noticed.
 */
function requiredAtTopLevel(block: string): string[] {
  let depth = 0;
  let inString: string | null = null;

  for (let i = 0; i < block.length; i++) {
    const c = block[i];

    if (inString) {
      if (c === '\\') i++;
      else if (c === inString) inString = null;
      continue;
    }
    if (c === '/' && block[i + 1] === '/') {
      const end = block.indexOf('\n', i);
      if (end === -1) break;
      i = end;
      continue;
    }
    // Block comments too. Skipping only `//` left a comment containing
    // `type: 'array'` or a `required:` list being read as declaration -- the
    // same class of defect as the apostrophe that once swallowed eleven
    // properties, and half-applying the lesson does not close it.
    if (c === '/' && block[i + 1] === '*') {
      const end = block.indexOf('*/', i + 2);
      if (end === -1) break;
      i = end + 1;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      inString = c;
      continue;
    }
    if (c === '{' || c === '[') {
      depth++;
      continue;
    }
    if (c === '}' || c === ']') {
      depth--;
      continue;
    }
    if (depth === 1 && c === 'r' && block.startsWith('required:', i)) {
      const open = block.indexOf('[', i);
      if (open === -1) return [];
      const close = matchingClose(block, open);
      if (close === -1) return [];
      return [...block.slice(open, close).matchAll(/'([^']+)'/g)].map(
        (m) => m[1]
      );
    }
  }
  return [];
}
