/**
 * Reading a line-delimited log without loading it.
 *
 * A session file on a working machine can be hundreds of megabytes -- the largest
 * on the machine this was written on is 204MB -- so nothing here reads a whole
 * file, and the read it does make does not block the process making it. The head
 * goes into a fixed buffer and the last partial line is dropped, because half a JSON object parses as nothing and a caller that did not
 * know it was truncated would report a clean pass over a file it barely opened.
 */

import { open, stat } from 'node:fs/promises';

/** How much of one session file is read when a caller does not say. */
export const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;

export interface HeadResult {
  readonly lines: readonly string[];
  /** True when the file was longer than the budget. */
  readonly truncated: boolean;
}

/** Read up to `maxBytes` of a file and split it into whole lines. */
export async function readJsonlHead(
  path: string,
  maxBytes = DEFAULT_MAX_BYTES
): Promise<HeadResult> {
  const size = (await stat(path)).size;
  const want = Math.min(size, maxBytes);
  if (want === 0) return { lines: [], truncated: false };
  const buffer = Buffer.allocUnsafe(want);
  const handle = await open(path, 'r');
  let read = 0;
  try {
    while (read < want) {
      const { bytesRead } = await handle.read(buffer, read, want - read, read);
      if (bytesRead === 0) break;
      read += bytesRead;
    }
  } finally {
    await handle.close();
  }
  const truncated = size > want;
  const text = buffer.subarray(0, read).toString('utf8');
  const lines = text.split('\n');
  // The last line of a truncated read is a fragment. The last line of a complete
  // read is usually empty. Either way it is not a record.
  if (truncated || lines[lines.length - 1] === '') lines.pop();
  return { lines, truncated };
}

/** Parse a line, or return null. A corrupt line is one lost record, not a crash. */
export function parseLine(line: string): Record<string, unknown> | null {
  if (line.length === 0 || line.charCodeAt(0) !== 123) return null;
  try {
    const value: unknown = JSON.parse(line);
    return typeof value === 'object' && value !== null
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Flatten whatever a log put where text belongs into one string. */
export function textOf(value: unknown, limit = 64 * 1024): string {
  if (typeof value === 'string') return value.slice(0, limit);
  if (Array.isArray(value)) {
    const parts: string[] = [];
    let total = 0;
    for (const item of value) {
      const part = textOf(item, limit - total);
      if (part.length === 0) continue;
      parts.push(part);
      total += part.length;
      if (total >= limit) break;
    }
    return parts.join('\n');
  }
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    for (const key of ['text', 'content', 'output', 'message', 'stdout']) {
      if (key in record) return textOf(record[key], limit);
    }
  }
  return '';
}

/** A string field, or ''. */
export function stringField(
  record: Record<string, unknown>,
  key: string
): string {
  const value = record[key];
  return typeof value === 'string' ? value : '';
}

/** A nested record, or null. */
export function recordField(
  record: Record<string, unknown>,
  key: string
): Record<string, unknown> | null {
  const value = record[key];
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
