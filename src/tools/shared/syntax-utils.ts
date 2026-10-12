/**
 * Syntax-aware utilities for smart truncation and chunking
 */

export interface ChunkResult {
  chunks: string[];
  metadata: ChunkMetadata[];
  totalSize: number;
}

export interface ChunkMetadata {
  index: number;
  startLine: number;
  endLine: number;
  size: number;
  type:
    | 'code'
    | 'comment'
    | 'import'
    | 'export'
    | 'function'
    | 'class'
    | 'other';
}

export interface TruncationResult {
  truncated: string;
  original: string;
  removed: number;
  kept: number;
  compressionRatio: number;
}

/**
 * Detect file type from extension
 */
export function detectFileType(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() || '';
  const typeMap: Record<string, string> = {
    ts: 'typescript',
    tsx: 'typescript',
    js: 'javascript',
    jsx: 'javascript',
    py: 'python',
    go: 'go',
    rs: 'rust',
    java: 'java',
    cpp: 'cpp',
    c: 'c',
    h: 'c',
    json: 'json',
    md: 'markdown',
    yml: 'yaml',
    yaml: 'yaml',
  };
  return typeMap[ext] || 'text';
}

/**
 * SIZES ARE UTF-8 BYTES. `maxSize` is documented as a byte limit, and a
 * JavaScript string's length counts UTF-16 units: a line of CJK text or emoji
 * is up to twice as many bytes as its length says, so a reply sized by length
 * could exceed the budget it claimed to honour (#490 review). These measure
 * and cut in bytes, and only ever at a code-point boundary, so what they
 * return is always valid text.
 */
export function utf8Length(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

const codePointBytes = (codePoint: number): number =>
  codePoint < 0x80 ? 1 : codePoint < 0x800 ? 2 : codePoint < 0x10000 ? 3 : 4;

/** The longest prefix of `text` within `maxBytes` UTF-8 bytes. */
export function prefixWithinBytes(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  let bytes = 0;
  let end = 0;
  for (const char of text) {
    const size = codePointBytes(char.codePointAt(0) ?? 0);
    if (bytes + size > maxBytes) break;
    bytes += size;
    end += char.length;
  }
  return text.slice(0, end);
}

/** The longest suffix of `text` within `maxBytes` UTF-8 bytes. */
export function suffixWithinBytes(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  const chars = Array.from(text);
  let bytes = 0;
  let count = 0;
  for (let i = chars.length - 1; i >= 0; i--) {
    const size = codePointBytes(chars[i].codePointAt(0) ?? 0);
    if (bytes + size > maxBytes) break;
    bytes += size;
    count += chars[i].length;
  }
  return count > 0 ? text.slice(text.length - count) : '';
}

/** `text` cut into consecutive pieces of at most `maxBytes` UTF-8 bytes each. */
function splitWithinBytes(text: string, maxBytes: number): string[] {
  const pieces: string[] = [];
  let rest = text;
  while (rest.length > 0) {
    // A single code point wider than the budget still has to go somewhere.
    const piece = prefixWithinBytes(rest, maxBytes) || Array.from(rest)[0];
    pieces.push(piece);
    rest = rest.slice(piece.length);
  }
  return pieces;
}

/**
 * Split content into chunks of at most `maxChunkSize` UTF-8 bytes, at line
 * boundaries where a line fits.
 *
 * THE CHUNKS ARE THE FILE, CONCATENATED. Each line carries its own newline into
 * the chunk it ends in, counted in that chunk's size, so joining every chunk
 * gives back the file byte for byte -- a caller paging through it loses no
 * separator at a page boundary. Lines used to be joined inside a chunk and the
 * newline between two chunks was dropped, so `ABCD\nz` paged at 2 read back as
 * `ABCDz` (#489 review).
 *
 * A LINE LONGER THAN A CHUNK IS SPLIT ACROSS CHUNKS. One minified line used to
 * be a single chunk of any size: over the caller's limit, or -- once cut down
 * to it -- a "chunk 1 of 1" whose remaining bytes no chunkIndex could reach.
 * `lineOf` keeps the metadata's line numbers those of the file.
 */
export function chunkBySyntax(
  content: string,
  maxChunkSize: number = 4000
): ChunkResult {
  const sourceLines = content.split('\n');
  // In UTF-8 bytes, like maxSize (see utf8Length), and cut at code points.
  const size = Math.max(1, Math.floor(maxChunkSize));
  const pieces: string[] = [];
  const pieceBytes: number[] = [];
  const lineOf: number[] = [];
  sourceLines.forEach((line, index) => {
    const text = index < sourceLines.length - 1 ? `${line}\n` : line;
    const bytes = utf8Length(text);
    for (const piece of bytes <= size
      ? text
        ? [text]
        : []
      : splitWithinBytes(text, size)) {
      pieces.push(piece);
      pieceBytes.push(piece === text ? bytes : utf8Length(piece));
      lineOf.push(index);
    }
  });

  const chunks: string[] = [];
  const metadata: ChunkMetadata[] = [];
  let current: string[] = [];
  let currentSize = 0;
  let first = 0;

  const flush = (last: number) => {
    chunks.push(current.join(''));
    metadata.push({
      index: chunks.length - 1,
      startLine: lineOf[first],
      endLine: lineOf[last],
      size: currentSize,
      type: detectLineType(current[0]),
    });
  };

  pieces.forEach((piece, i) => {
    if (currentSize + pieceBytes[i] > size && current.length > 0) {
      flush(i - 1);
      current = [];
      currentSize = 0;
      first = i;
    }
    current.push(piece);
    currentSize += pieceBytes[i];
  });
  if (current.length > 0) flush(pieces.length - 1);
  // An empty file is one empty chunk, as it always was.
  if (chunks.length === 0) {
    chunks.push('');
    metadata.push({
      index: 0,
      startLine: 0,
      endLine: 0,
      size: 0,
      type: 'other',
    });
  }

  return {
    chunks,
    metadata,
    totalSize: content.length,
  };
}

/**
 * Detect the type of a line
 */
function detectLineType(line: string): ChunkMetadata['type'] {
  const trimmed = line.trim();

  if (
    trimmed.startsWith('//') ||
    trimmed.startsWith('#') ||
    trimmed.startsWith('/*')
  ) {
    return 'comment';
  }
  if (trimmed.startsWith('import ') || trimmed.startsWith('from ')) {
    return 'import';
  }
  if (trimmed.startsWith('export ')) {
    return 'export';
  }
  if (trimmed.includes('function ') || trimmed.includes('=>')) {
    return 'function';
  }
  if (trimmed.startsWith('class ')) {
    return 'class';
  }

  return 'other';
}

const TRUNCATION_MARKER = '\n// ... [truncated] ...\n';

/** The kept lines in file order, with a marker wherever lines were dropped. */
function assembleKept(lines: string[], kept: Set<number>): string {
  const parts: string[] = [];
  let previous = -1;
  for (const index of [...kept].sort((a, b) => a - b)) {
    if (index !== previous + 1) parts.push(TRUNCATION_MARKER);
    parts.push(lines[index]);
    previous = index;
  }
  if (previous < lines.length - 1) parts.push(TRUNCATION_MARKER);
  return parts.join('\n');
}

/** The start and end of `content`, joined by a marker, within `maxSize` UTF-8 bytes. */
function headAndTail(content: string, maxSize: number): string {
  const room = maxSize - utf8Length(TRUNCATION_MARKER);
  if (room <= 0) return prefixWithinBytes(content, maxSize);
  const head = prefixWithinBytes(content, Math.ceil((room * 2) / 3));
  const tail = suffixWithinBytes(
    content.slice(head.length),
    room - utf8Length(head)
  );
  return head + TRUNCATION_MARKER + tail;
}

/**
 * Truncate file content intelligently, keeping important parts
 */
export function truncateContent(
  content: string,
  maxSize: number,
  options: {
    keepTop?: number;
    keepBottom?: number;
    preserveStructure?: boolean;
  } = {}
): TruncationResult {
  const { keepTop = 100, keepBottom = 50, preserveStructure = true } = options;

  if (utf8Length(content) <= maxSize) {
    return {
      truncated: content,
      original: content,
      removed: 0,
      kept: content.length,
      compressionRatio: 1,
    };
  }

  const lines = content.split('\n');

  // LINES ARE CHOSEN BY POSITION AND KEPT IN FILE ORDER (#489). The structure
  // branch used to emit import/export and declaration lines, then the bottom,
  // and never the top -- so a Markdown file, a log or a CSV, which has none of
  // those lines, came back as its last fifty lines with its title gone. The
  // top is now always kept, structural lines past it are added, and a marker
  // stands in each gap, so the output reads in the order the file does.
  const keep = new Set<number>();
  for (let i = 0; i < Math.min(keepTop, lines.length); i++) keep.add(i);
  const bottom = new Set<number>();
  for (let i = Math.max(0, lines.length - keepBottom); i < lines.length; i++) {
    bottom.add(i);
  }

  const structural = new Set<number>();
  if (preserveStructure) {
    let declarations = 0;
    lines.forEach((line, i) => {
      const trimmed = line.trim();
      if (trimmed.startsWith('import ') || trimmed.startsWith('export ')) {
        structural.add(i);
      } else if (
        declarations < 20 && // the first 20 declarations
        (trimmed.startsWith('class ') ||
          trimmed.startsWith('interface ') ||
          trimmed.startsWith('type ') ||
          trimmed.startsWith('function ') ||
          trimmed.startsWith('const ') ||
          trimmed.startsWith('let '))
      ) {
        structural.add(i);
        declarations++;
      }
    });
  }

  let truncated = assembleKept(
    lines,
    new Set([...keep, ...structural, ...bottom])
  );

  // maxSize IS A LIMIT ON WHAT IS RETURNED, and nothing enforced it: a file of
  // export lines kept every line, and a hundred long top lines kept all of
  // them. Over budget, the structural lines go first; if the top and bottom
  // alone still overrun it, a head and tail of the file by characters remain,
  // so the top of the file is never what gets dropped.
  if (utf8Length(truncated) > maxSize) {
    truncated = assembleKept(lines, new Set([...keep, ...bottom]));
  }
  if (utf8Length(truncated) > maxSize) {
    truncated = headAndTail(content, maxSize);
  }

  return {
    truncated,
    original: content,
    removed: content.length - truncated.length,
    kept: truncated.length,
    compressionRatio: truncated.length / content.length,
  };
}

/**
 * Extract only changed sections from content
 */
export function extractChangedSections(
  content: string,
  lineNumbers: number[]
): string {
  const lines = content.split('\n');
  const contextLines = 3;
  const sections: string[] = [];

  // Group consecutive line numbers
  const groups: number[][] = [];
  let currentGroup: number[] = [];

  for (const lineNum of lineNumbers.sort((a, b) => a - b)) {
    if (
      currentGroup.length === 0 ||
      lineNum <= currentGroup[currentGroup.length - 1] + contextLines * 2
    ) {
      currentGroup.push(lineNum);
    } else {
      groups.push(currentGroup);
      currentGroup = [lineNum];
    }
  }
  if (currentGroup.length > 0) {
    groups.push(currentGroup);
  }

  // Extract sections with context
  for (const group of groups) {
    const start = Math.max(0, group[0] - contextLines);
    const end = Math.min(
      lines.length,
      group[group.length - 1] + contextLines + 1
    );

    sections.push(`Lines ${start + 1}-${end}:`);
    sections.push(lines.slice(start, end).join('\n'));
    sections.push('');
  }

  return sections.join('\n');
}

/**
 * Check if content is minified/compressed
 */
export function isMinified(content: string): boolean {
  const lines = content.split('\n');
  if (lines.length < 5) {
    // For files with very few lines, check if they're minified based on length and whitespace
    if (lines.length === 1 && lines[0].length > 500) return true;
    return false;
  }

  const avgLineLength = content.length / lines.length;
  const hasVeryLongLines = lines.some((l) => l.length > 500);
  const hasMinimalWhitespace =
    content.replace(/\s/g, '').length / content.length > 0.8;

  return avgLineLength > 200 || (hasVeryLongLines && hasMinimalWhitespace);
}
