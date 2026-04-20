import { SessionManager } from '../core/session-manager.js';
import { calculateDelta } from '../utils/diff.js';

/**
 * context_delta MCP tool — addresses issue #122.
 *
 * Given (sessionId, filePath, currentContent) this tool:
 *   1. Looks up the session from the SessionManager.
 *   2. Diffs the current content against the session's last snapshot of
 *      that file.
 *   3. Updates the session's file state.
 *   4. Returns a unified-diff delta — the caller can send ONLY the delta
 *      to the model instead of the whole file, which is the token win.
 *
 * On first invocation for a given filePath the full content is treated
 * as "the delta" (there is no baseline to diff against).
 */

export type ContextDeltaOperation = 'compute-delta' | 'seed' | 'clear';

export interface ContextDeltaOptions {
    operation: ContextDeltaOperation;
    sessionId: string;
    filePath: string;
    currentContent?: string;
}

export interface ContextDeltaResponse {
    success: boolean;
    error?: string;
    delta?: string;
    isBaseline?: boolean;
    originalSize?: number;
    deltaSize?: number;
    bytesSaved?: number;
}

export class ContextDeltaTool {
    public readonly name = 'context_delta';
    public readonly description =
        'Compute a unified-diff delta between a file’s previous session snapshot and its current content, so the model only receives what changed.';

    constructor(private readonly sessionManager: SessionManager) {}

    public run(options: ContextDeltaOptions): ContextDeltaResponse {
        switch (options.operation) {
            case 'compute-delta':
                return this.computeDelta(options);
            case 'seed':
                return this.seed(options);
            case 'clear':
                return this.clear(options);
            default:
                return {
                    success: false,
                    error: `Unknown operation: ${String(
                        (options as { operation: unknown }).operation
                    )}`,
                };
        }
    }

    private computeDelta(options: ContextDeltaOptions): ContextDeltaResponse {
        const { sessionId, filePath, currentContent } = options;
        if (currentContent === undefined) {
            return {
                success: false,
                error: 'currentContent is required for compute-delta',
            };
        }
        // Auto-bootstrap the session on first contact so PS-side callers
        // that locally generate a sessionId don't have to separately
        // create it server-side first.
        const session = this.sessionManager.getOrCreateSession(sessionId);
        const previous = session.getFileContent(filePath);

        try {
            // Goes through SessionManager so the new state hits disk.
            this.sessionManager.updateFileState(sessionId, filePath, currentContent);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return { success: false, error: message };
        }

        // Use UTF-8 byte counts throughout so the reported sizes match
        // the byte-cap that SessionManager.updateFileState enforces.
        // string.length counts UTF-16 code units, which drifts for any
        // non-ASCII content.
        const originalSize = Buffer.byteLength(currentContent, 'utf8');
        if (previous === undefined) {
            return {
                success: true,
                isBaseline: true,
                delta: currentContent,
                originalSize,
                deltaSize: originalSize,
                bytesSaved: 0,
            };
        }

        const delta = calculateDelta(previous, currentContent, filePath);
        const deltaSize = Buffer.byteLength(delta, 'utf8');
        return {
            success: true,
            isBaseline: false,
            delta,
            originalSize,
            deltaSize,
            bytesSaved: Math.max(0, originalSize - deltaSize),
        };
    }

    private seed(options: ContextDeltaOptions): ContextDeltaResponse {
        const { sessionId, filePath, currentContent } = options;
        if (currentContent === undefined) {
            return { success: false, error: 'currentContent is required for seed' };
        }
        try {
            this.sessionManager.getOrCreateSession(sessionId);
            this.sessionManager.updateFileState(sessionId, filePath, currentContent);
            return { success: true, isBaseline: true };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return { success: false, error: message };
        }
    }

    private clear(options: ContextDeltaOptions): ContextDeltaResponse {
        try {
            this.sessionManager.clearFileState(options.sessionId, options.filePath);
            return { success: true };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return { success: false, error: message };
        }
    }
}

export const CONTEXT_DELTA_TOOL_DEFINITION = {
    name: 'context_delta',
    description:
        'Compute a unified-diff delta for a file in a given session so the model only sees changes since the last snapshot. Operations: compute-delta, seed, clear.',
    // Discriminated inputSchema keyed on `operation` — compute-delta and
    // seed require currentContent at runtime, so enforce that at schema
    // validation time rather than letting a malformed payload reach the
    // tool body.
    inputSchema: {
        type: 'object',
        oneOf: [
            {
                type: 'object',
                properties: {
                    operation: { type: 'string', const: 'compute-delta' },
                    sessionId: { type: 'string', minLength: 1 },
                    filePath: { type: 'string', minLength: 1 },
                    currentContent: { type: 'string' },
                },
                required: ['operation', 'sessionId', 'filePath', 'currentContent'],
                additionalProperties: false,
            },
            {
                type: 'object',
                properties: {
                    operation: { type: 'string', const: 'seed' },
                    sessionId: { type: 'string', minLength: 1 },
                    filePath: { type: 'string', minLength: 1 },
                    currentContent: { type: 'string' },
                },
                required: ['operation', 'sessionId', 'filePath', 'currentContent'],
                additionalProperties: false,
            },
            {
                type: 'object',
                properties: {
                    operation: { type: 'string', const: 'clear' },
                    sessionId: { type: 'string', minLength: 1 },
                    filePath: { type: 'string', minLength: 1 },
                },
                required: ['operation', 'sessionId', 'filePath'],
                additionalProperties: false,
            },
        ],
    },
};
