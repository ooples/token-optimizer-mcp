import { createHash } from 'crypto';
import { ITokenizer } from './i-tokenizer.js';
import { LruCache } from '../../utils/lru-cache.js';

const DEFAULT_CACHE_SIZE = 500;
const DEFAULT_CACHE_TTL_MS = 30 * 60 * 1000;
/** See TiktokenTokenizer for rationale. */
const KEY_HASH_THRESHOLD_CHARS = 256;

function cacheKeyFor(text: string): string {
    if (text.length <= KEY_HASH_THRESHOLD_CHARS) {
        return text;
    }
    return createHash('sha256').update(text).digest('hex');
}

export enum ContentType {
    Code = 'code',
    Json = 'json',
    Markdown = 'markdown',
    Text = 'text',
}

/**
 * Content-aware character-to-token ratios derived from tiktoken encoding
 * on typical samples:
 *
 * | Content   | chars/token |
 * | --------- | ----------- |
 * | code      | 2.5         |
 * | json      | 2.8         |
 * | markdown  | 3.5         |
 * | text      | 4.0         |
 */
const CHARS_PER_TOKEN: Readonly<Record<ContentType, number>> = {
    [ContentType.Code]: 2.5,
    [ContentType.Json]: 2.8,
    [ContentType.Markdown]: 3.5,
    [ContentType.Text]: 4.0,
};

const CODE_PATTERN = /\b(function|class|const|import|export|return|await|=>)\b/;
const JSON_PATTERN = /^[\s\n]*[{[]/;
const MARKDOWN_PATTERN = /^#{1,6}\s|^\s*[-*+]\s|\[[^\]]+\]\([^)]+\)/m;

export class HeuristicTokenizer implements ITokenizer {
    public readonly modelName: string;
    private readonly cache: LruCache<string, number>;

    constructor(modelName: string = 'heuristic', cache?: LruCache<string, number>) {
        this.modelName = modelName;
        this.cache = cache ?? new LruCache<string, number>(DEFAULT_CACHE_SIZE, DEFAULT_CACHE_TTL_MS);
    }

    public async countTokens(text: string): Promise<number> {
        const key = cacheKeyFor(text);
        const cached = this.cache.get(key);
        if (cached !== undefined) {
            return cached;
        }
        const contentType = HeuristicTokenizer.detectContentType(text);
        const ratio = CHARS_PER_TOKEN[contentType];
        const count = Math.ceil(text.length / ratio);
        this.cache.set(key, count);
        return count;
    }

    public free(): void {
        // No native resources to free.
    }

    public static detectContentType(text: string): ContentType {
        if (JSON_PATTERN.test(text)) {
            try {
                JSON.parse(text);
                return ContentType.Json;
            } catch {
                // Not actually JSON; fall through to other detection.
            }
        }
        if (CODE_PATTERN.test(text)) {
            return ContentType.Code;
        }
        if (MARKDOWN_PATTERN.test(text)) {
            return ContentType.Markdown;
        }
        return ContentType.Text;
    }
}
