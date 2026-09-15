/** Preserve truncated JSON as truncated, while templating complete flat records.
 * Never repairs a missing range, infers a missing value, or discards a visible one.
 */
import type { CompressionResult, Elision } from './types.js';
import { unchanged } from './types.js';

export function looksLikeJsonFragments(text: string): boolean {
  return (
    /^Warning: truncated output\b/.test(text) &&
    /\d+ tokens truncated/.test(text) &&
    /^\s*\[\s*$/m.test(text)
  );
}

interface RecordParts {
  start: number;
  end: number;
  chunks: string[];
  values: string[];
  shape: string;
}
function records(text: string): RecordParts[] {
  const result: RecordParts[] = [];
  // An interrupted object may match through the truncation marker. JSON.parse
  // rejects it; the original bytes stay in the gap between valid records.
  const object = /^([ \t]+)\{\r?\n[\s\S]*?^\1\},?(?:\r?\n|$)/gm;
  for (const match of text.matchAll(object)) {
    const raw = match[0];
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(raw.trim().replace(/,$/, ''));
    } catch {
      continue;
    }
    if (
      !parsed ||
      Array.isArray(parsed) ||
      Object.values(parsed).some((v) => v !== null && typeof v === 'object')
    )
      continue;
    const field =
      /"(?:\\.|[^"\\])*"\s*:\s*("(?:\\.|[^"\\])*"|true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;
    const chunks: string[] = [],
      values: string[] = [];
    let cursor = 0;
    for (const value of raw.matchAll(field)) {
      const start = value.index! + value[0].length - value[1].length;
      chunks.push(raw.slice(cursor, start));
      values.push(value[1]);
      cursor = start + value[1].length;
    }
    if (!values.length || values.length !== Object.keys(parsed).length)
      continue;
    chunks.push(raw.slice(cursor));
    result.push({
      start: match.index!,
      end: match.index! + raw.length,
      chunks,
      values,
      shape: JSON.stringify(chunks),
    });
  }
  return result;
}

export function compressJsonFragments(text: string): CompressionResult {
  if (!looksLikeJsonFragments(text)) return unchanged(text);
  const found = records(text),
    elisions: Elision[] = [];
  let result = '',
    cursor = 0;
  for (let i = 0; i < found.length; ) {
    const first = found[i];
    let end = i + 1;
    while (
      end < found.length &&
      found[end].start === found[end - 1].end &&
      found[end].shape === first.shape
    )
      end++;
    const group = found.slice(i, end),
      stop = group[group.length - 1].end;
    if (group.length >= 3) {
      const varying = first.values.map((value, col) =>
        group.some((row) => row.values[col] !== value)
      );
      const template: (string | number)[] = [],
        columns: number[] = [];
      let literal = first.chunks[0];
      first.values.forEach((value, col) => {
        if (varying[col]) {
          template.push(literal, columns.length);
          columns.push(col);
          literal = '';
        } else literal += value;
        literal += first.chunks[col + 1];
      });
      template.push(literal);
      const compact =
        '[JSON fragment records; missing records remain unknown. Join template parts, replacing numeric slots with raw JSON lexemes from each row. Template: ' +
        JSON.stringify(template) +
        ']\n' +
        group
          .map((row) => JSON.stringify(columns.map((col) => row.values[col])))
          .join('\n') +
        '\n[/JSON fragment records]\n';
      if (compact.length < stop - first.start) {
        result += text.slice(cursor, first.start) + compact;
        cursor = stop;
        elisions.push({
          removed: `${group.length} complete records within truncated JSON represented by exact template and rows`,
          recoverAt: null,
          lossless: true,
        });
      }
    }
    i = end;
  }
  return elisions.length
    ? { text: result + text.slice(cursor), elisions, lossless: true }
    : unchanged(text);
}
