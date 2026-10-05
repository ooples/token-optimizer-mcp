/**
 * Rows the lossless encoders cannot fold away, for the tests that are about
 * ELISION.
 *
 * The uniform `rows(n)` fixtures elsewhere in this directory differ only in an
 * index, so `compressJsonArray` templates all sixty of them into one pattern
 * plus a column of numbers -- losslessly, with no spill and no retrieval. That
 * is the better answer and the engine now gives it, which leaves a test that
 * asserts a marker asserting the absence of a good outcome. These rows carry
 * independent text in every field, the way a search result or a log row does,
 * so no template collapses them and the elision path is the one under test.
 */
const WORDS = [
  'deploy',
  'rollback',
  'cache',
  'index',
  'shard',
  'token',
  'budget',
  'router',
  'probe',
  'spill',
  'digest',
  'anchor',
];

export interface VariedRow {
  readonly id: string;
  readonly score: number;
  readonly title: string;
  readonly snippet: string;
}

export function variedRows(n: number): VariedRow[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `doc_${i}`,
    score: Number((0.31 + ((i * 37) % 61) / 100).toFixed(3)),
    title: `${WORDS[i % WORDS.length]} ${WORDS[(i * 7) % WORDS.length]} ${
      WORDS[(i * 5) % WORDS.length]
    } for run ${1000 + i * 13}`,
    snippet: `at ${String(i).padStart(4, '0')} the ${
      WORDS[(i * 3) % WORDS.length]
    } step read ${100 + i * 7} rows from ${WORDS[(i * 11) % WORDS.length]}-${
      i % 9
    } and wrote ${WORDS[(i * 2) % WORDS.length]}_${i * 3}.json`,
  }));
}

/**
 * The same rows spelled by hand, so the source keeps lexemes `JSON.stringify`
 * would never write -- `1.0` stays `1.0` instead of parsing to `1`.
 */
export function variedRowsSource(n: number): string {
  return `[${variedRows(n)
    .map(
      (r) =>
        `{"id":"${r.id}","score":${r.score},"ratio":1.0,"title":"${r.title}","snippet":"${r.snippet}"}`
    )
    .join(',')}]`;
}
