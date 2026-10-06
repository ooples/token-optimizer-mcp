/**
 * TEMPLATE EXTRACTION: THE PASS THAT CLOSES THE GAP, PROTOTYPED AND PRICED.
 *
 * Generic brotli takes 82.5% to 98.6% off the contested fixtures where our arm
 * takes 13% to 68%, and dead-units.mjs showed only 4.3% of that is repeated
 * LINES. The rest is repeated SHAPE: `[ts] INFO foo=1` and `[ts] INFO foo=2`
 * are one template and two parameter tuples, and an exact-match pass sees
 * nothing in common.
 *
 * So: replace every run of same-shaped lines with the shape written once and
 * the parameters that vary. Nothing leaves the context, so nothing is fetched --
 * which is the whole difference from a deferring engine, whose 99.8% on
 * raw-build-log is the log withheld behind a handle and 18 round trips.
 *
 * This file prices the idea before any of it is wired into the engine, and the
 * answer is that THE IDEA IS WRONG. Templating makes the token count WORSE on
 * every bulk fixture: raw-build-log -45.4%, api-responses -28.9%, database-rows
 * -27.8%, log-entries -18.1%, search-results -11.6%, and +0.6% over the corpus.
 *
 * And it refutes the bound the whole route rested on. Brotli's 87-93% on these
 * same fixtures is NOT headroom a text encoding can take, because the tokenizer
 * is already a compressor: BPE has merged the repeated substrings that brotli
 * is finding, so stripping a line to bare parameters throws away text the
 * tokenizer was pricing cheaply and leaves values it prices dearly. Byte
 * redundancy is not token redundancy, and I built three routes on the
 * assumption that it was.
 *
 * Which explains the competitor. Their 99.8% on raw-build-log is not a better
 * compressor -- it is the log WITHHELD, behind a handle and 18 round trips.
 * They reach for withholding because compressing text that a tokenizer has
 * already compressed has very little left to give. So eviction is the only
 * lever on this corpus, and the open question is not how to compress better but
 * how to evict without paying for a fetch.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync } from 'node:zlib';
import { tokens } from './currency.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CORPUS = join(HERE, '..', '..', 'hr-corpus', 'natives-18.json');

/**
 * The shape of a line: what stays the same when only the data changes.
 *
 * Ordered longest-pattern-first, because a timestamp is also a run of digits
 * and whichever matches first wins. Each class becomes one placeholder, so two
 * lines differing only in their data share a shape exactly.
 */
const CLASSES = [
  [
    /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g,
    '\u0001T',
  ],
  [/\b[0-9a-f]{7,64}\b/gi, '\u0001H'],
  [/\b\d+\.\d+\b/g, '\u0001F'],
  [/\b\d+\b/g, '\u0001N'],
  [/"[^"]*"/g, 'S'],
];

function shapeOf(line) {
  let shaped = line;
  for (const [pattern, mark] of CLASSES) shaped = shaped.replace(pattern, mark);
  return shaped;
}

function fixtures() {
  if (!existsSync(CORPUS)) return [];
  const parsed = JSON.parse(readFileSync(CORPUS, 'utf-8'));
  const list = Array.isArray(parsed)
    ? parsed
    : Object.entries(parsed).map(([name, value]) => ({
        name,
        ...(typeof value === 'object' ? value : { text: value }),
      }));
  return list.map((entry) => ({
    name: entry.name,
    text: Object.keys(entry)
      .filter((key) => /^[0-9]+$/.test(key))
      .map((key) => entry[key])
      .map((m) =>
        typeof m.content === 'string'
          ? m.content
          : JSON.stringify(m.content ?? m)
      )
      .join('\n'),
  }));
}

/** The parameters a line supplies to its shape, in order. */
function paramsOf(line) {
  const found = [];
  for (const [pattern] of CLASSES) {
    const matches = line.match(pattern);
    if (matches) found.push(...matches);
  }
  return found;
}

function templated(text) {
  const lines = text.split('\n');
  const counts = new Map();
  for (const line of lines) {
    const shape = shapeOf(line);
    counts.set(shape, (counts.get(shape) ?? 0) + 1);
  }
  // A shape is worth writing down once only if it recurs. Singletons are
  // emitted verbatim, so this can never be worse than the input but for the
  // few characters of envelope.
  const out = [];
  const written = new Set();
  for (const line of lines) {
    const shape = shapeOf(line);
    if ((counts.get(shape) ?? 0) < 2) {
      out.push(line);
      continue;
    }
    if (!written.has(shape)) {
      written.add(shape);
      out.push(`\u0002${shape}`);
    }
    out.push(paramsOf(line).join('\u0003'));
  }
  return out.join('\n');
}

const rows = [];
for (const { name, text } of fixtures()) {
  if (!text) continue;
  const before = tokens(text);
  const after = tokens(templated(text));
  const bytes = Buffer.from(text, 'utf8');
  const bound = 1 - brotliCompressSync(bytes).length / bytes.length;
  rows.push({ name, before, after, ours: 1 - after / before, bound });
}

if (rows.length === 0) {
  console.log('no fixture corpus vendored here; run with hr-corpus present');
} else {
  rows.sort((a, b) => b.ours - a.ours);
  console.log('workload'.padEnd(24) + ' template  brotli   before    after');
  for (const r of rows)
    console.log(
      `${r.name.padEnd(24)} ${(r.ours * 100).toFixed(1).padStart(7)}% ${(r.bound * 100).toFixed(1).padStart(6)}% ${String(r.before).padStart(8)} ${String(r.after).padStart(8)}`
    );
  const before = rows.reduce((s, r) => s + r.before, 0);
  const after = rows.reduce((s, r) => s + r.after, 0);
  console.log(
    `\ntemplate extraction takes ${(((before - after) / before) * 100).toFixed(1)}% off the corpus (${before} -> ${after} tokens), with nothing withheld and no fetch`
  );
}
