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
 * The most a preview may cost, as a share of the output it replaces.
 *
 * ONE, AND NOT A KNOB. It was drafted at 0.9 on the reasoning that a preview
 * withholding almost nothing has spent a header, a label per section and an
 * omission tail for nothing. Measuring the fourteen benched tools falsified the
 * number: sixteen replies are disclosed across that sweep and the largest
 * preview is 0.892 of its body -- smart_complexity on a 4,937-token fixture,
 * eight thousandths under the ceiling, and refusing it moves that reading from
 * +12.6% to +8.6% because the preview plus the remainder is cheaper than the
 * body. A threshold anywhere below 1 trades a saving the non-expanding caller
 * certainly gets against an overpay the expanding one might, and nothing
 * measured sets the rate.
 *
 * At 1 the rule was this module's own contract instead: a preview that costs
 * more than the output it replaces is a tax on every caller, however they use
 * it, and that case is refused. Nothing in the benched sweep reaches it, which
 * is why disclose.test.mjs builds a body that does -- 112 tiny sections past
 * the threshold, which previewed at 1.63x its own cost before this existed.
 *
 * 1.01 IS THAT CONTRACT WITH THE ONE THING IT CANNOT GIVE UP PRICED IN. The
 * charge is now the remainder in full, so the ceiling is read against the sum
 * the EXPANDING caller pays -- preview plus everything the handle holds -- and
 * that sum can only come in under the body where the remainder re-renders
 * cheaper than the lines it replaced. A body served back verbatim has no such
 * saving, so it pays the omission line: the counts, the section names and the
 * sixteen-hex handle, which is the one part of a preview nothing can derive,
 * because without it the remainder is unreachable. Measured after every other
 * part of the preview was taken out -- the header line, a sole section's label,
 * a sole remainder's label, and the "N lines of" repeated once per omission --
 * it comes to 17-20 tokens, and that is what these bodies overspend by:
 *
 *   4,000-line log         21 on 46,723   0.04%
 *   one 60 KB line         32 on 15,003   0.21%
 *   500-element array      29 on  7,571   0.38%
 *   test report            27 on  6,212   0.43%
 *   compact JSON body      11 on  2,085   0.53%
 *   nested JSON envelope   56 on  1,902   2.9%
 *   400 tiny sections   1,315 on  4,307  30.5%
 *
 * The holding caller saves 39-99% on every one of those. A share, not a fixed
 * allowance, is what separates the first five from the last two: the overspend
 * scales with the tail, the tail scales with the number of sections, and the
 * body does not -- so 56 tokens on a 1,902-token envelope and 1,315 on 4,307
 * sections of labels are the same defect at two sizes, and both are refused,
 * while 21 tokens on a 46,723-token log is not a defect at all. A fixed
 * allowance would have had to be chosen by hand and would have grown exactly
 * where the overspend is worst.
 */
export const WORTHWHILE_PREVIEW = 1.01;

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
    detect: (t) =>
      /\b(FAILED|FAIL|Failed!|Assert\.|Test Suites:|\d+ (?:passed|failed))\b/.test(
        t
      ),
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

const section = (label, lines, weight, kind = 'body') => ({
  label,
  lines,
  weight,
  kind,
});

/**
 * The same section, marked as a JSON rendering of a value.
 *
 * `splitJson` indents every value it renders so the budget loop has lines to
 * admit or drop -- selection inside one long line is the positional truncation
 * this module exists to replace. That indentation is wanted in the PREVIEW and
 * is pure cost in the remainder an `expand` serves, where JSON whitespace means
 * nothing at all. This flag says which sections may be de-indented for that
 * purpose, and a nested string field -- a file's own contents arriving as one
 * escaped JSON string, where the leading spaces ARE the content -- never
 * carries it, because it is not rendered by that stringify call.
 */
const jsonSection = (label, lines, weight, kind = 'body') => ({
  ...section(label, lines, weight, kind),
  json: true,
});

/**
 * A withheld run of lines, as cheap as it can be served without losing
 * anything the caller would have had.
 *
 * WITHOUT THIS THE WHOLE WITHHELD-REMAINDER HANDLE NEVER ENGAGES ON JSON, which
 * is what every tool in this product returns. The remainder is built from the
 * preview's indented lines while the artifact behind the body's own reference
 * is the tool's compact output, so on smart_complexity's 4,937-token fixture the
 * remainder came to 7,204 characters where the whole body was 5,371 -- bigger
 * than everything it was a part of, and the cheaper-of-the-two guard below
 * correctly fell back to the body every time. De-indenting removes exactly the
 * difference: the characters stringify added for the preview's benefit.
 */
export function withheldLines(s, lines) {
  return s.json ? lines.map((line) => line.trimStart()) : lines;
}

/** A test report: failures are the point, passes are the noise. */
function splitTestReport(text) {
  const lines = text.split('\n');
  const failures = [];
  const summary = [];
  const passes = [];
  const other = [];

  for (const line of lines) {
    if (/\b(FAILED|FAIL|Failed!|error|Error|Assert\.)\b/.test(line))
      failures.push(line);
    else if (
      /\b(Tests?|Test Suites?|Passed!|Total tests|\d+ passed)\b.*\d/.test(line)
    )
      summary.push(line);
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
      (/node_modules|<anonymous>|\[native code\]|System\./.test(line)
        ? vendor
        : ours
      ).push(line);
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

/**
 * How deep that search goes.
 *
 * IT USED TO STOP AT ONE, which covered the tools whose payload is
 * `{ content: <the file> }` and missed every tool that wraps its answer. The
 * smart_pretty family returns the formatted file at `data.format.code`, two
 * levels in, so `data` was rendered with JSON.stringify and the file stayed one
 * escaped line inside it -- the exact case the comment above says this exists to
 * prevent. Measured on token-counter.ts through smart_pretty: 3,835 tokens for a
 * 3,368-token file, with the escape the whole of the difference, and the one
 * line was long enough that the bench's self-claim gate read the fixture's own
 * source as a published saving.
 */
const NESTED_SHAPE_DEPTH = 6;

/**
 * A value with its long string fields taken out, and those strings by path.
 *
 * The strings have to be REMOVED, not merely also reported: a preview that
 * rendered the object whole and then printed the field again would charge the
 * caller twice for the biggest thing in the reply.
 *
 * Object properties only, like the depth-1 rule above. Removing an array
 * element shifts every index after it, so a label naming one would describe a
 * payload that does not exist -- and measured across the fourteen benched tools
 * the longest string held in an array is a sentence of advice.
 */
function liftNestedText(value, path, depth = 1) {
  if (depth > NESTED_SHAPE_DEPTH || !value || typeof value !== 'object') {
    return { stripped: value, lifted: [] };
  }
  const lifted = [];
  if (Array.isArray(value)) {
    const stripped = value.map((entry, index) => {
      const inner = liftNestedText(entry, `${path}[${index}]`, depth + 1);
      lifted.push(...inner.lifted);
      return inner.stripped;
    });
    return { stripped, lifted };
  }
  const stripped = {};
  for (const [key, entry] of Object.entries(value)) {
    const here = `${path}.${key}`;
    if (typeof entry === 'string' && entry.length >= NESTED_SHAPE_THRESHOLD) {
      lifted.push({ path: here, text: entry });
      continue;
    }
    const inner = liftNestedText(entry, here, depth + 1);
    lifted.push(...inner.lifted);
    stripped[key] = inner.stripped;
  }
  return { stripped, lifted };
}

/**
 * How wide a value may be before it is broken across lines.
 *
 * Chosen so a whole record stays on one line and a container of records does
 * not: across the fourteen benched tools a suggestion row, a dependency entry
 * and a complexity record all serialise under this, while the arrays holding
 * them run to thousands of characters.
 */
const LINE_WIDTH = 160;

/**
 * A value as lines, one compact entry per line.
 *
 * THE INDENTATION WAS NEVER FOR THE CALLER. Sections are selected and trimmed
 * by the line, so this had to produce lines, and JSON.stringify(value, null, 2)
 * produced them -- along with a brace or a bracket on a line of its own for
 * every container, and two spaces per level of nesting on every line, all of it
 * billed to whoever read the preview. Measured against the compact body each
 * one came from:
 *
 *   smart_refactor    tool-profile.ts      1,639 -> 2,637 indented, 1,772 here
 *   smart_refactor    smart-complexity.ts  2,085 -> 3,648 indented, 2,346 here
 *   smart_complexity  smart-complexity.ts  2,587 -> 4,476 indented, 2,676 here
 *   smart_config_read large-project         3,741 -> 4,400 indented, 4,072 here
 *
 * AND THE LINES ARE BETTER, not merely fewer: 104 of them where stringify made
 * 962 for the same payload, because each one is now a whole record rather than
 * one field of one. A budget that admits a line admits something the caller can
 * use, and an omission counted in lines counts records.
 *
 * Recursion stops as soon as a value fits, so the shape is opened up only where
 * it is too big to read in one piece -- which is exactly where a preview needs
 * to be able to cut.
 */
function jsonLines(value, depth = 0) {
  const compact = JSON.stringify(value) ?? 'null';
  if (compact.length <= LINE_WIDTH || depth > NESTED_SHAPE_DEPTH)
    return [compact];
  if (Array.isArray(value)) {
    const out = ['['];
    value.forEach((entry, index) => {
      const inner = jsonLines(entry, depth + 1);
      if (index < value.length - 1) inner[inner.length - 1] += ',';
      out.push(...inner);
    });
    out.push(']');
    return out;
  }
  if (!value || typeof value !== 'object') return [compact];
  const keys = Object.keys(value);
  const out = ['{'];
  keys.forEach((key, index) => {
    const inner = jsonLines(value[key], depth + 1);
    inner[0] = JSON.stringify(key) + ': ' + inner[0];
    if (index < keys.length - 1) inner[inner.length - 1] += ',';
    out.push(...inner);
  });
  out.push('}');
  return out;
}

/** JSON: top-level keys, so the model learns the shape without the payload. */
function splitJson(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [section('body', text.split('\n'), 3)];
  }

  if (Array.isArray(parsed)) {
    // THE REMAINING ELEMENTS ARE A REAL SECTION, not a placeholder string. As a
    // placeholder they were discarded by this splitter itself, so the budget loop never
    // saw them, no omission was recorded, and -- because the tail is skipped when there
    // are no omissions -- the preview carried no expand ref either. Measured: a 30 KB
    // array of 500 objects returned ~150 bytes, `omissions: []`, and no way to recover
    // the other 499. Every other splitter in this file partitions all of its input.
    const out = [section('shape', [`array of ${parsed.length}`], 9, 'summary')];
    if (parsed.length) {
      // `?? null` because JSON.stringify(undefined) returns undefined, and .split would
      // then throw -- parseShape('[]') aborted the whole disclosure block.
      out.push(jsonSection('first element', jsonLines(parsed[0] ?? null), 6));
    }
    const rest = parsed.slice(1);
    if (rest.length) {
      out.push(
        jsonSection(`remaining ${rest.length} elements`, jsonLines(rest), 1)
      );
    }
    return out;
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
    // The same rule, applied at every depth: a long string anywhere under
    // this key gets its own shape, and what is left of the key is rendered
    // without it.
    const { stripped, lifted } = liftNestedText(value, key);
    for (const entry of lifted) {
      const inner = parseShape(entry.text);
      for (const s of inner.sections) {
        sections.push({ ...s, label: `${entry.path} > ${s.label}` });
      }
    }
    sections.push(jsonSection(key, jsonLines(stripped), 4, 'field'));
  }
  return sections;
}

/**
 * A partial section, closed so it is still a JSON value.
 *
 * Sections are admitted by the line and a cut lands wherever the budget runs
 * out, which on a JSON body is usually inside a container: the preview for
 * smart_refactor on tool-profile.ts ended mid-row, at a bare `"low",`, with two
 * arrays and an object left open. That is not a smaller answer, it is an
 * unparseable one -- a caller who wanted the data had no way to read what was
 * in front of them and had to follow the handle to get anything at all. The
 * preview was MANUFACTURING the expansion it exists to avoid.
 *
 * So the containers a slice leaves open are closed. The result is a JSON value
 * holding fewer array elements and fewer keys than the body, which is what a
 * preview is, and the omission marker beside it still says what was withheld
 * and how to get it.
 *
 * CHECKED, NOT ASSUMED. The scan below tracks strings and escapes, but a
 * section need not be JSON at all -- a log, a stack trace, or the single-line
 * character cut above all arrive here as lines -- so the closed text is parsed
 * before it is used and the slice is returned untouched if it does not parse.
 * Nothing is guessed: either the preview is a value or it is what it was.
 *
 * The remainder behind the handle is the body's own tail, without these
 * closers, so it continues to serve exactly the lines that were withheld.
 */
function closeJsonSlice(lines) {
  const stack = [];
  let inString = false;
  let escaped = false;
  for (const line of lines) {
    for (const ch of line) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (inString && ch === '\\') {
        escaped = true;
        continue;
      }
      if (ch === '\"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;
      if (ch === '{' || ch === '[') stack.push(ch);
      else if (ch === '}' || ch === ']') stack.pop();
    }
  }
  if (inString || !stack.length) return null;

  const out = lines.slice();
  // A trailing separator would sit before the closer, where no element follows.
  out[out.length - 1] = out[out.length - 1].replace(/,$/, '');
  out.push(
    stack
      .reverse()
      .map((open) => (open === '{' ? '}' : ']'))
      .join('')
  );
  try {
    JSON.parse(out.join(''));
  } catch {
    return null;
  }
  return out;
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
    for (const word of String(source || '')
      .toLowerCase()
      .match(/[a-z0-9_]{4,}/g) || []) {
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
export function rankSections(
  sections,
  { question, anchors = [], boosts = {} } = {}
) {
  const wanted = terms(
    question,
    anchors.map((a) => canonicalPath(a).split('/').pop())
  );

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
export function verdictFor(
  graph,
  { anchors = [], question, minConfidence = 0.7 } = {}
) {
  if (!graph || !anchors.length) return null;
  const wanted = terms(question);

  for (const anchor of anchors) {
    const id = nodeId('file', canonicalPath(anchor));
    if (!graph.nodes.has(id)) continue;

    // READ-ONLY serve: no `dir` is threaded here, so this cannot clear a stale
    // flag whose evidence is gone. That is deliberate -- this function takes a
    // graph, not the directory it came from, and widening its signature to give
    // an analysis path a write capability buys nothing: the injection path runs
    // on every tool call and clears the same findings.
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
      // Nothing was kept, so the withheld part is the body and its capture
      // converges on the same content hash. Stated rather than left implicit,
      // because the caller reads `handle` for what the text advertised.
      handle: ref,
      omissions: [
        {
          label: 'the full output',
          lines: raw.split('\n').length,
          ref,
          // In verdict mode nothing was kept, so the withheld part IS the body.
          // Capturing it yields the same content hash, which is why the handle
          // printed here and the one a preview prints converge on one artifact.
          withheld: raw.split('\n'),
        },
      ],
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
          kept.push({
            label: s.label,
            lines: [head],
            kind: s.kind,
            partial: true,
          });
          spent += estimate(head);
          omissions.push({
            label: `${s.label} (${(s.lines[0].length - head.length).toLocaleString()} more characters on one line)`,
            lines: 1,
            ref,
            partial: true,
            // The characters themselves, so the handle can serve what was cut
            // rather than the whole line back with the head attached again.
            withheld: [s.lines[0].slice(head.length)],
          });
          continue;
        }
      }

      if (slice.length) {
        // The budget check costs a section as one estimate over the joined body; this
        // loop costs it as a sum of per-line estimates. Those roundings differ, so the
        // loop can consume EVERY line of a section the budget check rejected. That is a
        // complete section, and labelling it partial with "0 lines omitted" makes the two
        // signals a reader is meant to trust fire on content that was not withheld.
        const dropped = s.lines.length - slice.length;
        // Closed where the cut left a container open, so what the caller is
        // handed parses. Costed as what is actually printed, closers included.
        const closed = dropped > 0 ? closeJsonSlice(slice) : null;
        const shown = closed || slice;
        kept.push({
          label: s.label,
          lines: shown,
          kind: s.kind,
          partial: dropped > 0,
        });
        spent += used + (closed ? estimate(closed[closed.length - 1]) : 0);
        if (dropped > 0)
          omissions.push({
            label: s.label,
            lines: dropped,
            ref,
            partial: true,
            json: s.json === true,
            withheld: withheldLines(s, s.lines.slice(slice.length)),
          });
        continue;
      }
    }
    omissions.push({
      label: s.label,
      lines: s.lines.length,
      ref,
      json: s.json === true,
      withheld: withheldLines(s, s.lines),
    });
  }

  // NO HEADER LINE. It used to open every preview -- the question echoed back,
  // or the shape and the line count with "most relevant sections kept" -- and
  // every word of it is derivable by the caller reading the reply. The question
  // is the caller's own; the shape is the content; the total is the lines kept
  // plus the count the omission line below states; and that same line is what
  // says this is not the whole output, which it says better, because it also
  // says how to get the rest. Measured at 9 tokens in the question form and
  // 14-16 in the other, on previews whose entire overspend against the body
  // they replaced was 42-49.
  //
  // A SOLE SECTION IS NOT LABELLED EITHER, for the same reason: a label earns
  // its line by marking a boundary, and with one kept section there is no
  // boundary to mark -- the omission line already names what is not here. Two
  // or more sections keep their labels, and a partial cut keeps its label
  // whatever the count, because "(partial)" is not derivable from anything.
  // A cut IS named on a sole section, just not twice. "(partial)" is the one
  // part of a label that nothing else states -- except where the omission
  // line below is about this very section, which says both that it is the
  // only one and how much of it is missing. So the label goes only when
  // every omission carries this label; a sole section with something else
  // omitted keeps it, because then the label does distinguish two things.
  const soleLabelled =
    kept.length === 1 && omissions.every((o) => o.label === kept[0].label);
  const sectionLabel = (k) =>
    soleLabelled ? [] : [`--- ${k.label}${k.partial ? ' (partial)' : ''} ---`];

  const body = kept.map((k) => [...sectionLabel(k), ...k.lines].join('\n'));

  // THE HANDLE POINTS AT WHAT WAS WITHHELD, NOT AT THE WHOLE OUTPUT.
  //
  // It used to point at the body, so following it re-sent everything the
  // preview had just delivered. Measured on a 1,270-token file through
  // smart_read: a 1,192-token preview, then 1,778 tokens to expand it -- 2,970
  // paid for 1,270 of content, and the duplicated preview was the largest
  // single term in that bill. A caller holding the preview needs the REST.
  //
  // `captureWithheld` is supplied by the server, which owns the artifact store;
  // without it this module still works and still prints the body's own
  // reference, because hooks-core has to run standalone with no store at all.
  // The remainder is labelled by the same rule, and for the same reason: the
  // preview's omission line has just named the one section it holds.
  // A JSON SECTION IS REASSEMBLED, NOT RE-LISTED. Its lines exist because the
  // budget loop needs something to admit or drop one at a time; serving them
  // back one per line charges a newline for every structural boundary the
  // renderer introduced, and the body it came from was compact. Measured on a
  // 500-element array: the de-indented remainder came to 7,700 tokens against
  // a 7,571-token body -- dearer than everything it was part of, purely in
  // separators -- so the cheaper-of-the-two guard below fell back to the body
  // and expanding cost the caller the whole thing plus the preview. Joined up,
  // it is the value the tool serialized, which is what the caller would have
  // had. A section that is not that rendering keeps its lines: there the
  // newlines are the content.
  const withheldText = omissions
    .map((o) =>
      [
        ...(omissions.length === 1 ? [] : [`--- ${o.label} ---`]),
        (o.withheld || []).join(o.json ? '' : '\n'),
      ].join('\n')
    )
    .join('\n');
  //
  // A REMAINDER THAT SERIALIZES LARGER THAN THE WHOLE IS NOT A SAVING, and one
  // can. `parseShape` renders the body's sections as indented lines, so the
  // remainder is built from a PRETTY-PRINTED view while the artifact behind
  // `ref` is the tool's own output verbatim -- usually compact JSON. On a dense
  // numeric payload the indentation outweighs the part that was kept: measured
  // on smart-complexity.ts through smart_complexity, the withheld remainder was
  // 7,204 characters where the whole compact body was 5,371, and pointing at it
  // cost 2,786 tokens to expand against the whole body's 2,587. So the two
  // candidates are compared, and the handle names whichever is actually cheaper
  // to serve. Compared by length, which is what `estimate` reduces to: both
  // strings carry the same data, so the one with less whitespace is the cheaper
  // one in tokens as well, and the comparison is wanted on every reply.
  const useWithheld =
    omissions.length > 0 &&
    typeof context.captureWithheld === 'function' &&
    estimate(withheldText) < estimate(raw);
  const handle =
    (useWithheld ? context.captureWithheld(withheldText) : null) || ref;

  // EVERY CUT IS NAMED. A model reasoning over a silent truncation cannot know
  // it is missing something; one told "1,760 lines of passing tests omitted"
  // can decide whether that matters and ask for them if it does.
  // Sections that lost the same number of lines are counted once between
  // them. The names are the information -- a caller deciding whether to
  // expand wants to know WHICH parts are missing -- but "1 lines of " ahead
  // of every one of them is not: measured on a 400-field body, 256 omissions
  // spent 1,483 tokens on this line, of which the repeated phrase was most
  // of it, against a remainder of 3,392 that the line exists to describe.
  // A JSON SECTION IS NAMED, NOT COUNTED. Its lines are the budget loop's
  // units, and the reassembly above serves it as the one value the tool
  // serialized, so a line count here would describe a rendering the caller is
  // never going to receive -- "501 lines of remaining 499 elements" for a
  // remainder that arrives as a single line. Where a count is worth having it
  // is already in the label, because that is where splitJson puts it. Text
  // sections keep theirs: there the lines are what is served.
  const byCount = new Map();
  const named = [];
  for (const o of omissions) {
    if (o.json) {
      named.push(o.label);
      continue;
    }
    const at = byCount.get(o.lines);
    if (at) at.push(o.label);
    else byCount.set(o.lines, [o.label]);
  }
  const groups = [...byCount].map(([lines, labels]) => {
    const n = lines.toLocaleString();
    const unit = lines === 1 ? 'line' : 'lines';
    return labels.length === 1
      ? `${n} ${unit} of ${labels[0]}`
      : `${n} ${unit} each of ${labels.join(', ')}`;
  });
  if (named.length) groups.push(named.join(', '));

  const tail = omissions.length
    ? [
        `---- omitted: ${groups.join('; ')}${handle ? ` (expand ${handle})` : ''} ----`,
      ]
    : [];

  const rendered = [...body, ...tail].join('\n');

  /*
   * A PREVIEW THAT IS NOT CHEAPER THAN THE OUTPUT IS A TAX.
   *
   * This module's own docstring says so -- "disclosing a 200-byte result costs
   * more than it saves, and a tool that previews everything is just a tax" --
   * but the only thing enforcing it was DISCLOSE_THRESHOLD, a floor on the
   * INPUT's size. Size is not the question. What matters is whether the elision
   * bought anything, and a body can be well over the threshold while the budget
   * admits nearly all of it: the preview then carries almost every line, adds a
   * header, a label per section and an omission tail, and the reader pays those
   * markers for a handful of withheld lines.
   *
   * MEASURED ON THE PREVIEW, NOT ON THE KEPT FRACTION. The obvious rule -- stop
   * when the kept sections are most of the body -- refuses too much: a
   * 1,270-token file read through smart_read keeps 67% of its payload and still
   * leaves the reader 33% better off than the raw reply, a real saving for the
   * caller who never expands. Only the rendered preview answers the question it
   * is actually asking, so that is what is compared, markers and all.
   */
  /*
   * AND THE CALLER WHO FOLLOWS THE HANDLE PAYS FOR IT.
   *
   * The test above weighed the preview alone, which prices one caller: the one
   * who reads it and never expands. That caller is real and the comment on
   * WORTHWHILE_PREVIEW is right that the saving is certain for them. But the
   * other caller is real too, and measured across the benched sweep they were
   * the majority case: of the ten replies that disclosed, SEVEN cost more than
   * the undisclosed body once the handle was followed --
   *
   *   smart_refactor    smart-complexity.ts   1,946 -> 2,251   -15.7%
   *   smart_refactor    tool-profile.ts       1,498 -> 1,660   -10.8%
   *   smart_pretty      tool-profile.ts       1,286 -> 1,373    -6.8%
   *   smart_config_read large-project         3,867 -> 4,119    -6.5%
   *
   * -- against gains of 4.8% to 80.3% for the caller who holds.
   *
   * So the remainder is charged, in full, every time. The preview has to beat
   * the body for the caller who follows the handle, not for the one who does
   * not, which means a disclosed reply never costs more than the reply it
   * replaced and the saving no longer depends on which caller turns up.
   *
   * THE ALTERNATIVE WAS MEASURED AND REJECTED. The store records a capture when
   * a preview is served and an expand when one is followed, so `previewPolicy`
   * can say how often a shape is actually expanded -- as a Wilson lower bound,
   * which is honest about how little one observation proves. Charging only the
   * untrusted share of the remainder is the better bet in expectation, and it
   * was built and swept: it moved nothing except smart_refactor's repeated
   * range, which it cost 13 points (-18% to 82% became -31% to 82%). The bet
   * pays the holding caller in tokens nobody can see and the expanding caller
   * in tokens that land in the published range, so it is not taken.
   */
  const expansion = estimate(useWithheld ? withheldText : raw);
  if (estimate(rendered) + expansion > estimate(raw) * WORTHWHILE_PREVIEW)
    return null;

  return {
    mode: 'preview',
    shape,
    ref,
    // What the tail actually printed, so the caller's accounting debits the
    // expansion against the same reference the preview advertised.
    handle,
    kept,
    omissions,
    tokens: spent,
    text: rendered,
  };
}
