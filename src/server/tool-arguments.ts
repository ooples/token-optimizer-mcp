/**
 * Checks a tool call's arguments against the schema that tool publishes.
 *
 * Both checks read the SAME tool definitions the server hands to callers, so
 * neither can drift from what a caller sees in `tools/list`. They live here
 * rather than in server/index.ts because that module starts a server the
 * moment it is imported, which makes its internals untestable.
 */

/** The shape this module needs from a tool definition; anything else is ignored. */
export interface ToolDefinitionLike {
  name: string;
  inputSchema?: {
    required?: string[];
    properties?: Record<string, unknown>;
  };
}

export interface ToolArgumentChecker {
  /** Throws when a field the tool advertises as required is absent. */
  assertRequiredFields(name: string, args: unknown): void;
  /** Throws when a field the tool does not advertise is present. */
  assertKnownFields(name: string, args: unknown): void;
}

/**
 * The advertised field closest to `candidate`, or null when nothing is close.
 *
 * A containing name wins outright -- `filePattern` against `pattern` is a
 * likelier slip than anything edit distance would rank first.
 */
export function nearestKnownField(
  candidate: string,
  known: ReadonlySet<string>
): string | null {
  const lower = candidate.toLowerCase();
  const fields = [...known];
  if (!fields.length) return null;

  const contained = fields
    .filter(
      (f) => lower.includes(f.toLowerCase()) || f.toLowerCase().includes(lower)
    )
    .sort((a, b) => b.length - a.length)[0];
  if (contained) return contained;

  let best: string | null = null;
  let bestDistance = Infinity;
  for (const field of fields) {
    const a = lower;
    const b = field.toLowerCase();
    // Iterative two-row Levenshtein. The operands are parameter names, so the
    // quadratic cost is bounded by a couple of dozen characters.
    let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      const current = [i];
      for (let j = 1; j <= b.length; j++) {
        current[j] = Math.min(
          previous[j] + 1,
          current[j - 1] + 1,
          previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
        );
      }
      previous = current;
    }
    if (previous[b.length] < bestDistance) {
      bestDistance = previous[b.length];
      best = field;
    }
  }

  // Past a third of the name being wrong it is a different word, not a typo,
  // and a confident wrong guess reads worse than no guess at all.
  return best !== null && bestDistance <= Math.ceil(candidate.length / 3)
    ? best
    : null;
}

/**
 * Builds the two checks from the definitions the server publishes.
 */
export function createToolArgumentChecker(
  tools: readonly ToolDefinitionLike[]
): ToolArgumentChecker {
  const required = new Map<string, string[]>(
    tools.map((t) => [t.name, t.inputSchema?.required ?? []])
  );
  const known = new Map<string, Set<string>>(
    tools.map((t) => [
      t.name,
      new Set(Object.keys(t.inputSchema?.properties ?? {})),
    ])
  );

  return {
    /**
     * Names the missing fields, so the answer is actionable -- which is the
     * whole difference from the internal TypeError this replaces.
     */
    assertRequiredFields(name, args) {
      const fields = required.get(name);
      if (!fields?.length) return;

      const provided = (args ?? {}) as Record<string, unknown>;
      const missing = fields.filter(
        (f) => provided[f] === undefined || provided[f] === null
      );
      if (!missing.length) return;

      // List the full set only when that adds something -- repeating an
      // identical list twice reads like a template, not an answer.
      const full =
        missing.length === fields.length
          ? ''
          : ` (required: ${fields.join(', ')})`;
      throw new Error(`${name} requires ${missing.join(', ')}${full}.`);
    },

    /**
     * Zod strips unknown keys and most schemas here are `.passthrough()`, so a
     * mistyped argument used to vanish silently. That is the worst outcome for
     * a FILTER: `smart_grep` given `filePattern` searched every file and
     * returned a confident, unfiltered answer. Failing loudly turns a wrong
     * result into a fixable message.
     */
    assertKnownFields(name, args) {
      const fields = known.get(name);
      // Tools that publish no properties take an open options bag -- there is
      // no declared vocabulary to check against.
      if (!fields?.size) return;

      const provided = Object.keys((args ?? {}) as Record<string, unknown>);
      if (!provided.length) return;

      // ONLY NEAR MISSES ARE REFUSED, and that limit is measured rather than
      // timid. Rejecting every undeclared field looked right until the published
      // schemas were audited against what the implementations actually read: 22
      // tools accept options they do not advertise. smart_grep itself reads
      // wholeWord, skipBinary and ignore; smart_edit reads contextLines and
      // batchEdits. A blanket rule would have broken working calls across a
      // fifth of the surface in order to catch typos on the rest.
      //
      // A near miss is recoverable information: `filePattern` is one
      // letter-group from `pattern`, and that is what silently searched 17 files
      // instead of the 1 requested. An unrelated name is far likelier to be a
      // real option this schema has never documented, and refusing it would mean
      // enforcing a contract the implementation does not actually have.
      //
      // Those undocumented options are a genuine gap and should be declared, but
      // that is a schema-completeness change, not a licence to fail callers in
      // the meantime.
      const typos = provided
        .filter((field) => !fields.has(field))
        .map((field) => ({ field, near: nearestKnownField(field, fields) }))
        .filter((candidate) => candidate.near !== null);
      if (!typos.length) return;

      const described = typos.map((t) => `${t.field} (did you mean ${t.near}?)`);
      throw new Error(
        `${name} does not accept ${described.join(', ')}. ` +
          `Accepted: ${[...fields].sort().join(', ')}.`
      );
    },
  };
}
