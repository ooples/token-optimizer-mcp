/** Experimental whitespace-only compaction of fenced tool-description code.
 * Never rewrites prose, schemas, grammars, quoted strings, or comments. Templates,
 * continuations and ambiguous slash syntax are deliberately left alone.
 */
const cache = new Map<string, string>();
let retained = 0;
const LIMIT = 512 * 1024;

export function compactToolCode(description: string): string {
  if (description.length > 64 * 1024 || !description.includes('```'))
    return description;
  const hit = cache.get(description);
  if (hit !== undefined) return hit;
  const result = description.replace(
    /^(```(?:ts|typescript|js|javascript|json)\r?\n)([\s\S]*?)(^```[ \t]*$)/gm,
    (whole: string, opening: string, code: string, closing: string) => {
      if (code.includes('`') || /\\\r?\n/.test(code)) return whole;
      const pieces = code.split(
        /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\/\/[^\r\n]*|\/\*[\s\S]*?\*\/)/
      );
      // A slash outside a protected comment/string might start a regex literal.
      if (pieces.some((part, i) => i % 2 === 0 && /[/'"]/.test(part)))
        return whole;
      for (let i = 0; i < pieces.length; i += 2)
        pieces[i] = pieces[i]
          .replace(/^[ \t]+/gm, '')
          .replace(/([\[({,;:])[ \t]+/g, '$1')
          .replace(/[ \t]+([\])},;:])/g, '$1');
      return opening + pieces.join('') + closing;
    }
  );
  const bytes = 2 * (description.length + result.length);
  while (cache.size >= 64 || retained + bytes > LIMIT) {
    const key = cache.keys().next().value;
    if (key === undefined) break;
    retained -= 2 * (key.length + cache.get(key)!.length);
    cache.delete(key);
  }
  cache.set(description, result);
  retained += bytes;
  return result;
}

/** Copy only changed tool branches; never walk JSON Schema or grammar values. */
export function compactToolDefinitions(value: unknown, depth = 0): unknown {
  if (depth > 8) return value;
  if (Array.isArray(value)) {
    const next = value.map((tool) => compactToolDefinitions(tool, depth + 1));
    return next.some((tool, i) => tool !== value[i]) ? next : value;
  }
  if (!value || typeof value !== 'object') return value;
  const tool = value as Record<string, unknown>;
  if (!['namespace', 'function', 'custom'].includes(String(tool.type)))
    return value;
  let next = tool;
  if (typeof tool.description === 'string') {
    const description = compactToolCode(tool.description);
    if (description !== tool.description) next = { ...next, description };
  }
  if (tool.type === 'namespace' && Array.isArray(tool.tools)) {
    const tools = compactToolDefinitions(tool.tools, depth + 1);
    if (tools !== tool.tools) next = { ...next, tools };
  }
  return next;
}
