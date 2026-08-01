/**
 * Diff utilities for smart file operations
 * Provides efficient diff generation with token optimization
 */

import { diffLines, diffWords } from 'diff';

export interface DiffResult {
  added: string[];
  removed: string[];
  unchanged: number;
  totalLines: number;
  diffText: string;
  compressionRatio: number;
}

export interface DiffOptions {
  contextLines?: number;
  ignoreWhitespace?: boolean;
  wordLevel?: boolean;
}

/**
 * Generate a compact diff between two strings
 */
export function generateDiff(
  oldContent: string,
  newContent: string,
  options: DiffOptions = {}
): DiffResult {
  const {
    contextLines: _contextLines = 3,
    ignoreWhitespace = false,
    wordLevel = false,
  } = options;

  const diffs = wordLevel
    ? diffWords(oldContent, newContent)
    : diffLines(oldContent, newContent, { ignoreWhitespace });

  const added: string[] = [];
  const removed: string[] = [];
  let unchanged = 0;
  const diffParts: string[] = [];

  for (const part of diffs) {
    if (part.added) {
      added.push(part.value);
      diffParts.push(`+ ${part.value}`);
    } else if (part.removed) {
      removed.push(part.value);
      diffParts.push(`- ${part.value}`);
    } else {
      unchanged += part.count || 0;
    }
  }

  const totalLines = oldContent.split('\n').length;
  const diffText = diffParts.join('\n');
  const compressionRatio = diffText.length / newContent.length;

  return {
    added,
    removed,
    unchanged,
    totalLines,
    diffText,
    compressionRatio,
  };
}

/**
 * Generate a unified diff format with context
 */
export function generateUnifiedDiff(
  oldContent: string,
  newContent: string,
  oldPath: string,
  newPath: string,
  contextLines: number = 3
): string {
  const diffs = diffLines(oldContent, newContent);

  const result: string[] = [`--- ${oldPath}`, `+++ ${newPath}`];

  let oldLineNum = 1;
  let newLineNum = 1;
  let hunkLines: string[] = [];
  let hunkOldStart = 1;
  let hunkNewStart = 1;

  // CONTEXT IS BOUNDED, which is the whole difference between a diff and a copy
  // of the file. The parameter was named `_contextLines` and ignored, so every
  // unchanged line was emitted as context: editing 13 lines of a 750-line file
  // returned a 6,836-token "compact unified diff" and reported tokensSaved: 0.
  // smart_edit's entire promise is that it returns the change rather than
  // echoing the file, and on any file worth using it on, it did the opposite.
  //
  // Unchanged runs longer than 2*context are elided, keeping `contextLines` on
  // each side of the change and marking what was dropped.
  const context = Math.max(0, contextLines);

  for (const part of diffs) {
    const lines = part.value.split('\n');
    if (lines[lines.length - 1] === '') lines.pop();

    if (part.added) {
      for (const line of lines) {
        hunkLines.push(`+${line}`);
        newLineNum++;
      }
    } else if (part.removed) {
      for (const line of lines) {
        hunkLines.push(`-${line}`);
        oldLineNum++;
      }
    } else if (lines.length > context * 2 + 1) {
      // Keep the tail of this run as leading context for the next change, and
      // the head as trailing context for the previous one.
      //
      // `slice(-context)` is wrong at context 0: -0 === 0, so it becomes
      // slice(0) -- the WHOLE run. Asking for no context therefore emitted
      // every unchanged line plus an elision marker claiming they had been
      // elided, which is both larger than the unabridged diff and untrue about
      // what it contains. The worse the run, the worse the blow-up.
      const head = context > 0 ? lines.slice(0, context) : [];
      const tail = context > 0 ? lines.slice(-context) : [];
      for (const line of head) hunkLines.push(` ${line}`);
      hunkLines.push(`@@ ${lines.length - context * 2} unchanged lines @@`);
      for (const line of tail) hunkLines.push(` ${line}`);
      oldLineNum += lines.length;
      newLineNum += lines.length;
    } else {
      for (const line of lines) {
        hunkLines.push(` ${line}`);
        oldLineNum++;
        newLineNum++;
      }
    }
  }

  if (hunkLines.length > 0) {
    const hunkHeader = `@@ -${hunkOldStart},${oldLineNum - 1} +${hunkNewStart},${newLineNum - 1} @@`;
    result.push(hunkHeader);
    result.push(...hunkLines);
  }

  return result.join('\n');
}

/**
 * Check if content has meaningful changes (ignores whitespace-only changes)
 */
export function hasMeaningfulChanges(
  oldContent: string,
  newContent: string
): boolean {
  const oldNormalized = oldContent.replace(/\s+/g, ' ').trim();
  const newNormalized = newContent.replace(/\s+/g, ' ').trim();
  return oldNormalized !== newNormalized;
}

/**
 * Apply a diff to reconstruct the new content
 */
export function applyDiff(originalContent: string, diffText: string): string {
  const lines = diffText.split('\n');
  const result: string[] = [];
  const originalLines = originalContent.split('\n');
  let originalIndex = 0;

  for (const line of lines) {
    if (line.startsWith('+')) {
      result.push(line.substring(1).trim());
    } else if (line.startsWith('-')) {
      originalIndex++;
    } else {
      if (originalIndex < originalLines.length) {
        result.push(originalLines[originalIndex]);
        originalIndex++;
      }
    }
  }

  return result.join('\n');
}

/**
 * Calculate similarity ratio between two strings (0-1)
 */
export function calculateSimilarity(str1: string, str2: string): number {
  if (str1 === str2) return 1;
  if (!str1 || !str2) return 0;

  const longer = str1.length > str2.length ? str1 : str2;
  const shorter = str1.length > str2.length ? str2 : str1;

  if (longer.length === 0) return 1;

  const editDistance = levenshteinDistance(longer, shorter);
  return (longer.length - editDistance) / longer.length;
}

/**
 * Calculate Levenshtein distance between two strings
 */
function levenshteinDistance(str1: string, str2: string): number {
  const matrix: number[][] = [];

  for (let i = 0; i <= str2.length; i++) {
    matrix[i] = [i];
  }

  for (let j = 0; j <= str1.length; j++) {
    matrix[0][j] = j;
  }

  for (let i = 1; i <= str2.length; i++) {
    for (let j = 1; j <= str1.length; j++) {
      if (str2.charAt(i - 1) === str1.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j] + 1
        );
      }
    }
  }

  return matrix[str2.length][str1.length];
}
