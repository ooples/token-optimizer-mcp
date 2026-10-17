/**
 * Regenerate the README's HeadRoom table from the recorded head-to-head run.
 *
 *   node bench/compression/readme-headroom.render.mjs
 *
 * The block between HEADROOM-TABLE:START and HEADROOM-TABLE:END said "do not
 * hand-edit", and was hand-edited anyway, because nothing wrote it: three
 * re-records later it described a run from 2026-09-25 (#505). This writes it,
 * and readme-headroom.check.mjs -- now in CI -- refuses a README that disagrees
 * with the record, so the two cannot drift apart again without a red build.
 *
 * Every figure is copied from the record as formatted there; nothing is
 * recomputed, so the check compares text against text.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { COLUMNS } from './readme-headroom.columns.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const README = join(here, '..', '..', 'README.md');
const RECORD = join(here, 'headroom', 'results', 'head-to-head.json');

const START = '<!-- HEADROOM-TABLE:START';
const END = '<!-- HEADROOM-TABLE:END -->';

const record = JSON.parse(readFileSync(RECORD, 'utf8'));
const header = COLUMNS.map((c) => c.header);
const right = COLUMNS.map((c) => c.right);
const rows = record.workloads.map((w) => COLUMNS.map((c) => c.cell(w)));

const width = header.map((h, c) =>
  Math.max(h.length, ...rows.map((r) => r[c].length))
);
const cell = (text, c) =>
  right[c] ? text.padStart(width[c]) : text.padEnd(width[c]);
const line = (cells) => `| ${cells.map(cell).join(' | ')} |`;
const rule = `| ${width
  .map((w, c) => (right[c] ? '-'.repeat(w - 1) + ':' : '-'.repeat(w)))
  .join(' | ')} |`;

const block = [
  `${START} -- every figure below must appear in`,
  '     `bench/compression/headroom/results/head-to-head.json`. Written by',
  '     `node bench/compression/readme-headroom.render.mjs` and guarded by',
  '     `node bench/compression/readme-headroom.check.mjs`; do not hand-edit.',
  '     Each figure cell is `characters / tokens` removed, tokens counted by',
  "     Anthropic's tokenizer over both arms' real output. `zero-turn ids` is",
  '     `ours / theirs / preset`: of the identifiers planted in that workload,',
  '     how many the agent can have without spending a turn -- in the text, or',
  '     rebuilt from the text alone.',
  '     -->',
  '',
  line(header),
  rule,
  ...rows.map(line),
  '',
  `Recorded ${record.recordedAt} at \`${record.commit.slice(0, 8)}\`, by the command in the`,
  "record's `regenerate` field, over HeadRoom " +
    `${record.capture?.theirsProvenance?.headroomVersion ?? '(unrecorded version)'}` +
    "'s own fixtures and harness. That arm runs",
  'HeadRoom itself, so CI does not re-derive it -- it checks these figures and',
  'this provenance against the record instead.',
  '',
  END,
].join('\n');

const readme = readFileSync(README, 'utf8');
const eol = readme.includes('\r\n') ? '\r\n' : '\n';
const from = readme.indexOf(START);
const to = readme.indexOf(END);
if (from === -1 || to === -1 || to < from) {
  console.error(
    'readme-headroom.render: HEADROOM-TABLE markers not found in README.md'
  );
  process.exit(1);
}
const next =
  readme.slice(0, from) +
  block.replace(/\n/g, eol) +
  readme.slice(to + END.length);
writeFileSync(README, next);
console.log(
  `readme-headroom.render: ${rows.length} rows from the record of ${record.recordedAt} (${record.commit.slice(0, 8)})`
);
