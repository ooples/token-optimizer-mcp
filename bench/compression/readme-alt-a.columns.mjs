/**
 * What each column of the README's Alternative A table publishes, as one map that
 * both the renderer and the check read.
 *
 * The check used to accept a figure found ANYWHERE in its row of the record, so
 * a cell under the wrong column passed -- agent-loop published its preset
 * figures under `ours` for weeks. Closing that needed a column-header-to-field
 * map, and this is it: readme-alt-a.render.mjs writes each cell from here and
 * readme-alt-a.check.mjs requires each cell to equal what this says.
 */

const pair = (chars, tokens) =>
  chars === null || chars === undefined ? 'n/a' : `${chars} / ${tokens}`;

/** @type {{ header: string, right: boolean, cell: (w: any) => string }[]} */
export const COLUMNS = [
  { header: 'workload', right: false, cell: (w) => w.name },
  {
    header: 'payload',
    right: true,
    cell: (w) => Number(w.payload).toLocaleString('en-US'),
  },
  {
    header: 'theirs',
    right: true,
    cell: (w) => pair(w.chars.theirs, w.tokens.theirs),
  },
  {
    header: 'ours',
    right: true,
    cell: (w) => pair(w.chars.ours, w.tokens.ours),
  },
  {
    header: 'ours, proxy',
    right: true,
    cell: (w) => pair(w.chars.body, w.tokens.body),
  },
  {
    header: 'ours, preset',
    right: true,
    cell: (w) => pair(w.chars.preset, w.tokens.preset),
  },
  {
    header: 'zero-turn ids',
    right: true,
    cell: (w) =>
      `${w.retention.oursZeroTurn} / ${w.retention.theirsZeroTurn} / ${w.retention.presetZeroTurn}`,
  },
];
