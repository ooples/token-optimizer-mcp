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

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { CacheEngine } from '../../core/cache-engine.js';
import { bumpFsGeneration } from '../../utils/fs-generation.js';
import { writeBackup } from '../../utils/file-backup.js';
import { TokenCounter } from '../../core/token-counter.js';
import { MetricsCollector } from '../../core/metrics.js';
import { generateCacheKey, lastWrittenKey } from '../shared/hash-utils.js';
import { cacheSet } from '../../utils/cache-helper.js';
import { generateUnifiedDiff } from '../shared/diff-utils.js';

// Backups live in utils/file-backup.ts, shared with smart_write. They were
// implemented here only, so smart_write went on writing `<file>.bak` into the
// user's working tree long after the defect was understood and fixed here.
// Re-exported because tests and callers already import BACKUP_ROOT from this
// module.
export { BACKUP_ROOT } from '../../utils/file-backup.js';

/**
 * The line ending a file actually uses, so an edit can put back what it found.
 *
 * Dominance rather than first-match: a file with one stray ending should not
 * have the whole file rewritten to match the stray. A file with no newline at
 * all gets '\n', which is what a new line in a one-line file should be.
 */

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

/**
 * Coerce whatever arrived as `operations` into an array of operation objects.
 *
 * WHY A STRING IS ACCEPTED HERE. `operations` is the only input on this tool
 * declared as a bare `oneOf` (object OR array) with no top-level `type`, and a
 * client that decides how to serialise a value from its declared type has
 * nothing to go on -- so the array arrives as JSON TEXT. `Array.isArray` is
 * then false, the string gets wrapped as `[theString]`, and validation refuses
 * it with `Invalid operation type: undefined`, because a string is not an
 * object. Reproduced 2026-08-28 with a schema-valid payload:
 *
 *     operations: [{ "type": "replace", "startLine": 1, "endLine": 1,
 *                    "content": "x" }]          -> Invalid operation type: undefined
 *     operations: {  "type": "replace", ... }   -> applied
 *
 * A single object binds; the array form does not. That made every multi-edit
 * call fail while single edits worked, which reads as a broken tool rather than
 * a marshalling quirk.
 *
 * Parsing here rather than tightening the schema, because the schema is not
 * wrong -- both shapes are genuinely accepted -- and because this keeps working
 * whatever any given client does with a `oneOf`. Anything that is not valid
 * JSON is passed through untouched, so validateOperations still produces its
 * own precise error rather than a parse failure.
 */
export function normalizeOperations(
  operations: EditOperation | EditOperation[] | string
): EditOperation[] {
  let value: unknown = operations;

  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      // Not JSON: leave it, and let validateOperations name the real problem.
    }
  }

  return Array.isArray(value)
    ? (value as EditOperation[])
    : ([value] as EditOperation[]);
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
    //  is real: see normalizeOperations for why the array form can
    // arrive as JSON text.
    operations: EditOperation | EditOperation[] | string,
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
      // THE REAL LINE COUNT, which is not `originalLines.length`.
      //
      // Splitting content that ends with a newline leaves a trailing empty
      // element -- a 10-line file yields 11 -- and that number was both reported
      // to the caller and used to validate their operations. So the tool
      // advertised a line that does not exist and then accepted a `replace`
      // against it: measured, that returned success with verified: true,
      // appended the content, and destroyed the file's trailing newline.
      //
      // The split array itself is left alone: the edit machinery rebuilds the
      // content by joining it, and dropping the element would silently strip
      // the trailing newline from every file it touches.
      const countLines = (text: string): number => {
        const parts = text.split(/\r?\n/);
        const trailing =
          text.length > 0 && text.charCodeAt(text.length - 1) === 10;
        return trailing ? Math.max(0, parts.length - 1) : parts.length;
      };
      const lineCount = countLines(originalContent);
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

      const ops = normalizeOperations(operations);

      // Validate operations
      this.validateOperations(ops, lineCount);

      // Apply edits
      const { lines: editedLines, applied } = this.applyEdits(
        originalLines,
        ops
      );
      // Caller-supplied content may be multi-line and will use whatever ending
      // the caller happened to type, so each line is re-normalised before the
      // whole file is joined with the ending it actually uses.
      const editedContent = editedLines
        .map((line) => line.split(/\r?\n/).join(eol))
        .join(eol);

      // THE SAME RULE ON BOTH SIDES OF THE REPORT.
      //
      // `originalLines` counts logical lines, so `finalLines` must too.
      // `editedLines.length` counts array elements, which still include the
      // trailing empty one, so an ordinary edit to a ten-line file reported
      // `originalLines: 10, finalLines: 11` -- a caller reading those two numbers
      // sees a line appear out of an edit that added none, and the metadata is
      // the only thing it has to go on, because the file contents are exactly
      // what smart_edit exists not to return.
      //
      // Derived from the CONTENT rather than the array for the same reason the
      // original count is: the array is a join artefact, the content is the file.
      const finalLines = countLines(editedContent);

      // Check if content actually changed
      if (editedContent === originalContent) {
        const duration = Date.now() - startTime;
        // Clamp so a tiny unchanged file (< 50 tokens) never reports a
        // misleading negative saving.
        const unchangedSaved = Math.max(0, originalTokens - 50);

        // Decided ONCE and reused by both the metrics record and the returned
        // result. Computing it twice let the two disagree: the metrics call
        // still recorded success: true for a run the caller was told had
        // failed, so the very failure this change surfaces would have been
        // invisible in the tool's own analytics.
        const unchangedIsSuccess = ops.length === 0 || applied > 0;

        this.metrics.record({
          operation: 'smart_edit',
          duration,
          inputTokens: 50, // Minimal tokens for "no changes" message
          outputTokens: 0,
          cachedTokens: 0,
          savedTokens: unchangedSaved,
          success: unchangedIsSuccess,
          cacheHit: false,
        });

        return {
          // NOT unconditionally true. "The content is identical" has two very
          // different causes: every operation ran and happened to reproduce what
          // was already there (a genuine no-op, success), or NOTHING ran at all
          // (a failure the caller must see). Reporting both as success with
          // editsApplied: 0 made a silently-dropped edit indistinguishable from
          // an idempotent one -- observed live, where a two-operation call
          // returned success with the file untouched and no error anywhere.
          success: unchangedIsSuccess,
          path: filePath,
          operation: 'unchanged',
          error:
            ops.length > 0 && applied === 0
              ? `none of the ${ops.length} requested operation(s) were applied and the file is unchanged`
              : undefined,
          metadata: {
            editsApplied: applied,
            linesChanged: 0,
            originalLines: lineCount,
            finalLines,
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
            editsApplied: applied,
            linesChanged: diff.added.length + diff.removed.length,
            originalLines: lineCount,
            finalLines,
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
      //
      // ISOLATED, BECAUSE THE WRITE ABOVE ALREADY HAPPENED. This ran inside the
      // method's single try/catch, so a cache failure after a successful write
      // was reported as `success: false, operation: 'failed', editsApplied: 0`
      // while the file on disk was already edited. Observed live: the SQLite
      // cache returned "database or disk is full" and smart_edit reported a
      // failed edit it had in fact completed.
      //
      // The caller's only sane response to a reported failure is to retry, and
      // retrying a LINE-BASED edit against an already-edited file corrupts it.
      // A refreshed cache is a nicety; a truthful report of what happened to
      // the file is not.
      if (opts.updateCache) {
        try {
          const cacheKey = generateCacheKey('file-edit', { path: filePath });
          const contentSize = Buffer.from(editedContent, 'utf-8').length;
          this.cache.set(cacheKey, editedContent, contentSize, contentSize);

          // The entry above is a THIRD namespace no reader consults, stored raw
          // where readers expect base64 gzip -- the same shape of gap smart_write
          // had. This is the handoff the reader actually looks for, so a read
          // after an edit reports the edit instead of resending the file.
          cacheSet(this.cache, lastWrittenKey(filePath), editedContent);
        } catch {
          // The edit stands. The next read simply misses the cache.
        }
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
          editsApplied: applied,
          linesChanged: diff.added.length + diff.removed.length,
          originalLines: lineCount,
          finalLines,
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
    const KNOWN = new Set(['replace', 'insert', 'delete']);

    for (const op of operations) {
      // A MALFORMED OPERATION IS REFUSED, NOT IGNORED.
      //
      // Every check below reads fields off `op`, and `undefined < 1` and
      // `undefined > 11` are both false -- so an object that is not an operation
      // at all passed validation untouched, reached `applyEdits`, matched no
      // branch of its switch, and came back as "unchanged, nothing applied".
      //
      // That is not hypothetical. The tests written for this very defect called
      // `edit(path, { operations: [...] })` when the signature is
      // `edit(path, operations, options)`, so every one of them handed this
      // function a single `{ operations: [...] }` object. They passed -- the file
      // really was untouched and the call really did report failure -- while
      // exercising none of the behaviour they named. The operations reaching this
      // tool come from a JSON boundary, so a caller can make the same mistake.
      if (!op || typeof op !== 'object' || !KNOWN.has(op.type)) {
        throw new Error(
          `Invalid operation type: ${JSON.stringify(op?.type)} (expected replace, insert or delete)`
        );
      }
      if (!Number.isInteger(op.startLine)) {
        throw new Error(
          `Invalid startLine: ${JSON.stringify(op.startLine)} (expected a 1-based integer line number)`
        );
      }

      // ONE PAST THE END IS AN `insert` POSITION, AND ONLY THAT.
      //
      // `totalLines + 1` names the point after the last line, which is where an
      // append goes -- a real and necessary operation. It does not name a line,
      // so nothing can be replaced or deleted there.
      //
      // The array being edited still carries the trailing empty element left by
      // splitting content that ends with a newline, so `replace` and `delete` at
      // that index did not fail: they hit the phantom. Measured on a 10-line
      // file, both returned success with `verified: true` and both stripped the
      // file's trailing newline -- `replace` by appending its content past the
      // last line, `delete` by removing the separator itself.
      const maxStart = op.type === 'insert' ? totalLines + 1 : totalLines;
      if (op.startLine < 1 || op.startLine > maxStart) {
        throw new Error(
          op.type === 'insert'
            ? `Invalid startLine: ${op.startLine} (file has ${totalLines} lines; insert accepts up to ${maxStart})`
            : `Invalid startLine: ${op.startLine} (file has ${totalLines} lines; only insert may address line ${totalLines + 1})`
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
   * Apply edit operations to lines.
   *
   * TWO DEFECTS LIVED HERE, and they compounded into one another.
   *
   * The pattern replace ran per LINE (`result[i].replace(...)`), so any pattern
   * containing a newline could never match anything -- the text it was written
   * against did not exist on any single line. The replace is now applied to the
   * JOINED range, which is what a caller passing a multi-line pattern already
   * believes is happening.
   *
   * And a pattern that matched nothing was silently ignored: the edit returned
   * success with `editsApplied: 0` and `operation: 'unchanged'`, which is
   * indistinguishable from "your edit was a legitimate no-op". A caller whose
   * regex was subtly wrong got told it worked. Unmatched patterns now throw,
   * which the caller renders as `operation: 'failed'` with the offending
   * patterns named.
   *
   * The throw is deliberately all-or-nothing. If three patterns are supplied
   * and one misses, applying the other two leaves the file in a state the
   * caller never asked for and did not expect -- worse than doing nothing.
   *
   * Note this is only about PATTERN operations. A line-based edit whose content
   * happens to equal what was already there is a genuine no-op and still
   * returns success/unchanged.
   */
  private applyEdits(
    lines: string[],
    operations: EditOperation[]
  ): { lines: string[]; applied: number } {
    // Sort operations by line number (descending) to avoid index shifting
    const sortedOps = [...operations].sort((a, b) => b.startLine - a.startLine);

    // Only ever mutated through splice, never reassigned.
    const result = [...lines];
    const unmatched: string[] = [];

    // How many operations actually EXECUTED, which is not the same as how many
    // were requested. An operation can decline to run -- a pattern that matches
    // nothing, a replace with neither pattern nor content -- and the caller has
    // no way to tell that from a successful edit unless the count is real.
    let applied = 0;

    for (const op of sortedOps) {
      const startIdx = op.startLine - 1; // Convert to 0-based
      const endIdx = op.endLine ? op.endLine - 1 : startIdx;

      switch (op.type) {
        case 'replace':
          if (op.pattern && op.replacement !== undefined) {
            const pattern =
              typeof op.pattern === 'string'
                ? new RegExp(op.pattern, 'g')
                : op.pattern;

            const lastIdx = Math.min(endIdx, result.length - 1);
            if (startIdx < 0 || startIdx > lastIdx) {
              unmatched.push(String(op.pattern));
              break;
            }

            // Joined, so a pattern spanning lines can match. Splitting the
            // result back means a replacement may legitimately change the line
            // count, which the per-line version could not express either.
            const target = result.slice(startIdx, lastIdx + 1).join('\n');

            // ASK WHETHER IT MATCHED, don't infer it from the output changing.
            // Comparing `replaced === target` conflated two different things: a
            // pattern that never matched, and one that matched but whose
            // replacement reproduced the same text. Measured: replacing
            // `const a = 1;` with itself, and a `$1 $2` capture-group rebuild,
            // both matched and both were reported as "matched nothing" -- so an
            // idempotent edit failed the whole operation.
            //
            // Tested on a fresh regex: a /g pattern carries lastIndex between
            // calls, so probing with the same object would make the result
            // depend on what was tested before it.
            const probe =
              typeof op.pattern === 'string'
                ? new RegExp(op.pattern)
                : new RegExp(
                    op.pattern.source,
                    op.pattern.flags.replace('g', '')
                  );

            if (!probe.test(target)) {
              unmatched.push(String(op.pattern));
              break;
            }

            const replaced = target.replace(pattern, op.replacement);

            result.splice(
              startIdx,
              lastIdx - startIdx + 1,
              ...replaced.split('\n')
            );
            applied += 1;
          } else if (op.content !== undefined) {
            // Line replacement
            const newLines = op.content.split('\n');
            result.splice(startIdx, endIdx - startIdx + 1, ...newLines);
            applied += 1;
          }
          break;

        case 'insert':
          if (op.content !== undefined) {
            const newLines = op.content.split('\n');
            result.splice(startIdx, 0, ...newLines);
            applied += 1;
          }
          break;

        case 'delete': {
          // COUNT ONLY WHAT WAS ACTUALLY REMOVED. splice past the end of the
          // array removes nothing and throws nothing, so an out-of-range delete
          // would otherwise be counted as applied -- reintroducing, for this one
          // operation, exactly the "it says it worked and nothing happened"
          // failure this change exists to remove.
          const removed = result.splice(startIdx, endIdx - startIdx + 1);
          if (removed.length > 0) {
            applied += 1;
          }
          break;
        }
      }
    }

    if (unmatched.length > 0) {
      const list = unmatched.map((p) => JSON.stringify(p)).join(', ');
      throw new Error(
        `Pattern matched nothing, so no edit was made: ${list}. ` +
          `The requested line range is searched as a whole, so a pattern may span lines; ` +
          `check for escaping, or use a line-based edit with \`content\` instead.`
      );
    }

    return { lines: result, applied };
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
  operations: EditOperation | EditOperation[] | string,
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
      // DECLARED BECAUSE THEY ARE ACCEPTED: the server spreads the caller's whole
      // argument object into options, so these worked while being undiscoverable.
      verifyBeforeApply: {
        type: 'boolean',
        description:
          'Re-read and verify the target lines still match before writing',
        default: true,
      },
      batchEdits: {
        type: 'boolean',
        description:
          'Apply all operations in one pass rather than one at a time',
        default: true,
      },
      contextLines: {
        type: 'number',
        description: 'Lines of context around each change in the returned diff',
        default: 3,
      },
      updateCache: {
        type: 'boolean',
        description: 'Refresh this file in the read cache after editing',
        default: true,
      },
      ttl: {
        type: 'number',
        description: 'Cache lifetime in seconds for the refreshed entry',
        default: 300,
      },
      encoding: {
        type: 'string',
        description: 'File encoding used to read and write the file',
        default: 'utf-8',
      },
    },
    required: ['path', 'operations'],
  },
};
