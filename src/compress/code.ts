/**
 * Source-code compression: keep the shape, drop the bodies.
 *
 * Their CodeCompressor reports the largest single number they publish -- 92% on
 * code search, 17,765 tokens to 1,408 -- and the mechanism is sound: for a
 * context query, what a model needs from a file it is not editing is the list
 * of what is in it, not the implementation of each part.
 *
 * WHY A BODY MAY BE DROPPED AT ALL, given the lossless-first rule everywhere
 * else here: a body has a home. `src/x.ts:14-37` is a complete instruction for
 * getting it back, using a tool the agent already has, against a file that
 * exists whether or not any cache of ours survives. That is a materially
 * different bargain from an opaque hash into a TTL cache -- their marker stops
 * meaning anything when the entry expires, and prints `[unresolved: entry not
 * found]` into the model's context.
 *
 * NEVER APPLIED TO A DIFF. A diff is already the compressed form of a change,
 * and its hunks are the entire content; eliding those bodies would delete the
 * information. `looksLikeDiff` guards that, and the router honours it.
 */

import { parse } from '@babel/parser';
import { count, inlineMarker, span } from './annotate.js';
import { activeRanker } from './ranking.js';
import type { EmbeddingCache } from './embedding.js';
import { DEFAULT_TUNING } from './options.js';
import type { CompressionResult, Elision, EngineContext } from './types.js';
import { unchanged } from './types.js';

/**
 * Bodies shorter than this stay: the marker would cost more than the code.
 *
 * Was 4. Measured on 65 KB of this repository's own `src/tools`, a 4-line
 * floor elided only 41 bodies and left 16 KB of surviving code -- most of it
 * short methods just under the bar. The marker is now a range into a shared
 * spill rather than a path of its own, so the break-even is genuinely lower.
 */
const MIN_BODY_LINES = 2;

/**
 * Data literals are elided too, above a higher floor.
 *
 * A 300-line `const TABLE = {...}` is data, not shape: the declaration is what
 * a model needs to know exists, and the contents are exactly the kind of bulk
 * that a line range recovers perfectly. The floor is higher than for bodies
 * because a small options object IS the useful part of its declaration.
 */
const MIN_LITERAL_LINES = 8;

/** Extensions Babel can parse precisely. Everything else uses the heuristic. */
const BABEL = new Set(['js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'mts', 'cts']);

/** Declaration keywords per language, for the non-Babel path. */
const DECLARES: Record<string, RegExp> = {
  python: /^\s*(?:@|async\s+def\s|def\s|class\s|import\s|from\s\S+\simport\s)/,
  go: /^\s*(?:func\s|type\s|import\s|package\s|var\s|const\s)/,
  rust: /^\s*(?:pub\s+)?(?:async\s+)?(?:fn\s|struct\s|enum\s|trait\s|impl\s|use\s|mod\s)/,
  java: /^\s*(?:@|public\s|private\s|protected\s|class\s|interface\s|enum\s|import\s|package\s)/,
  ruby: /^\s*(?:def\s|class\s|module\s|require\s|require_relative\s)/,
  c: /^\s*(?:#include|typedef\s|struct\s|enum\s|[A-Za-z_][\w\s*]*\([^;]*\)\s*\{)/,
  // LAST RESORT, when no parser managed the content.
  //
  // The indentation walk below works for brace languages as well as for
  // Python: in formatted code the closing brace sits at the declaration's own
  // indentation, so the walk stops exactly there. This pattern is deliberately
  // broad -- it only decides where to START looking, and the walk decides the
  // rest.
  generic:
    /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?(?:async\s+)?(?:function\s|class\s|interface\s|enum\s|(?:public|private|protected|static|readonly)\s|const\s+[\w$]+\s*=|[\w$]+\s*\([^)]*\)\s*[:{])/,
};

const EXT_LANGUAGE: Record<string, string> = {
  py: 'python',
  go: 'go',
  rs: 'rust',
  java: 'java',
  rb: 'ruby',
  c: 'c',
  h: 'c',
  cc: 'c',
  cpp: 'c',
  hpp: 'c',
};

function extensionOf(path?: string): string {
  if (!path) return '';
  const base = path.split(/[/\\]/).pop() || '';
  const dot = base.lastIndexOf('.');
  return dot === -1 ? '' : base.slice(dot + 1).toLowerCase();
}

/** A unified diff. Its hunks ARE the content; never elide them. */
export function looksLikeDiff(text: string): boolean {
  return /^(?:diff --git |@@ -\d|--- |\+\+\+ )/m.test(text);
}

/** Cheap structural check for source code. */
export function looksLikeCode(text: string, ctx: EngineContext = {}): boolean {
  const ext = ctx.language || EXT_LANGUAGE[extensionOf(ctx.sourcePath)] || '';
  if (ext) return true;
  if (BABEL.has(extensionOf(ctx.sourcePath))) return true;
  return /^\s*(?:function |class |def |func |impl |public |private |import |from |const |let |var )/m.test(
    text
  );
}

/**
 * Body spans found by a real parser, for the languages we have one for.
 *
 * Returns [startLine, endLine] pairs, 1-based and inclusive, for every function
 * or method body worth eliding. A parse failure returns null so the caller can
 * fall back rather than emit something wrong -- a compressor that mangles code
 * it misparsed is worse than one that declines.
 */
function babelBodies(text: string): Array<[number, number]> | null {
  let ast: ReturnType<typeof parse>;
  try {
    ast = parse(text, {
      sourceType: 'unambiguous',
      allowReturnOutsideFunction: true,
      errorRecovery: true,
      plugins: ['typescript', 'jsx', 'decorators-legacy', 'classProperties'],
    });
  } catch {
    return null;
  }

  const spans: Array<[number, number]> = [];
  const seen = new Set<string>();

  const visit = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    const n = node as Record<string, unknown> & {
      type?: string;
      body?: unknown;
      loc?: { start: { line: number }; end: { line: number } };
    };

    const isFunction =
      typeof n.type === 'string' &&
      /^(FunctionDeclaration|FunctionExpression|ArrowFunctionExpression|ClassMethod|ObjectMethod|ClassPrivateMethod)$/.test(
        n.type
      );
    // A big literal is bulk data behind a declaration the model still sees.
    const isLiteral =
      typeof n.type === 'string' &&
      /^(ObjectExpression|ArrayExpression)$/.test(n.type);

    // A BLOCK BODY, OR NOTHING. `n.body` on an arrow function with a CONCISE body is
    // the expression itself, not a BlockStatement -- there are no braces around it. The
    // elision below keeps the first and last lines and replaces what is between them,
    // which on a multiline concise arrow cuts the middle out of an expression and
    // splices a marker into it. The result is not compressed source, it is invalid
    // source, and the model is asked to read it.
    const body = n.body as { type?: string } | undefined;
    const hasBlockBody = isFunction && body?.type === 'BlockStatement';

    if (hasBlockBody || isLiteral) {
      const target = hasBlockBody
        ? (n.body as
            | { loc?: { start: { line: number }; end: { line: number } } }
            | undefined)
        : (n as unknown as {
            loc?: { start: { line: number }; end: { line: number } };
          });
      if (target?.loc) {
        // The braces stay so the declaration still reads as a declaration;
        // only the lines strictly between them go.
        const from = target.loc.start.line + 1;
        const to = target.loc.end.line - 1;
        const key = `${from}:${to}`;
        const floor = hasBlockBody ? MIN_BODY_LINES : MIN_LITERAL_LINES;
        if (to - from + 1 >= floor && !seen.has(key)) {
          seen.add(key);
          spans.push([from, to]);
        }
      }
    }

    for (const value of Object.values(n)) {
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === 'object') visit(value);
    }
  };

  visit(ast.program);

  // OUTERMOST WINS. A literal inside an elided function body, or a nested
  // object inside an elided table, would otherwise emit a second marker for
  // lines that are already gone -- a marker pointing into a range the reader
  // can no longer see in context. Sorting by start and dropping anything
  // contained by the span before it keeps exactly one marker per hole.
  spans.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const outermost: Array<[number, number]> = [];
  for (const candidate of spans) {
    const last = outermost[outermost.length - 1];
    if (last && candidate[0] >= last[0] && candidate[1] <= last[1]) continue;
    outermost.push(candidate);
  }
  return outermost;
}

/**
 * Body spans by indentation, for languages without a parser here.
 *
 * A declaration line opens a block; the block runs until a line at or below the
 * declaration's indentation. Crude, and deliberately conservative: anything it
 * is unsure about it leaves alone.
 */
function heuristicBodies(
  text: string,
  language: string
): Array<[number, number]> {
  const declare = DECLARES[language];
  if (!declare) return [];
  const lines = text.split('\n');
  const spans: Array<[number, number]> = [];

  for (let i = 0; i < lines.length; i += 1) {
    if (!declare.test(lines[i])) continue;
    const indent = lines[i].match(/^\s*/)?.[0].length ?? 0;
    // TWO ENDS, BECAUSE A BLANK LINE IS NOT PART OF THE BODY. `scan` is how far
    // the walk got; `body` is the last line that actually belongs. A blank line
    // must not close a block -- a function with a blank line in the middle is
    // ordinary -- but letting it EXTEND the block put the trailing blanks after
    // a function inside the span, so they were elided along with the body and
    // named in the recovery range. The range then pointed at lines that were
    // never part of what the marker said it removed.
    let scan = i;
    let body = i;
    for (let j = i + 1; j < lines.length; j += 1) {
      if (!lines[j].trim()) {
        scan = j;
        continue;
      }
      const deeper = (lines[j].match(/^\s*/)?.[0].length ?? 0) > indent;
      if (!deeper) break;
      scan = j;
      body = j;
    }
    // 1-based, and the declaration line itself is kept.
    if (body - i >= MIN_BODY_LINES) spans.push([i + 2, body + 1]);
    i = scan;
  }
  return spans;
}

/**
 * If more than this share of bodies looks live, the question was too broad
 * to be evidence about any one of them.
 *
 * WITHOUT THIS GUARD LIVENESS IS A COMPRESSION SWITCH. A question that
 * happens to share vocabulary with every signature in a file would keep
 * every body and report a reduction near zero, for a reason no reader could
 * see. A signal that fires everywhere is not a signal.
 */
const MAX_LIVE_SHARE = 0.5;

/**
 * Which bodies the agent is currently working with.
 *
 * LIVENESS IS THE CODE-SHAPED FORM OF RELEVANCE, and it is the one that
 * matters most for a coding agent. If the last turn said "let me look at
 * compressBlock", the body of `compressBlock` is the single thing in the file
 * that must not be elided -- and eliding it is exactly what a
 * signature-preserving compressor does by default, because a signature is all
 * it keeps.
 *
 * RANKED, NOT MATCHED, and the difference is the whole reason this works. The
 * first version tested each declaration for a shared token with the question,
 * which reads as obviously correct and is useless: in a file of `alphaHandler`
 * / `betaHandler` / `gammaHandler`, a question about `gammaHandler` shares the
 * token `handler` with every declaration, so all of them looked live, the
 * breadth guard fired, and NOTHING was kept -- the exact opposite of the
 * intent, and it passed a hand-check of the logic. BM25's document frequency
 * discounts a term the declarations all share and keeps the one that
 * distinguishes them, which is what the ranker was built to do. Language
 * keywords need no special-casing for the same reason: `export` and `function`
 * appear in every declaration, so they carry no signal about any of them.
 */
function liveBodies(
  lines: readonly string[],
  spans: readonly (readonly [number, number])[],
  query: string | undefined,
  maxLiveShare: number = MAX_LIVE_SHARE,
  embeddings?: EmbeddingCache
): Set<number> {
  const rank = activeRanker(query, embeddings);
  if (!rank.active || !spans.length) return new Set<number>();

  // The declaration is the line above the body; the line above that catches
  // a decorator or a signature wrapped across two lines.
  const declarations = spans.map(
    ([from]) => `${lines[from - 3] ?? ''} ${lines[from - 2] ?? ''}`
  );
  // EVERY declaration that scores at all, not the top few, because the guard
  // below is a question about BREADTH. Asking for the top N would truncate the
  // answer to N and the guard could never fire -- it would silently keep half
  // the bodies of a file the question did not discriminate between, which is
  // the failure it exists to prevent.
  const live = rank.top(declarations, declarations.length);
  if (live.size > spans.length * maxLiveShare) return new Set<number>();
  return new Set([...live].map((i) => spans[i][0]));
}

/**
 * Replaces function bodies with a marker naming where they live.
 *
 * Signatures, imports, class and type declarations and decorators all survive,
 * which is what makes the output still answer "what is in this file".
 */
export function compressCode(
  text: string,
  ctx: EngineContext = {}
): CompressionResult {
  if (looksLikeDiff(text)) return unchanged(text);
  const tuning = ctx.tuning ?? DEFAULT_TUNING;
  // A replaced body is gone from the text; only its path brings it back.
  // That is the trade a lossless posture declines to make.
  if (!tuning.allowLossy) return unchanged(text);

  const ext = extensionOf(ctx.sourcePath);
  const language = ctx.language || EXT_LANGUAGE[ext] || '';
  // A PARSE FAILURE MUST NOT MEAN NO COMPRESSION.
  //
  // `babelBodies` returns null when it cannot parse, and the caller used to
  // treat that as "nothing to do". Measured on this repository's own
  // `src/server`, concatenated the way a tool result concatenates files:
  // Babel threw, the fallback needed an explicit language it did not have,
  // and the engine compressed 46,960 characters by exactly 0.0% while the
  // same engine managed 72% on `src/tools`. Silent, and indistinguishable
  // from content that genuinely had nothing to remove.
  const parsed =
    BABEL.has(ext) || (!language && !ext)
      ? babelBodies(text)
      : heuristicBodies(text, language);
  // NULL AND EMPTY MEAN DIFFERENT THINGS, and conflating them is how a construct the
  // AST deliberately declines to touch gets mangled by the heuristic instead. `null` is
  // "could not parse", which is what the fallback exists for. `[]` is "parsed, and
  // there is nothing here worth eliding" -- an answer, and one the line-based
  // heuristic is not entitled to overrule. It was overruling it: a multiline concise
  // arrow, which the AST branch now correctly skips because its body has no braces,
  // came straight back through the fallback and had the middle cut out of its
  // expression.
  const spans =
    parsed !== null ? parsed : heuristicBodies(text, language || 'generic');

  if (!spans.length) return unchanged(text);

  const lines = text.split('\n');
  const elided = new Set<number>();
  const elisions: Elision[] = [];
  const markerAt = new Map<number, string>();

  // LIVENESS, DECIDED ONCE FOR THE WHOLE BLOCK. A body whose declaration is
  // what the agent is asking about survives; the rest are elided as before.
  const eligible = spans.filter(
    ([from, to]) => to - from + 1 >= tuning.minBodyLines
  );
  const liveness = liveBodies(
    lines,
    eligible,
    ctx.query,
    tuning.maxLiveShare,
    ctx.embeddings
  );

  // ONE SPILL FOR THE WHOLE BLOCK, NOT ONE PER BODY.
  //
  // Spilling each body separately made every marker carry its own path, and
  // measurement showed what that costs: on the code-search fixture the markers
  // were 1,671 of the 6,992 surviving characters -- 24% of the output was our
  // own bookkeeping, nearly as much as the comments. Writing the original once
  // and giving every marker a line range into it turns a 34-character path into
  // a shared one, and the ranges are the same shape a real source path already
  // produces.
  //
  // It is also better for the reader: one file holding the original in order,
  // rather than N fragments they would have to reassemble.
  const anchorPath =
    ctx.sourcePath ?? (ctx.spill ? ctx.spill(text, 'block.txt') : null);

  for (const [from, to] of spans) {
    const lineCount = to - from + 1;
    if (lineCount < tuning.minBodyLines) continue;
    // The agent is looking at this one. Everything else still goes.
    if (liveness.has(from)) continue;
    // WHERE THE BODY CAN BE FOUND AGAIN, and it must be findable or it stays.
    //
    // A file on disk is the best answer: `src/x.ts:14-37` costs nothing to
    // produce and survives anything that happens to us. But most code a model
    // reads arrives as a TOOL RESULT with no path at all -- a grep hit, a
    // pasted excerpt -- and requiring one meant the engine silently declined
    // on exactly the content it was built for. The proof gate caught that:
    // code-search compressed 0%.
    //
    // Either way the line numbers are the ORIGINAL block's, so a range means
    // the same thing whether it points at the real file or at the spill.
    const where = anchorPath ? span(anchorPath, from, to) : null;
    if (!where) continue;

    for (let line = from; line <= to; line += 1) elided.add(line);
    const indent = lines[from - 1]?.match(/^\s*/)?.[0] ?? '  ';
    markerAt.set(
      from,
      indent + inlineMarker(`body, ${count(lineCount, 'line')}`, where)
    );
    elisions.push({
      removed: `body, ${count(lineCount, 'line')}`,
      recoverAt: where,
      // The body is gone from the text; `where` is the only way back.
      lossless: false,
    });
  }

  if (!elisions.length) return unchanged(text);

  const out: string[] = [];
  let blankRun = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const lineNo = i + 1;
    const marker = markerAt.get(lineNo);
    if (marker) out.push(marker);
    if (elided.has(lineNo)) continue;

    const trimmed = lines[i].trim();

    // DOCSTRINGS STAY, LINE COMMENTS GO. A `/** ... */` block states the
    // contract of the thing beneath it, which is the half of a signature that
    // is not in the types; a `//` note explains an implementation the reader
    // can no longer see anyway, since its body has just been elided. Measured
    // at 3,048 characters of the surviving 24,710 on the code-search fixture.
    if (trimmed.startsWith('//')) continue;

    // Blank runs collapse to one. Vertical rhythm in a file the model is
    // scanning rather than editing is not worth a token per line.
    if (!trimmed) {
      blankRun += 1;
      if (blankRun > 1) continue;
    } else {
      blankRun = 0;
    }

    out.push(lines[i]);
  }

  return { text: out.join('\n'), elisions, lossless: false };
}
