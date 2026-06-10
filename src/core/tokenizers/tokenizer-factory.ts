import { ITokenizer } from './i-tokenizer.js';
import { TiktokenTokenizer } from './tiktoken-tokenizer.js';
import { HeuristicTokenizer } from './heuristic-tokenizer.js';
import { GoogleAITokenizer } from './google-ai-tokenizer.js';

/**
 * Pluggable tokenizer factory — addresses issues #123 / #124.
 *
 * Resolution order:
 *   1. Google AI models (`gemini-*`) — GoogleAITokenizer when
 *      GOOGLE_AI_API_KEY is set, else HeuristicTokenizer.
 *   2. Tiktoken-compatible families (GPT, Claude) — TiktokenTokenizer.
 *   3. HeuristicTokenizer fallback for everything else.
 *
 * Instances are cached per model name so callers don't pay for repeated
 * allocation of the native tiktoken encoder, and so their per-tokenizer
 * LRU caches can be shared across call sites.
 */
export class TokenizerFactory {
  private static readonly instances = new Map<string, ITokenizer>();

  public static create(modelName: string): ITokenizer {
    const cached = TokenizerFactory.instances.get(modelName);
    if (cached) {
      return cached;
    }
    const tokenizer = TokenizerFactory.build(modelName);
    TokenizerFactory.instances.set(modelName, tokenizer);
    return tokenizer;
  }

  public static createFromEnv(): ITokenizer {
    // TOKEN_OPTIMIZER_MODEL has highest precedence so a user can pin
    // the optimizer model without having to clear broader env vars
    // (CLAUDE_MODEL, ANTHROPIC_MODEL, …) that may already be set.
    const modelName =
      process.env.TOKEN_OPTIMIZER_MODEL ||
      process.env.CLAUDE_MODEL ||
      process.env.ANTHROPIC_MODEL ||
      process.env.OPENAI_MODEL ||
      process.env.GOOGLE_AI_MODEL ||
      'gpt-4';
    return TokenizerFactory.create(modelName);
  }

  /**
   * Release every cached tokenizer. Call this on server shutdown so
   * native tiktoken encoders are freed.
   */
  public static disposeAll(): void {
    for (const tokenizer of TokenizerFactory.instances.values()) {
      try {
        tokenizer.free();
      } catch {
        // Ignore — best-effort cleanup.
      }
    }
    TokenizerFactory.instances.clear();
  }

  private static build(modelName: string): ITokenizer {
    const lower = modelName.toLowerCase();
    if (lower.startsWith('gemini') || lower.includes('google')) {
      const apiKey = process.env.GOOGLE_AI_API_KEY;
      if (apiKey) {
        return new GoogleAITokenizer(modelName, apiKey);
      }
      return new HeuristicTokenizer(modelName);
    }
    if (TiktokenTokenizer.supports(modelName)) {
      return new TiktokenTokenizer(modelName);
    }
    return new HeuristicTokenizer(modelName);
  }
}
