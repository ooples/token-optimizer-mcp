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
        const session = this.sessionManager.getSession(sessionId);
        if (!session) {
            return { success: false, error: `Unknown session: ${sessionId}` };
        }
        const previous = session.getFileContent(filePath);
        session.setFileContent(filePath, currentContent);

        if (previous === undefined) {
            return {
                success: true,
                isBaseline: true,
                delta: currentContent,
                originalSize: currentContent.length,
                deltaSize: currentContent.length,
                bytesSaved: 0,
            };
        }

        const delta = calculateDelta(previous, currentContent, filePath);
        return {
            success: true,
            isBaseline: false,
            delta,
            originalSize: currentContent.length,
            deltaSize: delta.length,
            bytesSaved: Math.max(0, currentContent.length - delta.length),
        };
    }

    private seed(options: ContextDeltaOptions): ContextDeltaResponse {
        const { sessionId, filePath, currentContent } = options;
        if (currentContent === undefined) {
            return { success: false, error: 'currentContent is required for seed' };
        }
        try {
            this.sessionManager.updateFileState(sessionId, filePath, currentContent);
            return { success: true, isBaseline: true };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return { success: false, error: message };
        }
    }

    private clear(options: ContextDeltaOptions): ContextDeltaResponse {
        const session = this.sessionManager.getSession(options.sessionId);
        if (!session) {
            return {
                success: false,
                error: `Unknown session: ${options.sessionId}`,
            };
        }
        session.setFileContent(options.filePath, '');
        return { success: true };
    }
}

export const CONTEXT_DELTA_TOOL_DEFINITION = {
    name: 'context_delta',
    description:
        'Compute a unified-diff delta for a file in a given session so the model only sees changes since the last snapshot. Operations: compute-delta, seed, clear.',
    inputSchema: {
        type: 'object',
        properties: {
            operation: {
                type: 'string',
                enum: ['compute-delta', 'seed', 'clear'],
                description: 'Operation to perform',
            },
            sessionId: {
                type: 'string',
                description: 'Session identifier (create one via SessionManager first)',
            },
            filePath: {
                type: 'string',
                description: 'Path of the file inside the session state',
            },
            currentContent: {
                type: 'string',
                description:
                    'Current file content (required for compute-delta and seed)',
            },
        },
        required: ['operation', 'sessionId', 'filePath'],
    },
};
