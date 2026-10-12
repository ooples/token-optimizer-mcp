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
 * Smart chunking based on syntax boundaries
 */
export function chunkBySyntax(
  content: string,
  maxChunkSize: number = 4000
): ChunkResult {
  const sourceLines = content.split('\n');

  // A LINE LONGER THAN A CHUNK IS SPLIT ACROSS CHUNKS (#489 review). Chunks
  // break at lines, so one minified line used to be a single chunk of any
  // size: either over the limit the caller set, or -- once cut down to it --
  // a "chunk 1 of 1" whose remaining bytes no chunkIndex could reach. Each
  // full-size piece fills a chunk of its own, so no newline is invented inside
  // a chunk; a boundary between chunks never claims one. `lineOf` keeps the
  // metadata's line numbers those of the file.
  const size = Math.max(1, Math.floor(maxChunkSize));
  const lines: string[] = [];
  const lineOf: number[] = [];
  sourceLines.forEach((line, index) => {
    if (line.length <= size) {
      lines.push(line);
      lineOf.push(index);
      return;
    }
    for (let at = 0; at < line.length; at += size) {
      lines.push(line.slice(at, at + size));
      lineOf.push(index);
    }
  });

  const chunks: string[] = [];
  const metadata: ChunkMetadata[] = [];
  let currentChunk: string[] = [];
  let currentSize = 0;
  let startLine = 0;
  let chunkIndex = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineSize = line.length + 1; // +1 for newline

    // Check if adding this line would exceed the chunk size
    if (currentSize + lineSize > maxChunkSize && currentChunk.length > 0) {
      // Save current chunk
      const chunkContent = currentChunk.join('\n');
      chunks.push(chunkContent);
      metadata.push({
        index: chunkIndex++,
        startLine: lineOf[startLine],
        endLine: lineOf[i - 1],
        size: currentSize,
        type: detectLineType(currentChunk[0]),
      });

      // Start new chunk
      currentChunk = [line];
      currentSize = lineSize;
      startLine = i;
    } else {
      currentChunk.push(line);
      currentSize += lineSize;
    }
  }

  // Add remaining chunk
  if (currentChunk.length > 0) {
    const chunkContent = currentChunk.join('\n');
    chunks.push(chunkContent);
    metadata.push({
      index: chunkIndex,
      startLine: lineOf[startLine],
      endLine: sourceLines.length - 1,
      size: currentSize,
      type: detectLineType(currentChunk[0]),
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

/** The start and end of `content` by characters, joined by a marker, within `maxSize`. */
function headAndTail(content: string, maxSize: number): string {
  const room = maxSize - TRUNCATION_MARKER.length;
  if (room <= 0) return content.slice(0, Math.max(0, maxSize));
  const head = Math.ceil((room * 2) / 3);
  const tail = room - head;
  return (
    content.slice(0, head) +
    TRUNCATION_MARKER +
    (tail > 0 ? content.slice(-tail) : '')
  );
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

  if (content.length <= maxSize) {
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
  if (truncated.length > maxSize) {
    truncated = assembleKept(lines, new Set([...keep, ...bottom]));
  }
  if (truncated.length > maxSize) {
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
