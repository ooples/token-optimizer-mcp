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
  const lines = content.split('\n');
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
        startLine,
        endLine: i - 1,
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
      startLine,
      endLine: lines.length - 1,
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
  const topLines = lines.slice(0, keepTop);
  const bottomLines = lines.slice(-keepBottom);

  let truncated: string;

  if (preserveStructure) {
    // Keep imports, exports, and structure
    const importLines = lines.filter(
      (l) => l.trim().startsWith('import ') || l.trim().startsWith('export ')
    );
    const structureLines = lines.filter((l) => {
      const trimmed = l.trim();
      return (
        trimmed.startsWith('class ') ||
        trimmed.startsWith('interface ') ||
        trimmed.startsWith('type ') ||
        trimmed.startsWith('function ') ||
        trimmed.startsWith('const ') ||
        trimmed.startsWith('let ')
      );
    });

    const kept = [
      ...importLines,
      ...structureLines.slice(0, 20), // Keep first 20 structure elements
      '\n// ... [truncated] ...\n',
      ...bottomLines,
    ];

    truncated = kept.join('\n');
  } else {
    truncated = [
      ...topLines,
      '\n// ... [truncated] ...\n',
      ...bottomLines,
    ].join('\n');
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
