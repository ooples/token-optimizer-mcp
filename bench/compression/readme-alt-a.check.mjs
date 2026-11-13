/**
 * The README's twelve-row head-to-head table must agree with the recorded run.
 *
 * WHY THIS IS NOT `readme-table.check.mjs`. That check runs its harness and
 * compares the README against live stdout, which is the stronger arrangement and
 * the one to prefer wherever it is possible. It is not possible here:
 * `head-to-head.mjs` scores against Alternative A's own output, produced by their
 * Python harness from their clone, so CI has nothing to run. The alternative
 * that was actually on the table was to publish twelve rows with nothing behind
 * them at all, which is the failure mode this repository has already had three
 * times.
 *
 * SO THE CHAIN HAS TWO LINKS AND THIS IS THE CHEAP ONE. Prose against the
 * record, every commit, here. Record against the live harness, by re-running
 * with --record and diffing, for anyone holding the clone. The second link is
 * not free, and the record says exactly how to close it.
 *
 * WHAT IT COMPARES. Numbers, per row, against that row's recorded figures --
 * never against the whole file. Twelve workloads times four arms puts "99.9%" in
 * the record twenty times over, so a whole-file substring test would pass a
 * stale figure on the strength of a coincidence in another row.
 *
 *   node bench/compression/readme-alt-a.check.mjs
 *
 * Exits non-zero, naming each figure it could not find, when they disagree.
 */

import { readFileSync } from 'node:fs';
import { COLUMNS } from './readme-alt-a.columns.mjs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');
// The guarded tables moved out of README.md into docs/COMPARISON.md, which
// keeps the README short; the prose that quotes them moved with them.
const README = join(repo, 'docs', 'COMPARISON.md');
const RECORD = join(here, 'alt-a', 'results', 'head-to-head.json');

const START = '<!-- ALT-A-TABLE:START';
const END = '<!-- ALT-A-TABLE:END -->';

const readme = readFileSync(README, 'utf8');
const from = readme.indexOf(START);
const to = readme.indexOf(END);
if (from === -1 || to === -1 || to < from) {
  console.error(
    'readme-alt-a.check: the ALT-A-TABLE markers are missing from\n' +
      'docs/COMPARISON.md. They are what makes this check possible -- restore them\n' +
      'around the twelve-row table rather than removing the check.'
  );
  process.exit(1);
}
const block = readme.slice(from, to);

// A NUMBER, WITH ITS UNIT WHERE IT HAS ONE. `\.?\d*` used to match a figure at
// the end of a sentence and swallow the full stop -- `3,068.` was compared
// against a record that says `3068`, and would have been reported missing for a
// reason that had nothing to do with the measurement. The `%`/`x` suffix is kept
// because the record keeps it, so `0.44x` cannot be confirmed by a bare `0.44`.
const FIGURE = /\d[\d,]*(?:\.\d+)?(?:%|x)?/g;

const record = JSON.parse(readFileSync(RECORD, 'utf8'));
const byName = new Map(record.workloads.map((w) => [w.name, w]));

// Only the table rows. Prose between the markers may carry numbers that are
// conclusions rather than measurements, and those are not the record's to
// confirm -- but the row a conclusion is drawn from is.
const rows = block
  .split(/\r?\n/)
  .filter((line) => line.trim().startsWith('|'))
  .filter((line) => !/^\s*\|[\s:|-]+\|\s*$/.test(line));

if (rows.length < 3) {
  console.error(
    `readme-alt-a.check: found ${rows.length} table rows between the ` +
      'markers, which is too few to be the table. Refusing to pass vacuously.'
  );
  process.exit(1);
}

const dataRows = rows.slice(1);
const figures = [];
for (const row of dataRows) {
  const cells = row.split('|').map((c) => c.trim());
  const workload = cells.find((c) => byName.has(c));
  if (workload === undefined) {
    console.error(
      `readme-alt-a.check: no recorded workload named in row: ${row.trim()}`
    );
    process.exit(1);
  }
  for (const figure of row.match(FIGURE) ?? [])
    figures.push({ workload, figure });
}

if (!figures.length) {
  console.error(
    'readme-alt-a.check: no figures in the table. Refusing to pass vacuously.'
  );
  process.exit(1);
}

/** Every recorded figure for one workload, flattened to a set of strings. */
const flatten = (node, into) => {
  if (node === null || node === undefined) return into;
  if (typeof node === 'string') {
    into.add(node);
    return into;
  }
  for (const value of Object.values(node)) flatten(value, into);
  return into;
};

// MEMBERSHIP, AND NOW PLACEMENT TOO. Membership alone accepted a figure found
// anywhere in its row of the record, so a cell under the wrong column passed:
// agent-loop published its preset figures under `ours` for weeks. Closing it
// needed a column-header-to-field map, and readme-alt-a.columns.mjs is that
// map: the renderer writes each cell from it and the placement check below
// requires each cell to equal it. Membership is kept as the coarser first
// answer, because it names the figure a reader would look for.
const missing = figures.filter(({ workload, figure }) => {
  const known = flatten(byName.get(workload), new Set());
  // The payload column is recorded unformatted, so a README that writes it with
  // thousands separators is the same measurement spelled for a reader.
  return !known.has(figure) && !known.has(figure.replace(/,/g, ''));
});

console.log(
  `readme-alt-a.check: ${figures.length} figures across ${dataRows.length} ` +
    `rows, against a record from ${record.recordedAt} (${record.commit.slice(0, 8)}).`
);

// PLACEMENT: every cell is exactly what its column publishes for that row, and
// every recorded workload has a row. See readme-alt-a.columns.mjs.
const cellsOf = (row) =>
  row
    .split('|')
    .slice(1, -1)
    .map((c) => c.trim());
const headers = cellsOf(rows[0]);
const misplaced = [];
// THE WHOLE HEADER, IN ORDER. Rejecting unknown columns is not enough: a table
// with a column removed from every row has no cell left to disagree, so a
// README that dropped their figures entirely would pass.
const expectedHeaders = COLUMNS.map((c) => c.header);
if (headers.join('|') !== expectedHeaders.join('|'))
  misplaced.push(
    `the header is [${headers.join(', ')}], not [${expectedHeaders.join(', ')}]`
  );
const listed = new Set();
for (const row of dataRows) {
  const cells = cellsOf(row);
  const w = byName.get(cells.find((c) => byName.has(c)));
  listed.add(w.name);
  headers.forEach((h, i) => {
    const column = COLUMNS.find((c) => c.header === h);
    if (column && cells[i] !== column.cell(w))
      misplaced.push(
        `${w.name} / ${h}: README has "${cells[i]}", the record "${column.cell(w)}"`
      );
  });
}
for (const w of record.workloads)
  if (!listed.has(w.name))
    misplaced.push(`${w.name}: recorded, but has no row`);

// BOTH ANSWERS, NOT THE FIRST ONE. This used to exit on the provenance gap
// before it printed the figure comparison, and the gap has been open for as long
// as the README has been held back -- so for that whole time a drifted figure
// was computed, never printed, and the check looked like it was failing for the
// reason it names. Mutating one cell of the table changed NOTHING about the
// output. A check that finds two problems reports two problems.
let failed = false;

if (misplaced.length) {
  console.error(
    '\nreadme-alt-a.check FAILED. Cells that are not what their column publishes:'
  );
  for (const why of misplaced) console.error(`  ${why}`);
  console.error(
    '\nRegenerate the table with: node bench/compression/readme-alt-a.render.mjs'
  );
  failed = true;
}

if (missing.length) {
  console.error('\nreadme-alt-a.check FAILED. Not found in the record:');
  for (const { workload, figure } of missing)
    console.error(`  ${workload}: ${figure}`);
  console.error(
    '\nEither the README drifted, or the record is stale. Regenerate it with:\n' +
      `  ${record.regenerate}`
  );
  failed = true;
}

// THE TABLE IS NOT THE WHOLE CLAIM; WHEN IT WAS TAKEN IS PART OF IT. Every
// figure above can agree with the record perfectly while the record describes a
// compressor three commits ago, and nothing in a figures-only comparison can
// tell. The README therefore states the record's date and commit in prose, and
// that prose is checked here -- so a reader is told how old these numbers are,
// and a stale record has to be declared rather than merely not noticed.
//
// This does not prove the record is CURRENT. It cannot: the other arm needs a
// clone CI has not got. `src/scripts/verify-blockers.mjs` carries that half, by
// refusing to call the tree shippable once `src/compress` has moved past the
// commit named here.
const provenance = [record.recordedAt, record.commit.slice(0, 8)].filter(
  (claim) => !block.includes(claim)
);

if (provenance.length) {
  console.error(
    '\nreadme-alt-a.check FAILED. The ALT-A-TABLE block does not state\n' +
      `the record it is checked against: ${provenance.join(' and ')} missing.\n` +
      'Say where the figures came from, beside the figures.'
  );
  failed = true;
}

// ---- THE CORPUS CLAIMS, WHICH UNTIL NOW NOTHING READ AT ALL. ----------------
//
// Two regions of this README were instrumented -- the twelve-row table above and
// the proof table, guarded by `readme-table.check.mjs`. Outside them 159 lines
// carried 233 numeric figures that no check had ever looked at, and the corpus
// headlines among them had drifted all the way off the record: the prose said
// the shipped default "takes 89.4% of the characters and 80.9% of the tokens"
// where the record says 56.7% / 42.4%, and it said "9,919 identifiers" in three
// separate places where the record says 13,784.
//
// So the corpus-wide sentences carry their own markers now, and every figure
// between a pair must appear in the record's `totals`. A figure is compared
// against `totals` only -- not against the whole record -- because a per-row
// number is not a corpus claim and admitting the rows would let "99.9%" from
// some other workload confirm a corpus headline.
//
// THE SAME MEMBERSHIP LENIENCY APPLIES HERE AS ABOVE, and it bites harder on a
// short figure: `totals` holds a "0", a "5" and an "18" among the cost fields,
// so a one- or two-character figure can be confirmed by a coincidence in a
// field that has nothing to do with the sentence. It is written down rather
// than patched for the same reason -- closing it needs a phrase-to-field map,
// and the prose it would be mapped against is being rewritten. Measured today
// it changes no verdict: 25 of 25 corpus figures are absent from `totals`, so
// nothing here is standing on a coincidental match.
const C_START = 'ALT-A-CORPUS:START';
const C_END = '<!-- ALT-A-CORPUS:END -->';

const corpusKnown = flatten(record.totals, new Set());

// COUNTS THE PROSE QUOTES THAT `totals` DOES NOT CARRY, derived from the rows so
// they cannot drift from them. "Our compressor alone removes fewer tokens than
// theirs on N of the 18 workloads" was hand-written as 8 for a month while the
// rows said 9: eight are workloads where their best setting differs from their
// comparable one (it moves content out of the request), and one is a plain
// compression loss.
const pct = (value) => Number.parseFloat(String(value));
const compressorLosses = record.workloads.filter(
  (w) => pct(w.tokens.ours) < pct(w.tokens.theirs)
);
const offloadLosses = compressorLosses.filter(
  (w) => pct(w.tokens.theirs) !== pct(w.tokens.theirsComparable)
);
corpusKnown.add(String(compressorLosses.length));
corpusKnown.add(String(offloadLosses.length));
corpusKnown.add(String(compressorLosses.length - offloadLosses.length));
corpusKnown.add(String(record.workloads.length));
for (const w of compressorLosses.filter((x) => !offloadLosses.includes(x))) {
  corpusKnown.add(w.tokens.ours);
  corpusKnown.add(w.tokens.theirs);
}

// MARKERS ARE ONLY WORTH ANYTHING IF THEY ARE NOT OPTIONAL. Nothing stops the
// next corpus claim from being written outside a pair, which is exactly how the
// 233 unread figures got here, so a corpus-scoped line carrying a figure and
// sitting outside every block is a failure that names itself.
//
// This detector errs by OMISSION: it finds a corpus-scoped sentence by the
// vocabulary such a sentence uses, so a claim phrased some other way is missed.
// It is not the guarantee, it is the trip-wire -- and it is why the figures rule
// above is scoped to `totals` rather than trusted to a keyword.
//
// A SUMMARY TABLE ROW CANNOT SIT INSIDE A BLOCK: an HTML comment between two rows
// ends the Markdown table. So a corpus-scoped line outside every block is held to
// the same record, figure by figure, instead of failing on sight -- a wrong figure
// still fails, which is all the markers were for. "Headroom's own benchmark" is how the
// summary tables name this corpus.
//
// A CLAIM WRAPS ACROSS LINES, so the scan is by paragraph: "removes fewer tokens
// than Headroom on 8 of the 18 workloads" sat on a line with no scope word and
// was never read. Table rows stay one per line. "N of (the) 18 workloads" names
// this corpus too.
const CORPUS_SCOPE =
  /corpus|retention unit|identifiers|of the characters|of the tokens|(?:Headroom's|their|its) own benchmark|\bof (?:the )?18 workloads/i;

/**
 * Checks one file's ALT-A-CORPUS blocks against the record's totals, and fails
 * any corpus-scoped figure written outside a block.
 *
 * docs/COMPARISON.md must carry blocks; the README may carry none, because its
 * summary need not quote the corpus at all -- but where it does, the figures are
 * held to the same record. The README summary was unguarded before: it said the
 * proxy "removes more of the payload on 15 of 18 workloads" and nothing checked it.
 */
function checkCorpus(text, label, { required }) {
  const corpusBlocks = [];
  for (
    let at = text.indexOf(C_START);
    at !== -1;
    at = text.indexOf(C_START, at + 1)
  ) {
    const open = text.indexOf('-->', at);
    const close = text.indexOf(C_END, open);
    if (open === -1 || close === -1) {
      console.error(
        `readme-alt-a.check: a ALT-A-CORPUS:START in ${label} at offset ` +
          at +
          ' has no matching CORPUS:END. Markers are what makes this checkable.'
      );
      process.exit(1);
    }
    // AN UNPAIRED MARKER MUST NOT QUIETLY WIDEN A BLOCK. With one CORPUS:END
    // deleted the scan ran on to the NEXT one and swallowed everything between,
    // which still fails but attributes the figures to the wrong sentence. A block
    // that contains another START is a broken pair, not a bigger block.
    if (text.slice(open + 3, close).includes(C_START)) {
      console.error(
        `readme-alt-a.check: a ALT-A-CORPUS block in ${label} contains another ` +
          'CORPUS:START, so a CORPUS:END is missing between them.'
      );
      process.exit(1);
    }
    corpusBlocks.push([open + 3, close]);
    at = close;
  }

  // A CHECK OVER AN EMPTY SET IS A VACUOUS PASS, and these markers live in a file
  // that is edited by hand, so their absence has to be the loud case.
  if (required && !corpusBlocks.length) {
    console.error(
      `readme-alt-a.check: no ALT-A-CORPUS markers in ${label}. The corpus\n` +
        'headlines were unchecked for a long time and that is what these markers\n' +
        'fixed -- restore them around the corpus sentences, do not drop the rule.'
    );
    process.exit(1);
  }

  const corpusFigures = [];
  for (const [from_, to_] of corpusBlocks)
    for (const figure of text.slice(from_, to_).match(FIGURE) ?? [])
      corpusFigures.push(figure);

  if (corpusBlocks.length && !corpusFigures.length) {
    console.error(
      `readme-alt-a.check: the ALT-A-CORPUS blocks in ${label} hold no figures. ` +
        'Refusing to pass vacuously.'
    );
    process.exit(1);
  }

  const corpusMissing = corpusFigures.filter(
    (figure) =>
      !corpusKnown.has(figure) && !corpusKnown.has(figure.replace(/,/g, ''))
  );

  const covered = new Set();
  for (const [from_, to_] of corpusBlocks) {
    const first = text.slice(0, from_).split(/\r?\n/).length;
    const last = text.slice(0, to_).split(/\r?\n/).length;
    for (let line = first; line <= last; line += 1) covered.add(line);
  }
  const units = [];
  let paragraph = null;
  text.split(/\r?\n/).forEach((content, index) => {
    const line = index + 1;
    const isRow = content.trimStart().startsWith('|');
    if (covered.has(line) || !content.trim() || isRow) {
      paragraph = null;
      if (!covered.has(line) && isRow) units.push({ line, text: content });
      return;
    }
    // A list item starts a new unit, so one bullet's figures are not judged by
    // the scope words of the bullet before it.
    if (!paragraph || /^\s*[-*] /.test(content)) {
      paragraph = { line, text: content };
      units.push(paragraph);
    } else paragraph.text += ` ${content.trim()}`;
  });
  const unmarked = units
    // No FIGURE.test here: FIGURE is global, so .test() carries lastIndex from
    // one line to the next and skips figures. .match() below resets it.
    .filter(({ text: line }) => CORPUS_SCOPE.test(line))
    .map((entry) => ({
      ...entry,
      wrong: (entry.text.match(FIGURE) ?? []).filter(
        (figure) =>
          !corpusKnown.has(figure) && !corpusKnown.has(figure.replace(/,/g, ''))
      ),
    }))
    .filter(({ wrong }) => wrong.length);

  console.log(
    `readme-alt-a.check: ${label}: ${corpusFigures.length} corpus figures across ` +
      `${corpusBlocks.length} marked block(s), against the record's totals.`
  );

  let bad = false;
  if (corpusMissing.length) {
    console.error(
      `\nreadme-alt-a.check FAILED. ${label}: not found in the record totals:`
    );
    for (const figure of corpusMissing) console.error(`  corpus: ${figure}`);
    bad = true;
  }

  if (unmarked.length) {
    console.error(
      `\nreadme-alt-a.check FAILED. ${label}: corpus-scoped lines outside every\n` +
        'ALT-A-CORPUS block carry figures the record totals do not hold:'
    );
    for (const { line, text: content, wrong } of unmarked)
      console.error(
        `  ${label}:${line}: [${wrong.join(', ')}] ${content.trim().slice(0, 96)}`
      );
    bad = true;
  }
  return bad;
}

if (checkCorpus(readme, 'docs/COMPARISON.md', { required: true })) failed = true;
if (
  checkCorpus(readFileSync(join(repo, 'README.md'), 'utf8'), 'README.md', {
    required: false,
  })
)
  failed = true;

if (failed) process.exit(1);

console.log('README ALTERNATIVE A TABLE AGREES with the recorded run.');
