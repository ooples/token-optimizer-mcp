/**
 * The README prose must not restate a figure the guarded tables do not hold.
 *
 * WHY THIS EXISTS. readme-table.check.mjs and readme-headroom.check.mjs pin the
 * marked TABLES. Nothing pinned the sentences around them, and the sentences
 * quote the same numbers: a review found four prose figures stale against the
 * tables two markers above them, in a section whose whole argument is that a
 * number stated twice drifts. Editing the table was checked; editing the
 * paragraph was not.
 *
 * THE RULE. A percentage in covered prose must appear verbatim inside one of
 * the guarded blocks in the same file -- because that block is already checked
 * against a harness, so a figure echoed from it is checked too -- or be
 * DECLARED below, naming where it comes from. There is no third option: an
 * undeclared figure that no table holds is exactly the drift this catches.
 *
 * RETRACTED FIGURES ARE CHECKED THE OTHER WAY UP. Several sentences quote a
 * number precisely because it is wrong ("this copy came to claim 98.9% long
 * after the tree had moved"). Requiring those to match the record would be
 * backwards, so this requires them to be ABSENT from it. If a re-record ever
 * makes one real, the sentence telling that story has become false and this
 * fails -- which is the only moment anyone would want to be told.
 *
 *   node bench/compression/readme-prose.check.mjs
 *
 * Exits non-zero, naming each figure and why, when they disagree.
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * Why a declared figure is not in a guarded table. Not free-form strings: the
 * kind decides which check runs, and RETRACTED inverts it.
 */
export const Source = Object.freeze({
  /** Quoted because it is WRONG. Must NOT appear in a guarded block. */
  RETRACTED: 'retracted',
  /** Arithmetic on guarded figures, or a share of a payload, not a row. */
  DERIVED: 'derived',
  /** Measured by a named harness that pins no table in this file. */
  OTHER_HARNESS: 'other-harness',
});

/**
 * The covered prose. `## Why it wins` holds both guarded tables and every
 * sentence that restates them; the marked span is the one paragraph outside it
 * that quotes the same rows. The rest of the file is not covered and this says
 * so rather than implying a sweep it does not do.
 */
const SECTIONS = [{ from: '## Why it wins', to: '## The 30-second version' }];
const SPAN = ['<!-- PROSE-CLAIMS:START', '<!-- PROSE-CLAIMS:END -->'];

const GUARDS = [
  ['<!-- PROOF-TABLE:START', '<!-- PROOF-TABLE:END -->'],
  ['<!-- HEADROOM-TABLE:START', '<!-- HEADROOM-TABLE:END -->'],
  ['<!-- HEADROOM-CORPUS:START', '<!-- HEADROOM-CORPUS:END -->'],
];

/**
 * Every figure in covered prose that no guarded block holds.
 *
 * `anchor` is a unique substring of the sentence, so the entry survives the line
 * moving and fails loudly when the sentence is rewritten out from under it.
 */
export const DECLARED = [
  {
    figure: '71%',
    anchor: 'Their number there is a',
    kind: Source.OTHER_HARNESS,
    from: 'bench/competitive -- their content-cache arm, not a row of either table',
  },
  {
    figure: '6.0%',
    anchor: 'used to be the one genuine engine loss',
    kind: Source.RETRACTED,
    from: 'the loss this row used to publish, before the repeat folding landed',
  },
  {
    figure: '44.3%',
    anchor: 'of the whole payload',
    kind: Source.DERIVED,
    from: 'the image share of one payload, which is not a reduction figure',
  },
  {
    figure: '44%',
    anchor: 'reduction, still ahead of their',
    kind: Source.DERIVED,
    from: 'the same row with the image excluded -- stated as ~44%, deliberately rounded',
  },
  {
    figure: '90%',
    anchor: 'On seven of the twelve rows it changes nothing at all',
    kind: Source.DERIVED,
    from: 'an upper bound being argued against, not a measurement',
  },
  {
    figure: '61.3%',
    anchor: 'version of this table claimed',
    kind: Source.RETRACTED,
    from: 'named in the sentence as a figure a previous table claimed',
  },
  {
    figure: '46.0%',
    anchor: 'published loss at',
    kind: Source.RETRACTED,
    from: 'the loss this row published before the hashbang fix',
  },
  {
    figure: '54.2%',
    anchor: 'four `log` engine commits then moved it to',
    kind: Source.RETRACTED,
    from: 'an intermediate value on the way to the figure the table now holds',
  },
  {
    figure: '64.9%',
    anchor: 'a concatenated block still parses moved it to',
    kind: Source.RETRACTED,
    from: 'what this row scored before every marker carried an authenticating stamp',
  },
  {
    figure: '64.2%',
    anchor: 'half point, to reach',
    kind: Source.RETRACTED,
    from: 'what this row scored while the currency was characters over four',
  },
  {
    figure: '42%',
    anchor: 'wins the invoice by',
    kind: Source.DERIVED,
    from: 'the invoice range from cost-model.mjs, not a reduction row',
  },
  {
    figure: '65%',
    anchor: 'conversation history is',
    kind: Source.DERIVED,
    from: 'the share of a live context that is history -- stated as ~65%',
  },
  {
    figure: '95.7%',
    anchor: 'and destroyed both the UUID record',
    kind: Source.RETRACTED,
    from: 'what the elide-after-N strategy scored while losing the needles',
  },
  {
    figure: '92.4%',
    anchor: 'with the needles intact',
    kind: Source.OTHER_HARNESS,
    from: 'the needle gate in bench/compression/proof.mjs, which pins no table here',
  },
  {
    figure: '98.9%',
    anchor: 'is how this copy came to claim',
    kind: Source.RETRACTED,
    from: 'named in the sentence as a claim the tree had already moved past',
  },
  {
    figure: '98.2%',
    anchor: 'is how this copy came to claim',
    kind: Source.RETRACTED,
    from: 'named in the sentence as a claim the tree had already moved past',
  },
  {
    figure: '92.8%',
    anchor: 'is how this copy came to claim',
    kind: Source.RETRACTED,
    from: 'named in the sentence as a claim the tree had already moved past',
  },
  {
    // The same retracted value the sentence above names, quoted a second time
    // in the list. Both occurrences are declared, because the anchor is what
    // ties a figure to the sentence that explains it.
    figure: '61.3%',
    anchor: 'is how this copy came to claim',
    kind: Source.RETRACTED,
    from: 'named in the sentence as a claim the tree had already moved past',
  },
];

const spans = (text, [open, close]) => {
  const out = [];
  let i = 0;
  for (;;) {
    const a = text.indexOf(open, i);
    if (a === -1) break;
    const b = text.indexOf(close, a);
    if (b === -1) break;
    out.push([a, b + close.length]);
    i = b + close.length;
  }
  return out;
};

/**
 * The covered prose lines, with the guarded blocks, tables and fenced code
 * removed. A figure inside a guard is the guard's business, not this one's.
 */
function coveredLines(readme) {
  const lines = readme.split(/\r?\n/);
  const text = lines.join('\n');
  const hidden = new Set();
  for (const guard of GUARDS) {
    for (const [a, b] of spans(text, guard)) {
      const first = text.slice(0, a).split('\n').length - 1;
      const n = text.slice(a, b).split('\n').length;
      for (let k = 0; k < n; k += 1) hidden.add(first + k);
    }
  }

  const wanted = new Set();
  const missingHeads = [];
  for (const { from, to } of SECTIONS) {
    const a = lines.findIndex((l) => l.trim() === from);
    const b = lines.findIndex((l) => l.trim() === to);
    if (a === -1 || b === -1 || b <= a) {
      missingHeads.push(`${from} .. ${to}`);
      continue;
    }
    for (let i = a + 1; i < b; i += 1) wanted.add(i);
  }
  const marked = spans(text, SPAN);
  if (!marked.length) missingHeads.push(SPAN[0]);
  for (const [a, b] of marked) {
    const first = text.slice(0, a).split('\n').length - 1;
    const n = text.slice(a, b).split('\n').length;
    for (let k = 0; k < n; k += 1) wanted.add(first + k);
  }

  const out = [];
  let fenced = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^\s*```/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced || !wanted.has(i) || hidden.has(i)) continue;
    if (/^\s*\|/.test(line)) continue;
    if (/^\s*<!--/.test(line)) continue;
    out.push({ line: i + 1, text: line });
  }
  return { lines: out, missingHeads, guardedText: guardedBlocks(text) };
}

function guardedBlocks(text) {
  const parts = [];
  for (const guard of GUARDS) {
    for (const [a, b] of spans(text, guard)) parts.push(text.slice(a, b));
  }
  return parts.join('\n');
}

/**
 * Every disagreement between the covered prose and the guarded tables.
 *
 * Returns counts as well as faults, because a check that stops finding
 * anything to look at passes for the wrong reason.
 */
export function proseDrift(readme) {
  const { lines, missingHeads, guardedText } = coveredLines(readme);
  const faults = [];
  for (const head of missingHeads) {
    faults.push({
      kind: 'scope',
      figure: '',
      detail: `covered region not found: ${head}`,
    });
  }

  for (const entry of DECLARED) {
    const hits = lines.filter((l) => l.text.includes(entry.anchor));
    if (hits.length !== 1) {
      faults.push({
        kind: 'stale-registry',
        figure: entry.figure,
        detail: `anchor ${JSON.stringify(entry.anchor)} matches ${hits.length} covered line(s), not 1`,
      });
      continue;
    }
    if (!hits[0].text.includes(entry.figure)) {
      faults.push({
        kind: 'stale-registry',
        figure: entry.figure,
        detail: `line ${hits[0].line} no longer carries it; the sentence was rewritten`,
      });
      continue;
    }
    if (entry.kind === Source.RETRACTED && guardedText.includes(entry.figure)) {
      faults.push({
        kind: 'resurrected',
        figure: entry.figure,
        detail:
          `line ${hits[0].line} calls it a figure the tree moved past, but a guarded ` +
          'table now holds it -- the sentence has become false',
      });
    }
  }

  const declared = new Set(DECLARED.map((d) => `${d.anchor}\u0000${d.figure}`));
  let checked = 0;
  for (const { line, text } of lines) {
    for (const m of text.matchAll(/\d+(?:\.\d+)?%/g)) {
      checked += 1;
      if (guardedText.includes(m[0])) continue;
      const covers = DECLARED.some(
        (d) =>
          d.figure === m[0] &&
          text.includes(d.anchor) &&
          declared.has(`${d.anchor}\u0000${d.figure}`)
      );
      if (covers) continue;
      faults.push({
        kind: 'undeclared',
        figure: m[0],
        detail: `line ${line}: no guarded table holds it and no registry entry claims it`,
      });
    }
  }

  return { checked, coveredLines: lines.length, faults };
}

/** Below this, the check is reading too little prose to mean anything. */
export const MINIMUM_FIGURES = 25;

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const here = dirname(fileURLToPath(import.meta.url));
  const readme = readFileSync(join(here, '..', '..', 'README.md'), 'utf8');
  const { checked, coveredLines: n, faults } = proseDrift(readme);
  console.log(
    `readme-prose.check: ${checked} figures across ${n} covered prose line(s), ` +
      `${DECLARED.length} declared.`
  );
  if (checked < MINIMUM_FIGURES) {
    console.error(
      `readme-prose.check: only ${checked} figures found, below the floor of ` +
        `${MINIMUM_FIGURES}. The covered regions have moved or shrunk, so this ` +
        'would pass vacuously. Fix the scope rather than the floor.'
    );
    process.exit(1);
  }
  if (faults.length) {
    console.error('README PROSE DRIFT:');
    for (const f of faults)
      console.error(`  [${f.kind}] ${f.figure} ${f.detail}`);
    console.error(
      '\nEither correct the sentence to the guarded table, or declare the figure in' +
        '\nDECLARED above with the source it actually came from.'
    );
    process.exit(1);
  }
  console.log('README PROSE AGREES with the guarded tables.');
}
