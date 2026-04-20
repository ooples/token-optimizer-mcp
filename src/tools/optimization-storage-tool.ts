import { SqliteOptimizationStorage, OptimizationResult } from '../analytics/optimization-storage.js';

export type OptimizationStorageOperation = 'store' | 'retrieve';

export interface OptimizationStorageOptions {
    operation: OptimizationStorageOperation;
    originalTextHash?: string;
    optimizedText?: string;
    originalTokens?: number;
    optimizedTokens?: number;
    tokensSaved?: number;
}

export interface OptimizationStorageResponse {
    success: boolean;
    error?: string;
    result?: OptimizationResult;
}

export class OptimizationStorageTool {
    public readonly name = 'optimization_storage';
    public readonly description =
        'Persist and retrieve brotli-compressed optimization results keyed by text hash.';

    private readonly storage: SqliteOptimizationStorage;

    constructor(storage?: SqliteOptimizationStorage) {
        this.storage = storage ?? new SqliteOptimizationStorage();
        this.storage.initializeDatabase();
    }

    public run(options: OptimizationStorageOptions): OptimizationStorageResponse {
        switch (options.operation) {
            case 'store':
                return this.store(options);
            case 'retrieve':
                return this.retrieve(options);
            default:
                return {
                    success: false,
                    error: `Unknown operation: ${String((options as { operation: unknown }).operation)}`,
                };
        }
    }

    private store(options: OptimizationStorageOptions): OptimizationStorageResponse {
        const { originalTextHash, optimizedText, originalTokens, optimizedTokens, tokensSaved } = options;

        if (
            !originalTextHash ||
            !optimizedText ||
            originalTokens === undefined ||
            optimizedTokens === undefined ||
            tokensSaved === undefined
        ) {
            return {
                success: false,
                error: 'Missing required arguments for store operation: originalTextHash, optimizedText, originalTokens, optimizedTokens, tokensSaved.',
            };
        }

        try {
            this.storage.save({
                originalTextHash,
                optimizedText,
                originalTokens,
                optimizedTokens,
                tokensSaved,
            });
            return { success: true };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return { success: false, error: `Failed to store optimization result: ${message}` };
        }
    }

    private retrieve(options: OptimizationStorageOptions): OptimizationStorageResponse {
        const { originalTextHash } = options;

        if (!originalTextHash) {
            return {
                success: false,
                error: 'Missing required argument for retrieve operation: originalTextHash.',
            };
        }

        try {
            const result = this.storage.get(originalTextHash);
            if (!result) {
                return { success: false, error: 'Not found' };
            }
            return { success: true, result };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return { success: false, error: `Failed to retrieve optimization result: ${message}` };
        }
    }

    public close(): void {
        this.storage.close();
    }
}

export const OPTIMIZATION_STORAGE_TOOL_DEFINITION = {
    name: 'optimization_storage',
    description:
        'Persist and retrieve brotli-compressed optimization results keyed by text hash. Operations: store, retrieve.',
    // JSON Schema discriminated union — rejects a `store` payload that
    // omits required fields at schema time instead of deep in the tool.
    inputSchema: {
        type: 'object',
        oneOf: [
            {
                type: 'object',
                properties: {
                    operation: { type: 'string', const: 'store' },
                    originalTextHash: {
                        type: 'string',
                        minLength: 1,
                        description: 'Stable hash of the original uncompressed text',
                    },
                    optimizedText: {
                        type: 'string',
                        description: 'The optimized text to store',
                    },
                    originalTokens: {
                        type: 'number',
                        minimum: 0,
                        description: 'Token count of the original text',
                    },
                    optimizedTokens: {
                        type: 'number',
                        minimum: 0,
                        description: 'Token count after optimization',
                    },
                    tokensSaved: {
                        type: 'number',
                        description: 'Tokens saved by optimization',
                    },
                },
                required: [
                    'operation',
                    'originalTextHash',
                    'optimizedText',
                    'originalTokens',
                    'optimizedTokens',
                    'tokensSaved',
                ],
                additionalProperties: false,
            },
            {
                type: 'object',
                properties: {
                    operation: { type: 'string', const: 'retrieve' },
                    originalTextHash: {
                        type: 'string',
                        minLength: 1,
                        description: 'Stable hash of the original uncompressed text',
                    },
                },
                required: ['operation', 'originalTextHash'],
                additionalProperties: false,
            },
        ],
    },
};
