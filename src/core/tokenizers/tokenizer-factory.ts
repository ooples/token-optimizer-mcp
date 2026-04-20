import { ITokenizer } from './i-tokenizer.js';
import { TiktokenTokenizer } from './tiktoken-tokenizer.js';
import { HeuristicTokenizer } from './heuristic-tokenizer.js';

export class TokenizerFactory {
    /**
     * Create a tokenizer for the given model name.
     *
     * Resolution order:
     * 1. Tiktoken for GPT-4 / GPT-3.5-turbo / Claude-family models.
     * 2. HeuristicTokenizer as the content-aware fallback.
     *
     * Callers that already hold a tokenizer should prefer reusing it —
     * construction allocates a tiktoken encoder (native resource).
     */
    public static create(modelName: string): ITokenizer {
        if (TiktokenTokenizer.supports(modelName)) {
            return new TiktokenTokenizer(modelName);
        }
        return new HeuristicTokenizer(modelName);
    }

    /** Create a tokenizer using the active model environment variables. */
    public static createFromEnv(): ITokenizer {
        const modelName =
            process.env.CLAUDE_MODEL ||
            process.env.ANTHROPIC_MODEL ||
            process.env.OPENAI_MODEL ||
            process.env.TOKEN_OPTIMIZER_MODEL ||
            'gpt-4';
        return TokenizerFactory.create(modelName);
    }
}
