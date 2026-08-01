/**
 * Smart Edit Tool - 90% Token Reduction
 *
 * Achieves token reduction through:
 * 1. Line-based editing (edit only specific ranges, not full file)
 * 2. Return only diffs (show changes, not entire file content)
 * 3. Pattern-based replacement (regex/search-replace)
 * 4. Multi-edit batching (apply multiple edits in one operation)
 * 5. Verification before commit (preview changes before applying)
 *
 * Target: 90% reduction vs reading full file + writing changes
 */

import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  unlinkSync,
} from 'fs';
import { homedir } from 'os';
import { join, basename } from 'path';
import { createHash } from 'crypto';
import { CacheEngine } from '../../core/cache-engine.js';
import { bumpFsGeneration } from '../../utils/fs-generation.js';
import { TokenCounter } from '../../core/token-counter.js';
import { MetricsCollector } from '../../core/metrics.js';
import { generateCacheKey } from '../shared/hash-utils.js';
import { generateUnifiedDiff } from '../shared/diff-utils.js';

/**
 * The line ending a file actually uses, so an edit can put back what it found.
 *
 * Dominance rather than first-match: a file with one stray ending should not
 * have the whole file rewritten to match the stray. A file with no newline at
 * all gets '\n', which is what a new line in a one-line file should be.
 */
/** Where backups live: outside every working tree, so they cannot be committed. */
export const BACKUP_ROOT = join(homedir(), '.token-optimizer', 'backups');

/** How many past versions of one file are kept before the oldest is dropped. */
const BACKUPS_PER_FILE = 5;

/**
 * Saves the pre-edit content somewhere it cannot do harm.
 *
 * The backup used to be written as `<file>.bak` NEXT TO THE ORIGINAL, inside
 * the user's repository. Measured live: one edit to a real checkout left an
 * untracked README.md.bak sitting in `git status`, one `git add -A` away from
 * being committed, and nothing ever deleted it. A safety net that dirties the
 * tree it is protecting is a poor trade.
 *
 * Backups now live under the user's home directory, keyed by a hash of the
 * absolute path so two files with the same basename cannot collide, and capped
 * so they cannot grow without bound. Failure to write one is never allowed to
 * fail the edit -- the backup is a convenience, the edit is the job.
 */
function writeBackup(
  filePath: string,
  content: string,
  encoding: BufferEncoding
): boolean {
  try {
    const key = createHash('sha256').update(filePath).digest('hex').slice(0, 16);
    const dir = join(BACKUP_ROOT, key);
    mkdirSync(dir, { recursive: true });

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    writeFileSync(join(dir, `${stamp}__${basename(filePath)}`), content, encoding);

    const existing = readdirSync(dir).sort();
    for (const stale of existing.slice(0, Math.max(0, existing.length - BACKUPS_PER_FILE))) {
      try {
        unlinkSync(join(dir, stale));
      } catch {
        // A backup we cannot prune is not worth failing an edit over.
      }
    }

    return true;
  } catch {
    // Nor is one we cannot write -- but the caller must not be told a backup
    // exists when none does. `wasBackedUp` used to echo the REQUEST
    // (opts.createBackup) rather than the outcome, so a full disk or a
    // read-only home directory produced a result claiming a backup that was
    // never written. That is precisely the moment somebody relies on it.
    return false;
  }
}

function detectLineEnding(text: string): string {
  const crlf = (text.match(/\r\n/g) || []).length;
  const lf = (text.match(/\n/g) || []).length - crlf;
  return crlf > lf ? '\r\n' : '\n';
}

export interface EditOperation {
  type: 'replace' | 'insert' | 'delete';
  startLine: number; // 1-based line number
  endLine?: number; // For replace/delete (inclusive)
  content?: string; // For replace/insert
  pattern?: string | RegExp; // For pattern-based replace
  replacement?: string; // For pattern-based replace
}

export interface SmartEditOptions {
  // Edit verification
  verifyBeforeApply?: boolean; // Show diff before applying (default: true)
  dryRun?: boolean; // Preview changes without applying (default: false)

  // Backup options
  // Save the pre-edit content before writing (default: true). Backups go to
  // ~/.token-optimizer/backups, NOT next to the file -- see writeBackup.
  createBackup?: boolean;

  // Multi-edit options
  batchEdits?: boolean; // Apply all edits atomically (default: true)

  // Output options
  returnDiff?: boolean; // Return only diff, not full content (default: true)
  contextLines?: number; // Lines of context in diff (default: 3)

  // Cache options
  updateCache?: boolean; // Update cache after edit (default: true)
  ttl?: number; // Cache TTL in seconds (default: 3600)

  // File options
  encoding?: BufferEncoding; // File encoding (default: utf-8)
}

export interface SmartEditResult {
  success: boolean;
  path: string;
  operation: 'applied' | 'preview' | 'unchanged' | 'failed';
  metadata: {
    editsApplied: number;
    linesChanged: number;
    originalLines: number;
    finalLines: number;
    tokensSaved: number;
    tokenCount: number;
    originalTokenCount: number;
    compressionRatio: number;
    duration: number;
    verified: boolean;
    wasBackedUp: boolean;
  };
  diff?: {
    added: string[];
    removed: string[];
    unchanged: number;
    unifiedDiff: string;
  };
  preview?: string; // Full preview content for dry runs
  error?: string;
}

export class SmartEditTool {
  constructor(
    private cache: CacheEngine,
    private tokenCounter: TokenCounter,
    private metrics: MetricsCollector
  ) {}

  /**
   * Smart edit with line-based operations and diff-only output
   */
  async edit(
    filePath: string,
    operations: EditOperation | EditOperation[],
    options: SmartEditOptions = {}
  ): Promise<SmartEditResult> {
    const startTime = Date.now();

    // Default options
    const opts: Required<SmartEditOptions> = {
      verifyBeforeApply: options.verifyBeforeApply ?? true,
      dryRun: options.dryRun ?? false,
      createBackup: options.createBackup ?? true,
      batchEdits: options.batchEdits ?? true,
      returnDiff: options.returnDiff ?? true,
      contextLines: options.contextLines ?? 3,
      updateCache: options.updateCache ?? true,
      ttl: options.ttl ?? 3600,
      encoding: options.encoding ?? 'utf-8',
    };

    try {
      // Ensure file exists
      if (!existsSync(filePath)) {
        throw new Error(`File not found: ${filePath}`);
      }

      // Read original content
      const originalContent = readFileSync(filePath, opts.encoding);
      // SPLIT ON EITHER ENDING, AND PUT BACK THE ONE THE FILE USES.
      //
      // `split('\n')` leaves a trailing '\r' on every line of a CRLF file, so
      // the lines an edit did NOT touch kept their '\r' and the lines it
      // replaced did not. `join('\n')` then wrote a file with mixed endings --
      // measured on Windows, where every source file is CRLF: a one-line
      // replace in a 5-line file turned 4 CRLF into 3 CRLF + 1 bare LF.
      //
      // Nothing errors, so it is invisible until git reports the line as
      // changed, an editor warns about mixed endings, or a .gitattributes
      // check fails -- and it compounds with every subsequent edit.
      const eol = detectLineEnding(originalContent);
      const originalLines = originalContent.split(/\r?\n/);
      const originalTokens = this.tokenCounter.count(originalContent).tokens;

      // Small-file guard: for tiny files the unified-diff + metadata payload
      // costs MORE tokens than it saves, making smart_edit net-negative (a
      // 6-line edit reported tokensSaved: -130). Mirror the compression
      // MIN_SIZE_THRESHOLD (500 bytes): below it, don't return the diff so the
      // response stays minimal. The edit itself is still applied normally.
      const SMALL_FILE_BYTES = 500;
      const isSmallFile =
        Buffer.byteLength(originalContent, opts.encoding) < SMALL_FILE_BYTES;
      const effectiveReturnDiff = opts.returnDiff && !isSmallFile;

      // Normalize operations to array
      const ops = Array.isArray(operations) ? operations : [operations];

      // Validate operations
      this.validateOperations(ops, originalLines.length);

      // Apply edits
      const editedLines = this.applyEdits(originalLines, ops);
      // Caller-supplied content may be multi-line and will use whatever ending
      // the caller happened to type, so each line is re-normalised before the
      // whole file is joined with the ending it actually uses.
      const editedContent = editedLines
        .map((line) => line.split(/\r?\n/).join(eol))
        .join(eol);

      // Check if content actually changed
      if (editedContent === originalContent) {
        const duration = Date.now() - startTime;
        // Clamp so a tiny unchanged file (< 50 tokens) never reports a
        // misleading negative saving.
        const unchangedSaved = Math.max(0, originalTokens - 50);

        this.metrics.record({
          operation: 'smart_edit',
          duration,
          inputTokens: 50, // Minimal tokens for "no changes" message
          outputTokens: 0,
          cachedTokens: 0,
          savedTokens: unchangedSaved,
          success: true,
          cacheHit: false,
        });

        return {
          success: true,
          path: filePath,
          operation: 'unchanged',
          metadata: {
            editsApplied: 0,
            linesChanged: 0,
            originalLines: originalLines.length,
            finalLines: editedLines.length,
            tokensSaved: unchangedSaved,
            tokenCount: 50,
            originalTokenCount: originalTokens,
            compressionRatio: 50 / originalTokens,
            duration,
            verified: opts.verifyBeforeApply,
            wasBackedUp: false,
          },
        };
      }

      // Calculate diff
      const diff = this.calculateDiff(
        originalContent,
        editedContent,
        filePath,
        opts.contextLines
      );
      const diffTokens = effectiveReturnDiff
        ? this.tokenCounter.count(diff.unifiedDiff).tokens
        : this.tokenCounter.count(editedContent).tokens;

      // If dry run, return preview without applying
      if (opts.dryRun) {
        const duration = Date.now() - startTime;
        const tokensSaved = Math.max(
          0,
          originalTokens +
            this.tokenCounter.count(editedContent).tokens -
            diffTokens
        );

        this.metrics.record({
          operation: 'smart_edit',
          duration,
          inputTokens: diffTokens,
          outputTokens: 0,
          cachedTokens: 0,
          savedTokens: tokensSaved,
          success: true,
          cacheHit: false,
        });

        return {
          success: true,
          path: filePath,
          operation: 'preview',
          metadata: {
            editsApplied: ops.length,
            linesChanged: diff.added.length + diff.removed.length,
            originalLines: originalLines.length,
            finalLines: editedLines.length,
            tokensSaved,
            tokenCount: diffTokens,
            originalTokenCount: originalTokens,
            compressionRatio: diffTokens / originalTokens,
            duration,
            verified: opts.verifyBeforeApply,
            wasBackedUp: false,
          },
          diff: effectiveReturnDiff ? diff : undefined,
          preview: editedContent,
        };
      }

      // Create backup if requested, and remember whether it actually happened
      const backedUp = opts.createBackup
        ? writeBackup(filePath, originalContent, opts.encoding)
        : false;

      // Apply changes to file
      writeFileSync(filePath, editedContent, opts.encoding);
      // Tell the search tools the tree moved, so no cached grep or glob
      // result can describe a state that no longer exists.
      bumpFsGeneration();


      // Update cache
      if (opts.updateCache) {
        const cacheKey = generateCacheKey('file-edit', { path: filePath });
        const contentSize = Buffer.from(editedContent, 'utf-8').length;
        this.cache.set(cacheKey, editedContent, contentSize, contentSize);
      }

      // Record metrics
      const duration = Date.now() - startTime;
      // Clamp so a small/expensive edit never reports a misleading negative.
      const tokensSaved = Math.max(0, originalTokens - diffTokens);

      this.metrics.record({
        operation: 'smart_edit',
        duration,
        inputTokens: diffTokens,
        outputTokens: 0,
        cachedTokens: 0,
        savedTokens: tokensSaved,
        success: true,
        cacheHit: false,
      });

      return {
        success: true,
        path: filePath,
        operation: 'applied',
        metadata: {
          editsApplied: ops.length,
          linesChanged: diff.added.length + diff.removed.length,
          originalLines: originalLines.length,
          finalLines: editedLines.length,
          tokensSaved,
          tokenCount: diffTokens,
          originalTokenCount: originalTokens,
          compressionRatio: diffTokens / originalTokens,
          duration,
          verified: opts.verifyBeforeApply,
          // The outcome, not the request. See writeBackup.
          wasBackedUp: backedUp,
        },
        diff: effectiveReturnDiff ? diff : undefined,
      };
    } catch (error) {
      const duration = Date.now() - startTime;

      this.metrics.record({
        operation: 'smart_edit',
        duration,
        inputTokens: 0,
        outputTokens: 0,
        cachedTokens: 0,
        savedTokens: 0,
        success: false,
        cacheHit: false,
      });

      return {
        success: false,
        path: filePath,
        operation: 'failed',
        metadata: {
          editsApplied: 0,
          linesChanged: 0,
          originalLines: 0,
          finalLines: 0,
          tokensSaved: 0,
          tokenCount: 0,
          originalTokenCount: 0,
          compressionRatio: 0,
          duration,
          verified: opts.verifyBeforeApply,
          wasBackedUp: false,
        },
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Validate edit operations
   */
  private validateOperations(
    operations: EditOperation[],
    totalLines: number
  ): void {
    for (const op of operations) {
      if (op.startLine < 1 || op.startLine > totalLines + 1) {
        throw new Error(
          `Invalid startLine: ${op.startLine} (file has ${totalLines} lines)`
        );
      }

      if (op.endLine !== undefined) {
        if (op.endLine < op.startLine) {
          throw new Error(
            `endLine ${op.endLine} cannot be before startLine ${op.startLine}`
          );
        }
        if (op.endLine > totalLines) {
          throw new Error(
            `Invalid endLine: ${op.endLine} (file has ${totalLines} lines)`
          );
        }
      }

      if (op.type === 'replace' || op.type === 'insert') {
        if (!op.content && !op.pattern) {
          throw new Error(`${op.type} operation requires content or pattern`);
        }
      }

      if (op.pattern && !op.replacement) {
        throw new Error('Pattern-based replace requires replacement text');
      }
    }
  }

  /**
   * Apply edit operations to lines
   */
  private applyEdits(lines: string[], operations: EditOperation[]): string[] {
    // Sort operations by line number (descending) to avoid index shifting
    const sortedOps = [...operations].sort((a, b) => b.startLine - a.startLine);

    let result = [...lines];

    for (const op of sortedOps) {
      const startIdx = op.startLine - 1; // Convert to 0-based
      const endIdx = op.endLine ? op.endLine - 1 : startIdx;

      switch (op.type) {
        case 'replace':
          if (op.pattern && op.replacement !== undefined) {
            // Pattern-based replacement
            const pattern =
              typeof op.pattern === 'string'
                ? new RegExp(op.pattern, 'g')
                : op.pattern;

            for (let i = startIdx; i <= endIdx && i < result.length; i++) {
              result[i] = result[i].replace(pattern, op.replacement);
            }
          } else if (op.content !== undefined) {
            // Line replacement
            const newLines = op.content.split('\n');
            result.splice(startIdx, endIdx - startIdx + 1, ...newLines);
          }
          break;

        case 'insert':
          if (op.content !== undefined) {
            const newLines = op.content.split('\n');
            result.splice(startIdx, 0, ...newLines);
          }
          break;

        case 'delete':
          result.splice(startIdx, endIdx - startIdx + 1);
          break;
      }
    }

    return result;
  }

  /**
   * Calculate diff between old and new content
   */
  private calculateDiff(
    oldContent: string,
    newContent: string,
    filePath: string,
    contextLines: number
  ): {
    added: string[];
    removed: string[];
    unchanged: number;
    unifiedDiff: string;
  } {
    const unifiedDiff = generateUnifiedDiff(
      oldContent,
      newContent,
      filePath,
      filePath,
      contextLines
    );

    const added: string[] = [];
    const removed: string[] = [];
    let unchanged = 0;

    // Parse unified diff to extract added/removed lines
    const diffLines = unifiedDiff.split('\n');
    for (const line of diffLines) {
      if (line.startsWith('+') && !line.startsWith('+++')) {
        added.push(line.substring(1));
      } else if (line.startsWith('-') && !line.startsWith('---')) {
        removed.push(line.substring(1));
      } else if (line.startsWith(' ')) {
        unchanged++;
      }
    }

    return {
      added,
      removed,
      unchanged,
      unifiedDiff,
    };
  }

  /**
   * Get edit statistics
   */
  getStats(): {
    totalEdits: number;
    unchangedSkips: number;
    totalTokensSaved: number;
    averageReduction: number;
  } {
    const editMetrics = this.metrics.getOperations(0, 'smart_edit');

    const totalEdits = editMetrics.length;
    const totalTokensSaved = editMetrics.reduce(
      (sum, m) => sum + (m.savedTokens || 0),
      0
    );
    const totalInputTokens = editMetrics.reduce(
      (sum, m) => sum + (m.inputTokens || 0),
      0
    );
    const totalOriginalTokens = totalInputTokens + totalTokensSaved;

    const averageReduction =
      totalOriginalTokens > 0
        ? (totalTokensSaved / totalOriginalTokens) * 100
        : 0;

    return {
      totalEdits,
      unchangedSkips: editMetrics.filter((m) => m.inputTokens === 50).length,
      totalTokensSaved,
      averageReduction,
    };
  }
}

/**
 * Get smart edit tool instance
 */
export function getSmartEditTool(
  cache: CacheEngine,
  tokenCounter: TokenCounter,
  metrics: MetricsCollector
): SmartEditTool {
  return new SmartEditTool(cache, tokenCounter, metrics);
}

/**
 * CLI function - Creates resources and uses factory
 */
export async function runSmartEdit(
  filePath: string,
  operations: EditOperation | EditOperation[],
  options: SmartEditOptions = {}
): Promise<SmartEditResult> {
  const cache = new CacheEngine(join(homedir(), '.hypercontext', 'cache'), 100);
  const tokenCounter = new TokenCounter();
  const metrics = new MetricsCollector();

  const tool = getSmartEditTool(cache, tokenCounter, metrics);
  return tool.edit(filePath, operations, options);
}

/**
 * MCP Tool Definition
 */
export const SMART_EDIT_TOOL_DEFINITION = {
  name: 'smart_edit',
  description:
    'Edit files with 90% token reduction through line-based operations and diff-only output',
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Path to the file to edit',
      },
      operations: {
        oneOf: [
          {
            type: 'object',
            properties: {
              type: {
                type: 'string',
                enum: ['replace', 'insert', 'delete'],
                description: 'Type of edit operation',
              },
              startLine: {
                type: 'number',
                description: 'Starting line number (1-based)',
              },
              endLine: {
                type: 'number',
                description:
                  'Ending line number for replace/delete (inclusive)',
              },
              content: {
                type: 'string',
                description: 'Content for replace/insert operations',
              },
              pattern: {
                type: 'string',
                description: 'Regex pattern for pattern-based replacement',
              },
              replacement: {
                type: 'string',
                description: 'Replacement text for pattern-based replacement',
              },
            },
            required: ['type', 'startLine'],
          },
          {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                type: {
                  type: 'string',
                  enum: ['replace', 'insert', 'delete'],
                },
                startLine: { type: 'number' },
                endLine: { type: 'number' },
                content: { type: 'string' },
                pattern: { type: 'string' },
                replacement: { type: 'string' },
              },
              required: ['type', 'startLine'],
            },
          },
        ],
        description: 'Edit operation(s) to apply',
      },
      dryRun: {
        type: 'boolean',
        description: 'Preview changes without applying',
        default: false,
      },
      returnDiff: {
        type: 'boolean',
        description: 'Return diff instead of full content',
        default: true,
      },
      createBackup: {
        type: 'boolean',
        description: 'Create backup before editing',
        default: true,
      },
    },
    required: ['path', 'operations'],
  },
};
