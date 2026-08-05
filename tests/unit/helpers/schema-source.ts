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

function interfaceFieldsMatching(
  text: string,
  pattern: RegExp
): InterfaceField[] {
  const out: InterfaceField[] = [];
  for (const m of text.matchAll(/export interface\s+(\w+)\s*\{/g)) {
    if (!pattern.test(m[1])) continue;
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
  const isArray = /type:\s*'array'/.test(block);

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
