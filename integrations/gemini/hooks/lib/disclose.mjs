// GENERATED FILE -- do not edit.
// Source of truth: hooks-core/disclose.mjs. Regenerate with `npm run sync:hooks`.
/**
 * Progressive disclosure: what a large tool output turns into.
 *
 * Competing tools replace anything over a size threshold with a head/tail slice
 * and a pointer. That is a POSITIONAL heuristic -- it keeps the first 40 lines
 * because they are first, not because they matter -- and it is the same slice
 * whatever the session happens to be trying to find out.
 *
 * Three layers here, applied in order, each strictly stronger than the one
 * beneath it:
 *
 *   1. VERDICT      If the graph already holds the conclusion this output would
 *                   support, return the conclusion. The output never enters
 *                   context at all -- not compressed, not previewed, absent.
 *   2. STRUCTURE    Parse the output's SHAPE (test report, diff, log, JSON,
 *                   stack trace) so the unit of selection is a section that
 *                   means something, rather than a line that happens to be at
 *                   an offset.
 *   3. RELEVANCE    Rank those sections against what this session is actually
 *                   doing -- its open question, the files it has been touching
 *                   -- and spend the budget on the ones that bear on it.
 *
 * Structure alone is predictable but blind to intent; relevance alone has
 * nothing coherent to select. Together the omissions become describable, which
 * is the part that makes this safe: every cut is LABELLED with what it was and
 * how to get it, so the model knows what it is not being shown instead of
 * silently reasoning over a truncation it cannot see.
 */

import { substitutionBudget } from './metrics.mjs';
import { findingsFor, nodeId } from './wiki.mjs';
import { serve } from './staleness.mjs';
import { canonicalPath } from './paths.mjs';

const estimate = (text) => Math.ceil(String(text || '').length / 4);

/** Below this, an output is small enough that disclosure costs more than it saves. */
export const DISCLOSE_THRESHOLD = 4096;

/**
 * Output shapes worth parsing, most specific first.
 *
 * `split` divides the text into labelled sections; `weight` is the intrinsic
 * importance of a section before relevance is considered, because some sections
 * matter regardless of the question -- a failure is interesting even when
 * nobody asked about it.
 */
const SHAPES = [
  {
    // FIRST, because it is the only DEFINITIVE test in the list: either the
    // bytes parse as JSON or they do not. The others are heuristics, and a
    // heuristic beating a definitive test is how a JSON envelope containing the
    // word "FAILED" gets mistaken for a test report -- then split by line, of
    // which it has one. Everything this product returns is such an envelope.
    name: 'json',
    detect: (t) => {
      const trimmed = t.trim();
      if (!(trimmed.startsWith('{') || trimmed.startsWith('['))) return false;
      try {
        JSON.parse(trimmed);
        return true;
      } catch {
        return false;
      }
    },
    split: splitJson,
  },
  {
    name: 'test-report',
    detect: (t) => /\b(FAILED|FAIL|Failed!|Assert\.|Test Suites:|\d+ (?:passed|failed))\b/.test(t),
    split: splitTestReport,
  },
  {
    name: 'diff',
    detect: (t) => /^diff --git |^@@ -\d+/m.test(t),
    split: splitDiff,
  },
  {
    name: 'stack-trace',
    detect: (t) => /^\s+at .+\(.+:\d+:\d+\)|^\s+File ".+", line \d+/m.test(t),
    split: splitStack,
  },
  {
    name: 'log',
    detect: (t) => /^\s*(?:\[?\d{4}-\d{2}-\d{2}|\d{2}:\d{2}:\d{2})/m.test(t),
    split: splitLog,
  },
];

const section = (label, lines, weight, kind = 'body') => ({ label, lines, weight, kind });

/** A test report: failures are the point, passes are the noise. */
function splitTestReport(text) {
  const lines = text.split('\n');
  const failures = [];
  const summary = [];
  const passes = [];
  const other = [];

  for (const line of lines) {
    if (/\b(FAILED|FAIL|Failed!|error|Error|Assert\.)\b/.test(line)) failures.push(line);
    else if (/\b(Tests?|Test Suites?|Passed!|Total tests|\d+ passed)\b.*\d/.test(line)) summary.push(line);
    else if (/\b(PASS|passed|OK|ok)\b/.test(line)) passes.push(line);
    else other.push(line);
  }

  return [
    section('failures', failures, 10, 'failure'),
    section('summary', summary, 8, 'summary'),
    section('passing tests', passes, 1),
    section('build and runner output', other, 2),
  ].filter((s) => s.lines.length);
}

/** A diff: one section per file, so a 40-file diff can drop 39 of them by name. */
function splitDiff(text) {
  const sections = [];
  let current = null;

  for (const line of text.split('\n')) {
    const header = /^diff --git a\/(\S+)/.exec(line);
    if (header) {
      if (current) sections.push(current);
      current = section(header[1], [line], 5, 'file');
      continue;
    }
    if (!current) current = section('preamble', [], 2);
    current.lines.push(line);
  }
  if (current) sections.push(current);
  return sections.filter((s) => s.lines.length);
}

/** A stack trace: the frames inside this project are the ones anyone reads. */
function splitStack(text) {
  const ours = [];
  const vendor = [];
  const message = [];

  for (const line of text.split('\n')) {
    if (/^\s+(?:at |File ")/.test(line)) {
      (/node_modules|<anonymous>|\[native code\]|System\./.test(line) ? vendor : ours).push(line);
    } else {
      message.push(line);
    }
  }

  return [
    section('error', message, 10, 'failure'),
    section('frames in this project', ours, 8, 'frames'),
    section('library and runtime frames', vendor, 1),
  ].filter((s) => s.lines.length);
}

/** A log: severity is the structure. */
function splitLog(text) {
  const bad = [];
  const warn = [];
  const rest = [];

  for (const line of text.split('\n')) {
    if (/\b(ERROR|FATAL|Exception|panic)\b/i.test(line)) bad.push(line);
    else if (/\bWARN/i.test(line)) warn.push(line);
    else rest.push(line);
  }

  return [
    section('errors', bad, 10, 'failure'),
    section('warnings', warn, 5),
    section('routine log lines', rest, 1),
  ].filter((s) => s.lines.length);
}

/**
 * A string field big enough to have a shape of its own.
 *
 * THE CASE THAT MATTERS MOST HERE. Every tool this product ships returns a JSON
 * envelope, so a file's contents or a build log arrives as one enormous escaped
 * string on a single line -- and selection inside a single line is not selection
 * at all, it is the positional truncation this module exists to replace. Parsing
 * the field's own shape puts the structure back.
 */
const NESTED_SHAPE_THRESHOLD = 2048;

/** JSON: top-level keys, so the model learns the shape without the payload. */
function splitJson(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [section('body', text.split('\n'), 3)];
  }

  if (Array.isArray(parsed)) {
    return [
      section('shape', [`array of ${parsed.length}`], 9, 'summary'),
      section('first element', JSON.stringify(parsed[0], null, 2).split('\n'), 6),
      section('remaining elements', [`${Math.max(0, parsed.length - 1)} more`], 1),
    ];
  }

  const sections = [];
  for (const [key, value] of Object.entries(parsed)) {
    // The raw string, not the re-escaped one: a payload's newlines are what
    // give it structure, and JSON.stringify turns them back into "\n" literals.
    if (typeof value === 'string' && value.length >= NESTED_SHAPE_THRESHOLD) {
      const inner = parseShape(value);
      for (const s of inner.sections) {
        sections.push({ ...s, label: `${key} > ${s.label}` });
      }
      continue;
    }
    const rendered = JSON.stringify(value, null, 2) ?? 'null';
    sections.push(section(key, rendered.split('\n'), 4, 'field'));
  }
  return sections;
}

/**
 * Identifies the output's shape and divides it into labelled sections.
 *
 * Falls back to a single unstructured section, which is where a purely
 * positional tool always is.
 */
export function parseShape(text) {
  for (const shape of SHAPES) {
    if (!shape.detect(text)) continue;
    const sections = shape.split(text);
    if (sections.length) return { shape: shape.name, sections };
  }
  return { shape: 'plain', sections: [section('output', text.split('\n'), 3)] };
}

/** Words worth matching on: long enough to mean something, lowercased. */
function terms(...sources) {
  const out = new Set();
  for (const source of sources.flat()) {
    for (const word of String(source || '').toLowerCase().match(/[a-z0-9_]{4,}/g) || []) {
      out.add(word);
    }
  }
  return out;
}

/**
 * Scores each section against what the session is doing.
 *
 * Intrinsic weight and relevance are ADDED rather than multiplied so a section
 * nobody asked about but which is obviously important -- a failure, an error --
 * still outranks a routine one that happens to share a word with the question.
 */
export function rankSections(sections, { question, anchors = [], boosts = {} } = {}) {
  const wanted = terms(question, anchors.map((a) => canonicalPath(a).split('/').pop()));

  return sections
    .map((s) => {
      const body = s.lines.join('\n').toLowerCase();
      let hits = 0;
      for (const term of wanted) if (body.includes(term)) hits += 1;
      // A learned boost from expansion history: sections of this label that
      // people kept asking for get pulled up next time.
      const boost = boosts[s.label] || boosts[s.kind] || 0;
      return { ...s, hits, score: s.weight + hits * 3 + boost };
    })
    .sort((a, b) => b.score - a.score);
}

/**
 * Is there already an answer, making the output unnecessary?
 *
 * The strongest form of disclosure: not a smaller version of the output, but
 * none of it. Only fires on a confident, fresh finding anchored to the same
 * files the output is about -- a stale or weak one is worse than the raw text.
 */
export function verdictFor(graph, { anchors = [], question, minConfidence = 0.7 } = {}) {
  if (!graph || !anchors.length) return null;
  const wanted = terms(question);

  for (const anchor of anchors) {
    const id = nodeId('file', canonicalPath(anchor));
    if (!graph.nodes.has(id)) continue;

    const findings = serve(graph, findingsFor(graph, id, { limit: 4 }));
    for (const finding of findings) {
      if (finding.stale) continue;
      if ((finding.confidence ?? 0) < minConfidence) continue;
      // With a question in hand, require that the finding actually addresses
      // it. Without one, a confident finding on the anchor is the best
      // available answer.
      if (wanted.size) {
        const claim = String(finding.claim || '').toLowerCase();
        let hits = 0;
        for (const term of wanted) if (claim.includes(term)) hits += 1;
        if (!hits) continue;
      }
      return finding;
    }
  }
  return null;
}

/**
 * Turns a large output into what the model should see.
 *
 * Returns null when the output is small enough to pass through untouched --
 * disclosing a 200-byte result costs more than it saves, and a tool that
 * previews everything is just a tax.
 *
 * @param dir      Graph directory, for the earned budget and the verdict layer.
 * @param text     The raw tool output.
 * @param context  { graph, question, anchors, tool, boosts, ref }
 */
export function disclose(dir, text, context = {}) {
  const raw = String(text || '');
  if (raw.length < DISCLOSE_THRESHOLD) return null;

  const { graph, question, anchors = [], tool, boosts, ref } = context;

  // LAYER 1 -- the answer, if we already have it.
  const verdict = verdictFor(graph, { anchors, question });
  if (verdict) {
    return {
      mode: 'verdict',
      shape: null,
      ref,
      omissions: [{ label: 'the full output', lines: raw.split('\n').length, ref }],
      text: [
        `Already established: ${verdict.claim}`,
        verdict.derivedCost
          ? `  (finding ${verdict.key}, cost ${verdict.derivedCost.toLocaleString()} tokens to reach, confidence ${verdict.confidence ?? '?'})`
          : `  (finding ${verdict.key}, confidence ${verdict.confidence ?? '?'})`,
        `Output withheld -- expand ${ref || 'the reference above'} if you need the raw run.`,
      ].join('\n'),
    };
  }

  // LAYERS 2 and 3 -- structure, then relevance within it.
  const { shape, sections } = parseShape(raw);
  const ranked = rankSections(sections, { question, anchors, boosts });
  const budget = substitutionBudget(dir, anchors[0] || tool || 'output');

  const kept = [];
  const omissions = [];
  let spent = 0;

  for (const s of ranked) {
    const body = s.lines.join('\n');
    const cost = estimate(body);
    if (spent + cost <= budget) {
      kept.push({ label: s.label, lines: s.lines, kind: s.kind });
      spent += cost;
      continue;
    }

    // Partial admission: a section too big to keep whole may still fit in part,
    // and half a stack trace beats none of it.
    // `kept.length === 0` is the floor: sections are visited in rank order, so
    // this is the best thing available, and a preview that returns NOTHING is
    // worse than one that returns the front of the best section. An empty
    // preview forces the expansion it exists to avoid.
    const room = budget - spent;
    if (room > 40 && (s.score >= 6 || kept.length === 0)) {
      const slice = [];
      let used = 0;
      for (const line of s.lines) {
        const lineCost = estimate(line);
        if (used + lineCost > room) break;
        slice.push(line);
        used += lineCost;
      }

      // A single line longer than the whole budget -- a minified bundle, a JSON
      // payload with no newlines at all. Nothing above can split it, so cutting
      // by character is the last resort rather than returning nothing. Named as
      // a cut like any other, because a silent one is the actual harm.
      if (!slice.length && s.lines.length === 1) {
        const head = s.lines[0].slice(0, Math.max(0, room * 4));
        if (head.length) {
          kept.push({ label: s.label, lines: [head], kind: s.kind, partial: true });
          spent += estimate(head);
          omissions.push({
            label: `${s.label} (${(s.lines[0].length - head.length).toLocaleString()} more characters on one line)`,
            lines: 1, ref, partial: true,
          });
          continue;
        }
      }

      if (slice.length) {
        kept.push({ label: s.label, lines: slice, kind: s.kind, partial: true });
        spent += used;
        omissions.push({ label: s.label, lines: s.lines.length - slice.length, ref, partial: true });
        continue;
      }
    }
    omissions.push({ label: s.label, lines: s.lines.length, ref });
  }

  const head = question
    ? `[selected against: "${question}"]`
    : `[${shape} output, ${raw.split('\n').length} lines -- most relevant sections kept]`;

  const body = kept.map((k) => (k.partial
    ? [`--- ${k.label} (partial) ---`, ...k.lines]
    : [`--- ${k.label} ---`, ...k.lines]).join('\n'));

  // EVERY CUT IS NAMED. A model reasoning over a silent truncation cannot know
  // it is missing something; one told "1,760 lines of passing tests omitted"
  // can decide whether that matters and ask for them if it does.
  const tail = omissions.length
    ? [`---- omitted: ${omissions.map((o) => `${o.lines.toLocaleString()} lines of ${o.label}`).join('; ')}${ref ? ` (expand ${ref})` : ''} ----`]
    : [];

  return {
    mode: 'preview',
    shape,
    ref,
    kept,
    omissions,
    tokens: spent,
    text: [head, ...body, ...tail].join('\n'),
  };
}
