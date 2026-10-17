import { rehydrate } from '../../../src/compress/rehydrate.js';
import type { Stamp } from '../../../src/compress/types.js';

/**
 * Rebuild an elided JSON array from the two halves it was split into.
 *
 * THE INVARIANT THE OLD ASSERTIONS WERE PROTECTING, stated directly. Several
 * tests used to assert that the spill held every row, kept and dropped alike,
 * because a spill holding only the dropped tail gave a reader no offset to
 * apply. That is now the marker's job: it names where the kept rows sat, so
 * the two halves reassemble in order -- and asserting the reassembly is
 * strictly stronger than asserting the spill's contents, because it also
 * proves the half left in the request is intact and in the right places.
 *
 * Returns the spill parsed on its own when the marker names no positions,
 * which is the whole-array fallback and is still a complete recovery.
 *
 * THE SPILL IS DECODED FIRST. Row spills are written in the engine's exact
 * template encoding when that is smaller (src/compress/json.ts), so the rows
 * are read back through the shipped decoder under the result's own stamp --
 * the reader a fetched spill actually has -- before they are parsed. A spill
 * written verbatim has no marker and decodes to itself.
 */
export function decodeSpill(spilled: string, stamp: Stamp = null): string {
  return rehydrate(spilled, stamp);
}

export function reassemble(
  text: string,
  spilled: string,
  stamp: Stamp = null
): unknown[] {
  const dropped = JSON.parse(decodeSpill(spilled, stamp)) as unknown[];
  const at = text.indexOf('[... ');
  if (at < 0) throw new Error(`no elision marker in ${JSON.stringify(text)}`);
  // The marker was written where a row would have been, so the character
  // before it is the comma that separated it from the last kept row.
  const kept = JSON.parse(text.slice(0, at - 1) + ']') as unknown[];
  const end = text.indexOf(']', text.lastIndexOf(' -> '));
  const marker = text.slice(at, end + 1);

  const first = /the (\d+) rows? above are the first of (\d+)/.exec(marker);
  const named = /the \d+ rows? above were at index ([\d, ]+) of (\d+)/.exec(
    marker
  );
  if (!first && !named) return dropped;

  const total = Number((first ?? named)?.[2]);
  const keptAt = first
    ? kept.map((_row, i) => i)
    : (named?.[1] ?? '').split(',').map((s) => Number(s.trim()));
  if (keptAt.length !== kept.length)
    throw new Error(
      `marker names ${keptAt.length} positions for ${kept.length} kept rows`
    );

  const out: unknown[] = [];
  const held = new Set(keptAt);
  let nextKept = 0;
  let nextDropped = 0;
  for (let i = 0; i < total; i += 1)
    out.push(held.has(i) ? kept[nextKept++] : dropped[nextDropped++]);
  return out;
}
