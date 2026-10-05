import { describe, it, expect } from '@jest/globals';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

import { TOOL_DEFINITIONS } from '../../src/server/tool-definitions.js';

/**
 * A published `operation` value must be one the implementation dispatches on.
 *
 * WHY: the derived validation makes the published schema the one description of
 * a tool's arguments, so a caller is entitled to read it and call what it says.
 * That only holds if the values it publishes are real. Measured when this check
 * was written, data_visualizer published eleven operations and dispatched
 * eight: three were near-misses of a real name (`export` for `export-chart`,
 * `create-network` for `create-network-graph`, `create-animation` for
 * `animate`) and three (`delete-chart`, `list-charts`, `render`) had no
 * implementation at all. All six reached the switch default and threw
 * `Unknown operation`, so the schema advertised calls the tool refuses -- and
 * validation could not catch it, because validation is derived FROM that
 * schema.
 *
 * HOW: the check reads the implementation text rather than calling anything,
 * because dispatch is written four ways across this surface -- a `case` label,
 * an `===`/`!==` comparison against a literal, a comparison against a
 * TypeScript enum member, and a handler-map key. A detector that reads only
 * `case` labels reports a defect for every tool using one of the other three,
 * which is why POSITIVE_CONTROL below pins one tool per form: a detector that
 * stops recognising a form fails here instead of quietly reporting zero.
 */

const SRC_ROOT = join(process.cwd(), 'src');

const tsFilesUnder = (dir: string): string[] => {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      found.push(...tsFilesUnder(full));
      continue;
    }
    if (entry.endsWith('.ts')) found.push(full);
  }
  return found;
};

const SOURCES: Map<string, string> = new Map(
  tsFilesUnder(SRC_ROOT).map((file) => [file, readFileSync(file, 'utf8')])
);

/**
 * The four dispatch forms, as they appear in this codebase. Each is a FORM,
 * not a tool: a tool is credited when any form names the value.
 */
const DISPATCH_FORM = Object.freeze({
  caseLabel: 'caseLabel',
  literalCompare: 'literalCompare',
  enumMember: 'enumMember',
  handlerKey: 'handlerKey',
} as const);

type DispatchForm = (typeof DISPATCH_FORM)[keyof typeof DISPATCH_FORM];

/**
 * These patterns run over our own source files, never over caller input, so
 * the bounded-regex rule that applies to request handling does not buy
 * anything here. They are still kept anchored and non-nested.
 */
const PATTERN_SUBJECT = 'our own source text';

/** `enum Name { Member = 'value' }` -- resolves `Name.Member` to `value`. */
const enumMembersIn = (text: string): Map<string, string> => {
  const resolved = new Map<string, string>();
  for (const block of text.matchAll(/enum\s+(\w+)\s*\{([^}]*)\}/g)) {
    const name = block[1];
    for (const entry of block[2].matchAll(/(\w+)\s*=\s*['"]([^'"]+)['"]/g))
      resolved.set(`${name}.${entry[1]}`, entry[2]);
  }
  return resolved;
};

/** Every operation value the given source text can be seen to dispatch on. */
const dispatchedIn = (text: string): Map<string, DispatchForm> => {
  const seen = new Map<string, DispatchForm>();
  const note = (value: string, form: DispatchForm): void => {
    if (!seen.has(value)) seen.set(value, form);
  };

  for (const hit of text.matchAll(/case\s+['"]([^'"]+)['"]\s*:/g))
    note(hit[1], DISPATCH_FORM.caseLabel);

  for (const hit of text.matchAll(/[!=]==\s*['"]([^'"]+)['"]/g))
    note(hit[1], DISPATCH_FORM.literalCompare);

  const members = enumMembersIn(text);
  for (const hit of text.matchAll(/[!=]==\s*(\w+\.\w+)/g)) {
    const value = members.get(hit[1]);
    if (value !== undefined) note(value, DISPATCH_FORM.enumMember);
  }

  for (const hit of text.matchAll(/^\s*['"]?([\w-]+)['"]?\s*:/gm))
    note(hit[1], DISPATCH_FORM.handlerKey);

  return seen;
};

/**
 * A stub body. No tool in the tree has one any more; the detector stays
 * because a new tool written from an old one as a template would bring it
 * back, and a fabricating tool publishes a clean-looking surface.
 *
 * Six tools once returned `{ success: true, confidence: 0.85 }` and a
 * `result` string built from the operation name, for every operation they
 * published -- none was implemented, which is why no dispatch form could be
 * found for any of them. Detecting that positively kept them out of the
 * dispatch assertion without an exemption list, and it still does: a tool that
 * grows a stub body is caught by FABRICATING below.
 */
const FABRICATION_MARK = 'completed successfully`';

const publishedOperations = (definition: {
  inputSchema?: unknown;
}): string[] => {
  const schema = definition.inputSchema as
    | { properties?: Record<string, { enum?: unknown[] }> }
    | undefined;
  const published = schema?.properties?.operation?.enum;
  if (!Array.isArray(published)) return [];
  return published.filter(
    (value): value is string => typeof value === 'string'
  );
};

const ownersOf = (toolName: string): string[] => {
  const marker = `name: '${toolName}'`;
  return [...SOURCES.entries()]
    .filter(([, text]) => text.includes(marker))
    .map(([file]) => file);
};

interface ToolUnderCheck {
  name: string;
  published: string[];
  owners: string[];
  text: string;
  fabricates: boolean;
}

const TOOLS: ToolUnderCheck[] = TOOL_DEFINITIONS.flatMap((definition) => {
  const name = (definition as { name?: unknown }).name;
  if (typeof name !== 'string') return [];
  const published = publishedOperations(definition);
  if (published.length === 0) return [];
  const owners = ownersOf(name);
  const text = owners.map((file) => SOURCES.get(file) ?? '').join('\n');
  return [
    {
      name,
      published,
      owners,
      text,
      fabricates: text.includes(FABRICATION_MARK),
    },
  ];
});

/**
 * One tool per dispatch form, so the detector cannot silently stop reading a
 * form and report a clean surface. Picked from the measurement, not invented:
 * wiki_query is the only tool that compares against a TypeScript enum member,
 * and if its six values stop resolving, this check reports zero defects for a
 * reason that has nothing to do with the code being right.
 */
const POSITIVE_CONTROL: ReadonlyArray<readonly [string, DispatchForm]> =
  Object.freeze([
    ['data_visualizer', DISPATCH_FORM.caseLabel],
    ['wiki_query', DISPATCH_FORM.enumMember],
    ['cognition_record', DISPATCH_FORM.literalCompare],
  ] as const);

/**
 * The tools whose published operations are all fabricated. This is a RECORD of
 * a measurement, not permission: it is asserted exactly, so the set shrinking
 * fails here and the record has to be brought along with the fix.
 *
 * It is now EMPTY. Six tools were listed here -- smart-summarization,
 * pattern-recognition, predictive-analytics, recommendation-engine,
 * natural-language-query and intelligent-assistant, 48 published operations
 * between them -- each serving every operation from one body that read none of
 * its arguments and reported `confidence: 0.85`. All 48 are implemented, so
 * the only thing this list may do now is grow, and growing fails this file.
 */
const FABRICATING: readonly string[] = Object.freeze([]);

describe('published operations are dispatched', () => {
  it('found the tools that publish an operation enum', () => {
    expect(PATTERN_SUBJECT).toBe('our own source text');
    expect(TOOLS.length).toBeGreaterThan(30);
  });

  it('located an implementation for every one of them', () => {
    const unlocated = TOOLS.filter((tool) => tool.owners.length === 0).map(
      (tool) => tool.name
    );
    expect(unlocated).toEqual([]);
  });

  it.each(POSITIVE_CONTROL)(
    'still reads the %s dispatch form',
    (toolName, form) => {
      const tool = TOOLS.find((candidate) => candidate.name === toolName);
      expect(tool).toBeDefined();
      if (!tool) return;
      const found = dispatchedIn(tool.text);
      const byThisForm = tool.published.filter(
        (value) => found.get(value) === form
      );
      expect(byThisForm.length).toBeGreaterThan(0);
    }
  );

  it('dispatches every operation it publishes', () => {
    const undispatched: Record<string, string[]> = {};
    for (const tool of TOOLS) {
      if (tool.fabricates) continue;
      const found = dispatchedIn(tool.text);
      const missing = tool.published.filter((value) => !found.has(value));
      if (missing.length > 0) undispatched[tool.name] = missing;
    }
    expect(undispatched).toEqual({});
  });

  it('has exactly the fabricating tools it has recorded', () => {
    const measured = TOOLS.filter((tool) => tool.fabricates)
      .map((tool) => tool.name)
      .sort();
    expect(measured).toEqual([...FABRICATING].sort());
  });
});
