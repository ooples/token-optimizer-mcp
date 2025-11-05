import { Tool, ToolInvocation } from '@microsoft/teams-ai';
import { TurnContext } from 'botbuilder';
import { SqliteOptimizationStorage } from '../analytics/optimization-storage';

export class OptimizationStorageTool implements Tool {
    private readonly storage: SqliteOptimizationStorage;

    constructor() {
        this.storage = new SqliteOptimizationStorage();
    }

    name = 'optimization_storage';
    description = 'A tool for storing and retrieving optimization results.';

    async invoke(context: TurnContext, invocation: ToolInvocation): Promise<any> {
        const { operation, originalTextHash, optimizedText } = invocation.data;

        switch (operation) {
            case 'store':
                if (!originalTextHash || !optimizedText) {
                    return { error: 'Missing required parameters for store operation.' };
                }
                await this.storage.save({
                    originalTextHash,
                    optimizedText: Buffer.from(optimizedText, 'base64'),
                    compressionAlgorithm: 'gzip',
                });
                return { success: true };
            case 'retrieve':
                if (!originalTextHash) {
                    return { error: 'Missing required parameters for retrieve operation.' };
                }
                const result = await this.storage.get(originalTextHash);
                if (result) {
                    return {
                        ...result,
                        optimizedText: result.optimizedText.toString('base64'),
                    };
                }
                return { success: false, message: 'No result found for the given hash.' };
            default:
                return { error: `Unknown operation: ${operation}` };
        }
    }
}
