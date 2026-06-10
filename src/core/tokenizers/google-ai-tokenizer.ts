import { createHash } from 'crypto';
import { ITokenizer } from './i-tokenizer.js';
import { LruCache } from '../../utils/lru-cache.js';

const DEFAULT_CACHE_SIZE = 500;
const DEFAULT_CACHE_TTL_MS = 30 * 60 * 1000;
const DEFAULT_ENDPOINT =
  'https://generativelanguage.googleapis.com/v1beta/models';
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * Remote tokenizer that uses Google AI's countTokens REST endpoint —
 * addresses issue #124's GoogleAITokenizer requirement.
 *
 * Network calls are memoized in an LruCache with a TTL so repeated
 * token counts don't re-hit the API. If the request fails (network,
 * 4xx, 5xx) we surface the error to the caller — TokenCounter above
 * is responsible for deciding whether to fall back to a local
 * tokenizer.
 */
export class GoogleAITokenizer implements ITokenizer {
  public readonly modelName: string;
  private readonly apiKey: string;
  private readonly endpoint: string;
  private readonly cache: LruCache<string, number>;
  private readonly timeoutMs: number;

  constructor(
    modelName: string,
    apiKey: string,
    options: {
      endpoint?: string;
      cache?: LruCache<string, number>;
      timeoutMs?: number;
    } = {}
  ) {
    if (!apiKey) {
      throw new Error('GoogleAITokenizer requires an apiKey');
    }
    this.modelName = modelName;
    this.apiKey = apiKey;
    this.endpoint = options.endpoint ?? DEFAULT_ENDPOINT;
    this.cache =
      options.cache ??
      new LruCache<string, number>(DEFAULT_CACHE_SIZE, DEFAULT_CACHE_TTL_MS);
    this.timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  }

  public async countTokens(text: string): Promise<number> {
    // Always hash with a namespace prefix so cache keys can't collide
    // with a raw string arg and so sensitive user text isn't retained
    // verbatim in process memory.
    const key = `sha256:${createHash('sha256').update(text).digest('hex')}`;
    const cached = this.cache.get(key);
    if (cached !== undefined) {
      return cached;
    }

    // Per Gemini API reference, x-goog-api-key is the recommended
    // auth path — it keeps the key out of URLs and access logs.
    const url = `${this.endpoint}/${encodeURIComponent(
      this.modelName
    )}:countTokens`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': this.apiKey,
        },
        body: JSON.stringify({
          contents: [{ parts: [{ text }] }],
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        // Don't embed the response body — it can leak prompt
        // content in upstream logs.
        throw new Error(
          `Google AI countTokens failed: ${response.status} ${response.statusText}`
        );
      }

      const data = (await response.json()) as { totalTokens?: number };
      if (typeof data.totalTokens !== 'number') {
        throw new Error(
          `Google AI countTokens returned unexpected payload: ${JSON.stringify(data).slice(0, 200)}`
        );
      }
      this.cache.set(key, data.totalTokens);
      return data.totalTokens;
    } finally {
      clearTimeout(timeout);
    }
  }

  public free(): void {
    this.cache.clear();
  }
}
