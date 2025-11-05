import { Tool, ToolInvocation, TurnContext } from '../types/turn-context';
import { SqliteOptimizationStorage, OptimizationResult } from '../analytics/optimization-storage';

export class OptimizationStorageTool implements Tool {
    public readonly name = 'optimization_storage';
    public readonly description = 'A tool for storing and retrieving compressed optimization results.';

    private storage: SqliteOptimizationStorage;

    constructor() {
        this.storage = new SqliteOptimizationStorage();
        this.storage.initializeDatabase();
    }

    public async invoke(context: TurnContext, invocation: ToolInvocation): Promise<any> {
        const operation = invocation.arguments?.operation;

        if (operation === 'store') {
            return this.store(invocation.arguments);
        } else if (operation === 'retrieve') {
            return this.retrieve(invocation.arguments);
        } else {
            return { error: `Unknown operation: ${operation}` };
        }
    }

    private async store(args: any): Promise<any> {
        try {
            const { originalTextHash, optimizedText, originalTokens, optimizedTokens, tokensSaved } = args;
            if (!originalTextHash || !optimizedText || originalTokens === undefined || optimizedTokens === undefined || tokensSaved === undefined) {
                return { error: 'Missing required arguments for store operation.' };
            }

            const optimizationResult: OptimizationResult = {
                originalTextHash,
                optimizedText: Buffer.from(optimizedText, 'base64').toString('utf8'),
                originalTokens,
                optimizedTokens,
                tokensSaved
            };

            await this.storage.save(optimizationResult);
            return { success: true };
        } catch (error) {
            return { error: `Failed to store optimization result: ${error.message}` };
        }
    }

    private async retrieve(args: any): Promise<any> {
        try {
            const { originalTextHash } = args;
            if (!originalTextHash) {
                return { error: 'Missing required argument for retrieve operation: originalTextHash' };
            }

            const result = await this.storage.get(originalTextHash);

            if (result) {
                return {
                    success: true,
                    ...result,
                    optimizedText: Buffer.from(result.optimizedText, 'utf8').toString('base64')
                };
            } else {
                return { success: false, message: 'Not found' };
            }
        } catch (error) {
            return { error: `Failed to retrieve optimization result: ${error.message}` };
        }
    }
}
