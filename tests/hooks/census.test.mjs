/**
 * Nothing declared is unconnected.
 *
 * `reachability.test.mjs` asks whether an exported NAME is called. That model
 * cannot see three whole sub-classes of the same defect, and all three have
 * shipped here:
 *
 *   1. A READER WITH NO PRODUCER. `indexBudget` divided `query` events by
 *      `index` events, and nothing outside the test suite ever wrote a `query`
 *      event -- so the ratio was zero on every project and the budget sat
 *      pinned at its 150-token floor for the life of the feature. Every
 *      function involved was reachable. Every test passed.
 *   2. A PRODUCER WITH NO READER. `kind: 'lessons'` was written by
 *      harvest-worker.mjs and read by nothing.
 *   3. A REFERENT WITH NO TARGET. Injected prompt text told the model to call
 *      `wiki_query` -- in twelve shipped copies -- and no such tool existed.
 *
 * None of those is a dead function. In each case the code is correct, the names
 * are all reachable, and the capability does nothing, because the two halves
 * were never introduced. This file counts producers against consumers.
 *
 * ON THE OVERLOADED `kind` FIELD. It is used in at least five unrelated
 * namespaces here -- event kinds, node kinds (file/symbol/task/finding), symbol
 * kinds (function/class/variable), standing-entry kinds (skill/agent), remedy
 * kinds (ours/yours) -- plus a private one inside run-handoff-eval.mjs. A
 * census that conflates them reports confident nonsense, and the first draft of
 * this one did: it called `file`, `finding`, `symbol`, `task`, `skill`, `agent`,
 * `ours` and `yours` orphaned readers. So an event kind is defined here by
 * PROVENANCE rather than by spelling -- it is a kind that is declared in
 * metrics.mjs's own exported sets, or written at a `record()` / `recordRead()`
 * call site. Every other namespace falls outside that definition automatically,
 * with no hand-maintained exclusion list to go stale.
 */

import { describe, it, expect } from '@jest/globals';
import { readFileSync } from 'fs';
import { join, relative } from 'path';
import {
  USAGE_DIRS,
  DECLARE_DIRS,
  walk,
  stripComments,
  callWindows,
  objectLiteralKeys,
} from '../fixtures/source-scan.mjs';

const REPO = process.cwd();

/** Everything that ships, comments removed, path relative for readable failures. */
const shipped = USAGE_DIRS.flatMap((d) => walk(join(REPO, d))).map((file) => ({
  file: relative(REPO, file),
  code: stripComments(readFileSync(file, 'utf8')),
}));

const sourceOf = (pattern) => shipped.find(({ file }) => pattern.test(file));

/** Kind names: lower-case, and hyphens are real -- `tool-outcome`, `eval-run`. */
const KIND = "[a-z][a-z0-9_-]*";

const add = (map, key, file) => {
  if (!map.has(key)) map.set(key, new Set());
  map.get(key).add(file);
  return map;
};

const withoutReader = (produced, read) =>
  [...produced.keys()].filter((k) => !read.has(k)).sort();

/* ------------------------------------------------------------- EVENT KINDS */

/**
 * The kinds metrics.mjs itself declares, in its two exported sets.
 *
 * DECLARED IS STRONGER EVIDENCE THAN WRITTEN. `BALANCE_KINDS` and
 * `EVIDENCE_KINDS` route a kind to its own log so the firehose cannot evict it,
 * which is a deliberate statement that the kind matters -- so a declared kind
 * with no writer, or no reader, is a stronger finding than an incidental one.
 */
function declaredEventKinds() {
  const metrics = sourceOf(/hooks-core[\\/]metrics\.mjs$/);
  const out = new Map();
  for (const set of ['BALANCE_KINDS', 'EVIDENCE_KINDS']) {
    const block = new RegExp(
      `export const ${set} = new Set\\(\\[([\\s\\S]*?)\\]\\)`
    ).exec(metrics.code);
    // A broken pattern here would report every kind as undeclared and the whole
    // census would go quiet, so failing loudly is the point.
    if (!block) throw new Error(`could not read ${set} from metrics.mjs`);
    for (const m of block[1].matchAll(new RegExp(`'(${KIND})'`, 'g'))) {
      out.set(m[1], set);
    }
  }
  return out;
}

/** Kinds written at a `record()` / `recordRead()` call site anywhere that ships. */
function writtenEventKinds() {
  const out = new Map();
  for (const { file, code } of shipped) {
    for (const window of callWindows(code, 'record(?:Read)?')) {
      for (const m of window.matchAll(new RegExp(`\\bkind:\\s*'(${KIND})'`, 'g'))) {
        add(out, m[1], file);
      }
    }
  }
  return out;
}

/**
 * Kinds something actually branches on, anywhere that ships.
 *
 * DELIBERATELY GENEROUS. This side feeds the "written but never read"
 * assertion, where under-reporting a reader is the STRICT direction -- it would
 * fail CI on a live capability. So a comparison, a membership test and a bare
 * quoted mention inside a filter all count, and `episode-outcome` is why the
 * membership form is here: it is read as
 * `['tool-outcome', 'episode-outcome'].includes(String(value(event, 'kind')))`,
 * which no comparison pattern matches.
 */
function readEventKinds(vocabulary) {
  const out = new Map();
  const comparisons = [
    new RegExp(`\\bkind\\s*[=!]==\\s*'(${KIND})'`, 'g'),
    new RegExp(`'(${KIND})'\\s*[=!]==\\s*[\\w$.()[\\]'"]*\\bkind\\b`, 'g'),
  ];
  for (const { file, code } of shipped) {
    for (const re of comparisons) {
      for (const m of code.matchAll(re)) add(out, m[1], file);
    }
    // An array literal tested against something with `kind` in it.
    for (const m of code.matchAll(/\[([^\]]{0,300}?)\]\s*\.includes\(([^)]{0,120}kind[^)]{0,120})\)/gi)) {
      for (const k of m[1].matchAll(new RegExp(`'(${KIND})'`, 'g'))) add(out, k[1], file);
    }
    // A Set built from a literal and tested with .has(...kind...).
    for (const m of code.matchAll(/new Set\(\[([^\]]{0,300}?)\]\)\s*\.has\(([^)]{0,120}kind[^)]{0,120})\)/gi)) {
      for (const k of m[1].matchAll(new RegExp(`'(${KIND})'`, 'g'))) add(out, k[1], file);
    }
  }
  // Restricted to the event vocabulary, so the four other `kind` namespaces --
  // and run-handoff-eval.mjs's private one -- never enter this census.
  for (const key of [...out.keys()]) if (!vocabulary.has(key)) out.delete(key);
  return out;
}

/* -------------------------------------------------------------- EDGE KINDS */

/** Declared in `EDGE_KINDS`, against every putEdge / `edge:` write site. */
function edgeKinds() {
  const wiki = sourceOf(/hooks-core[\\/]wiki\.mjs$/);
  const block = /export const EDGE_KINDS = \[([\s\S]*?)\]/.exec(wiki.code);
  if (!block) throw new Error('could not read EDGE_KINDS from wiki.mjs');
  const declared = new Set([...block[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]));

  const written = new Map();
  for (const { file, code } of shipped) {
    // A WINDOW, because `putEdge(dir, nodeId('symbol', ...), 'calls', ...)`
    // spans six lines in staleness.mjs and the kind is the THIRD argument. The
    // plan this came from proposed a single-line regex on the second argument,
    // which reported the graph's own call-edge kind as having no writer.
    for (const window of callWindows(code, 'putEdge')) {
      for (const m of window.matchAll(/'([a-z_]+)'/g)) {
        if (declared.has(m[1])) add(written, m[1], file);
      }
    }
    for (const m of code.matchAll(/\bedge:\s*'([a-z_]+)'/g)) {
      if (declared.has(m[1])) add(written, m[1], file);
    }
  }
  return { declared, written };
}

/* ------------------------------------------------------------ RECORD FIELDS */

/**
 * Fields written onto a graph or metrics record, against fields anything reads.
 *
 * THE SUB-CLASS BELOW THE OTHERS. The reachability guard checks exported names
 * and this file's other censuses check declared kinds -- but a FIELD is neither.
 * `contradictionReason`, up to 400 characters of human explanation of why one
 * finding disputes another, was written on every single `contradict` call and
 * read by nothing at all, with every guard in this directory green throughout.
 * Nothing in the repository could have noticed: the writer is correct, the
 * reader was never written, and no name is unreachable.
 *
 * WHAT COUNTS AS READ IS DELIBERATELY GENEROUS: any mention of the name that is
 * not itself an object key. Not `record.field`, not a destructure, not a
 * specific access pattern -- ANY other mention. Records are spread (`...rest`,
 * `...episode`) and read dynamically, so a precise reader-side pattern would
 * accuse live fields. This fires only when a name appears nowhere in the
 * repository except as a key being written, which is a strong enough signal to
 * block a build on.
 */
const FIELD_WRITERS = ['record(?:Read)?', 'putNode', 'putNodeWithEdges'];
const FIELD_WRITE_PATH = /^(hooks-core|plugin.hooks|src.server)/;

function recordFields() {
  const written = new Map();
  for (const { file, code } of shipped) {
    if (!FIELD_WRITE_PATH.test(file)) continue;
    for (const writer of FIELD_WRITERS) {
      for (const keys of objectLiteralKeys(code, writer)) {
        for (const key of keys) add(written, key, file);
      }
    }
  }

  const unread = [];
  for (const [name, writers] of written) {
    // Three characters or fewer is not a distinctive enough word to reason
    // about by text match -- `id`, `at`, `to`, `key` collide with everything.
    if (name.length < 4) continue;
    const readSomewhere = shipped.some(({ code }) => {
      const total = (code.match(new RegExp(`\\b${name}\\b`, 'g')) || []).length;
      const asKey = (code.match(new RegExp(`\\b${name}\\s*:`, 'g')) || []).length;
      return total - asKey > 0;
    });
    if (!readSomewhere) unread.push({ name, writers: [...writers].sort() });
  }
  return { written, unread: unread.sort((a, b) => a.name.localeCompare(b.name)) };
}

/* ------------------------------------------- TOOL NAMES IN INJECTED PROMPTS */

/**
 * Tool names the hooks put in front of the model, against the served registry.
 *
 * SCANS RAW TEXT, comments included, and that is deliberate: injected text
 * lives in template literals, and a tool name in a comment that does not exist
 * is still worth knowing about. Over-reporting is the safe direction for a
 * check whose failure mode is "we told the model to call something imaginary".
 */
function toolNamesInInjectedText() {
  const registry = new Set();
  for (const file of USAGE_DIRS.flatMap((d) => walk(join(REPO, d)))) {
    if (!/tool-schemas\.ts$/.test(file)) continue;
    for (const m of readFileSync(file, 'utf8').matchAll(/^\s{2}([a-z_]+):\s*\w+Schema,/gm)) {
      registry.add(m[1]);
    }
  }

  const mentioned = new Map();
  for (const file of DECLARE_DIRS.flatMap((d) => walk(join(REPO, d)))) {
    if (!/inject\.mjs$|policy\.mjs$|adapter\.mjs$|disclose\.mjs$/.test(file)) continue;
    const raw = readFileSync(file, 'utf8');
    for (const m of raw.matchAll(
      /\b(smart_[a-z_]+|wiki_[a-z_]+|optimize_session|get_optimization_report)\b/g
    )) {
      add(mentioned, m[1], relative(REPO, file));
    }
  }

  return {
    registry,
    mentioned,
    missing: [...mentioned.keys()].filter((t) => !registry.has(t)).sort(),
  };
}

/* --------------------------------------------------------------- THE TESTS */

describe('the census can see anything at all', () => {
  // A census that matches nothing reports a clean bill of health forever, which
  // is the failure mode of every guard in this directory.
  it('finds the declarations it reasons about', () => {
    expect(declaredEventKinds().size).toBeGreaterThan(10);
    expect(edgeKinds().declared.size).toBeGreaterThan(5);
    expect(toolNamesInInjectedText().registry.size).toBeGreaterThan(20);
  });

  it('finds producers and consumers, not just declarations', () => {
    expect(writtenEventKinds().size).toBeGreaterThan(10);
    expect(readEventKinds(new Set(writtenEventKinds().keys())).size).toBeGreaterThan(5);
    expect(edgeKinds().written.size).toBeGreaterThan(5);
    expect(toolNamesInInjectedText().mentioned.size).toBeGreaterThan(3);
  });
});

describe('event kinds', () => {
  const declared = declaredEventKinds();
  const written = writtenEventKinds();
  const vocabulary = new Set([...declared.keys(), ...written.keys()]);
  const read = readEventKinds(vocabulary);

  it('has a writer for every kind metrics.mjs declares', () => {
    const noWriter = [...declared.keys()].filter((k) => !written.has(k)).sort();
    // A kind routed to its own durable log, that nothing ever writes, is a
    // reserved seat for a passenger who never boards.
    expect(noWriter).toEqual([]);
  });

  it('has no kind that is read but never written', () => {
    // THE indexBudget SHAPE. `query` was read by the budget and written only by
    // the test suite, so the ratio was zero for every project and the budget
    // never left its floor -- with every function reachable and every test
    // green.
    expect(withoutReader(read, written)).toEqual([]);
  });

  it('has no kind that is written but never read', () => {
    // WHAT THIS FOUND, on its first run, and what it is still owed.
    //
    // `mcp-client` is written by src/server/mcp-evidence.ts on every client
    // handshake and read by nothing. Its only field that is not already on
    // every other record from the same writer is `clientTitle` -- the client
    // name, version, arm and episode are all carried by `mcp-tool` too, and the
    // client is separately recorded in the project registry, which is where the
    // dashboard reads it from. So the resolution is a deletion or a reader in
    // the MCP telemetry surface, and it is not this guard's call to make
    // silently. Tracked, attributed, and held to a ceiling that can only fall.
    //
    // NOT A BACKLOG, and the distinction is the whole point of Plan 3. Round 1
    // parked sixteen findings in a list with accurate descriptions and no
    // owner, and an accurate description of a defect felt like resolution. This
    // is one entry, it names what it is waiting for, and the assertion below
    // refuses a second.
    const KNOWN_ORPHAN_WRITERS = ['mcp-client'];

    const orphans = withoutReader(written, read);
    expect(orphans).toEqual(KNOWN_ORPHAN_WRITERS);
  });

  it('holds the orphan-writer list to one entry, and refuses a second', () => {
    const written2 = writtenEventKinds();
    const read2 = readEventKinds(new Set([...declared.keys(), ...written2.keys()]));
    expect(withoutReader(written2, read2).length).toBeLessThanOrEqual(1);
  });
});

describe('edge kinds', () => {
  it('has a write site for every declared edge kind', () => {
    const { declared, written } = edgeKinds();
    // `contradicts` and `answers` sat in EDGE_KINDS with zero write sites: the
    // graph declared it could record a disputed belief and an answered
    // question, and could do neither. Both are written now.
    expect([...declared].filter((k) => !written.has(k)).sort()).toEqual([]);
  });

  it('declares every edge kind it writes', () => {
    // The other direction is enforced at runtime -- putEdge throws on an
    // unknown kind -- so this asserts the guard rail rather than the outcome,
    // and would catch a raw append that bypassed putEdge.
    const { declared, written } = edgeKinds();
    expect([...written.keys()].filter((k) => !declared.has(k)).sort()).toEqual([]);
  });
});

describe('record fields', () => {
  /**
   * WHAT THIS FOUND ON ITS FIRST RUN, with what each one is.
   *
   * Attributed, not triaged. Round 1's failure was a list of sixteen accurate
   * descriptions with no owner, where writing the description down felt like
   * fixing the thing. Each of these names what is stored, why it was stored,
   * and where its reader would have to go -- and the ceiling below means the
   * list can only shrink.
   *
   * Four of the six are measurement fields belonging to the holdout arm and the
   * injection budget, which is Plan 2's subject (production and measurement),
   * so wiring readers for them here would be reaching into work in flight.
   * `contradictedAt` is already filed as a follow-up on #204.
   */
  const KNOWN_UNREAD_FIELDS = [
    // The holdout arm's shadow payload: what WOULD have been injected. The
    // whole point of a holdout is comparing the shadow against the delivered
    // arm, and the comparison has never been run. Plan 2's measurement work.
    'candidateCount',
    // Which client connected, beyond what the project registry already stores.
    // Written on every MCP handshake, read by nothing -- the same record as
    // the `mcp-client` orphan writer above, and it resolves with that one.
    'clientTitle',
    // WHEN a finding was contradicted. Stored provenance with no reader;
    // already filed as follow-up 3 on #204.
    'contradictedAt',
    // The last curation action applied to a node.
    'lastAction',
    // See candidateCount: the shadow arm's finding keys.
    'shadowFindingIds',
    // How many of the findings considered at a touch were stale.
    'staleCount',
  ];

  it('has a reader for every field written onto a record', () => {
    expect(recordFields().unread.map((f) => f.name)).toEqual(KNOWN_UNREAD_FIELDS);
  });

  it('holds the unread-field list to a ceiling that can only fall', () => {
    expect(recordFields().unread.length).toBeLessThanOrEqual(KNOWN_UNREAD_FIELDS.length);
  });

  it('sees enough fields that a broken extractor cannot report a clean bill of health', () => {
    // The extractor SKIPS any call site whose object literal does not balance,
    // so a regression in it goes quiet rather than loud. This is the tripwire.
    expect(recordFields().written.size).toBeGreaterThan(50);
  });
});

describe('tool names in injected text', () => {
  it('names no tool that does not exist', () => {
    // The SessionStart index told the model to call `wiki_query` in twelve
    // shipped copies of the injected prompt, for as long as the feature
    // existed, and there was no such tool. Nothing in the codebase could
    // notice: the string is data, the tool list is data, and no test compared
    // them.
    expect(toolNamesInInjectedText().missing).toEqual([]);
  });
});
