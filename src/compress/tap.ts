/** Compact consecutive Node TAP records without discarding a value.
 * Every failure keeps its own row; only byte-identical diagnostics share a template.
 */
import type { CompressionResult, Elision, Stamp } from './types.js';
import { unchanged } from './types.js';
import { stampFor } from './annotate.js';

export function looksLikeTap(text: string): boolean {
  return /^# Subtest: .+\r?\n(?:not )?ok \d+ - /m.test(text);
}

/**
 * THE ENVELOPE CARRIES AN AUTHENTICATOR, for the reason the `[... ` families
 * do: without one, a `[TAP ok records: ...]` line that arrived in the content
 * reached `rehydrate` as an `unconsumed marker` and cost the caller the whole
 * block. Handed nothing, this mints its own and returns it on the result.
 */
export function compressTap(text: string, stamp?: Stamp): CompressionResult {
  const tag = stamp === undefined ? stampFor(text) : stamp;
  const suffix = tag === null ? '' : ` ~${tag}`;
  // Match only the exact Node leaf-test grammar; names, IDs, duration text and
  // newline style all survive. Different diagnostics or status break the group.
  const record =
    /^# Subtest: ([^\r\n]+)(\r?\n)(not )?ok (\d+) - \1\2  ---\2  duration_ms: (\d+(?:\.\d+)?)\2  type: 'test'\2((?:(?: {2}[^\r\n]*|)\2)*?)  \.\.\.(?:\2|$)/gm;
  const matches = [...text.matchAll(record)].filter(
    (m) => !/\{(?:name|id|ms)\}/.test(m[6])
  );
  const elisions: Elision[] = [];
  let result = '',
    cursor = 0;
  for (let i = 0; i < matches.length; ) {
    const first = matches[i];
    let end = i + 1;
    while (
      end < matches.length &&
      matches[end].index ===
        matches[end - 1].index! + matches[end - 1][0].length &&
      matches[end][2] === first[2] &&
      matches[end][3] === first[3] &&
      matches[end][6] === first[6] &&
      matches[end - 1][0].endsWith(first[2])
    )
      end++;
    const group = matches.slice(i, end);
    const last = group[group.length - 1];
    const stop = last.index! + last[0].length;
    const original = text.slice(first.index, stop);
    const nl = first[2];
    const status = first[3] ? 'failing' : 'passing';
    const template = `# Subtest: {name}${nl}${first[3] || ''}ok {id} - {name}${nl}  ---${nl}  duration_ms: {ms}${nl}  type: 'test'${nl}${first[6]}  ...${nl}`;
    // A missing final newline uses a separate template; leave that final record
    // untouched rather than silently adding a byte during reconstruction.
    if (group.length >= 2 && last[0].endsWith(nl)) {
      const compact =
        `[TAP ${status} records: JSON rows [name,id,ms]; substitute into template ${JSON.stringify(template)}${suffix}]${nl}` +
        group.map((m) => JSON.stringify([m[1], m[4], m[5]])).join(nl) +
        `${nl}[/TAP ${status} records${suffix}]${nl}`;
      if (compact.length < original.length) {
        result += text.slice(cursor, first.index) + compact;
        cursor = stop;
        elisions.push({
          removed: `${group.length} ${status} TAP records represented by an exact template and rows`,
          recoverAt: null,
          lossless: true,
        });
      }
    }
    i = end;
  }
  return elisions.length
    ? {
        text: result + text.slice(cursor),
        elisions,
        lossless: true,
        stamp: tag,
      }
    : unchanged(text);
}
