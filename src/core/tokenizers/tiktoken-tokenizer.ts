import { createHash } from 'crypto';
import { encoding_for_model, Tiktoken, TiktokenModel } from 'tiktoken';
import { ITokenizer } from './i-tokenizer.js';
import { LruCache } from '../../utils/lru-cache.js';

const DEFAULT_CACHE_SIZE = 500;
const DEFAULT_CACHE_TTL_MS = 30 * 60 * 1000;
/**
 * Strings longer than this are hashed before being used as a cache key
 * so the LRU stores ~64-byte SHA-256 digests instead of entire prompts
 * or file contents — keeps the cache from ballooning into hundreds of
 * MB on hot paths.
 */
const KEY_HASH_THRESHOLD_CHARS = 256;

function cacheKeyFor(text: string): string {
  if (text.length <= KEY_HASH_THRESHOLD_CHARS) {
    return text;
  }
  return createHash('sha256').update(text).digest('hex');
}

const SUPPORTED_TIKTOKEN_MODELS: readonly TiktokenModel[] = [
  'gpt-4',
  'gpt-3.5-turbo',
];

export class TiktokenTokenizer implements ITokenizer {
  public readonly modelName: string;
  private readonly encoder: Tiktoken;
  private readonly cache: LruCache<string, number>;

  constructor(modelName: string, cache?: LruCache<string, number>) {
    this.modelName = modelName;
    this.cache =
      cache ??
      new LruCache<string, number>(DEFAULT_CACHE_SIZE, DEFAULT_CACHE_TTL_MS);
    const tiktokenModel = TiktokenTokenizer.mapToTiktokenModel(modelName);
    this.encoder = encoding_for_model(tiktokenModel);
  }

  public async countTokens(text: string): Promise<number> {
    const key = cacheKeyFor(text);
    const cached = this.cache.get(key);
    if (cached !== undefined) {
      return cached;
    }
    const count = this.encoder.encode(text).length;
    this.cache.set(key, count);
    return count;
  }

  public free(): void {
    this.encoder.free();
  }

  public static supports(modelName: string): boolean {
    const mapped = TiktokenTokenizer.tryMap(modelName);
    return mapped !== null;
  }

  public static mapToTiktokenModel(modelName: string): TiktokenModel {
    const mapped = TiktokenTokenizer.tryMap(modelName);
    if (mapped === null) {
      // Default: GPT-4 tokenizer is the closest available for Claude/unknown models.
      return 'gpt-4';
    }
    return mapped;
  }

  private static tryMap(modelName: string): TiktokenModel | null {
    const lower = modelName.toLowerCase();
    if (
      lower.includes('claude') ||
      lower.includes('sonnet') ||
      lower.includes('opus') ||
      lower.includes('haiku') ||
      lower.includes('gpt-4')
    ) {
      return 'gpt-4';
    }
    if (lower.includes('gpt-3.5') || lower.includes('gpt3.5')) {
      return 'gpt-3.5-turbo';
    }
    if (SUPPORTED_TIKTOKEN_MODELS.includes(lower as TiktokenModel)) {
      return lower as TiktokenModel;
    }
    return null;
  }
}
