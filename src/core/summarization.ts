import { Message } from './session.js';

/**
 * Pluggable summarization — part of issue #121.
 *
 * An ISummarizer implementation takes a list of Messages and returns a
 * natural-language summary. We ship three implementations out of the box:
 *
 *   - TruncatingSummarizer — self-contained, zero deps. Concatenates
 *     role:content and trims to `maxChars`. Useful for tests and for
 *     users who don't want to hand a foundation model every
 *     conversation turn.
 *   - AnthropicSummarizer — calls /v1/messages on api.anthropic.com.
 *     Needs ANTHROPIC_API_KEY. Used when the host wires it up.
 *   - GoogleAISummarizer — calls generativelanguage.googleapis.com.
 *     Needs GOOGLE_AI_API_KEY.
 *
 * Selection lives in `createSummarizerFromEnv()` below — the server
 * picks the highest-fidelity summarizer whose credentials are available
 * and falls back to TruncatingSummarizer otherwise.
 */

const SUMMARY_SYSTEM_PROMPT =
    'You are summarizing the early portion of a conversation so the rest can continue without the full history in context. ' +
    'Produce a concise summary (at most ~300 tokens) that preserves decisions made, outstanding TODOs, and any concrete facts the assistant has already told the user. ' +
    'Do not address the user directly; write in third person.';

export interface ISummarizer {
    summarize(messages: readonly Message[]): Promise<string>;
}

export interface TruncatingSummarizerOptions {
    /** Approximate maximum characters of summary output. Default: 2000. */
    maxChars?: number;
}

export class TruncatingSummarizer implements ISummarizer {
    private readonly maxChars: number;

    constructor(options: TruncatingSummarizerOptions = {}) {
        this.maxChars = options.maxChars ?? 2000;
    }

    public async summarize(messages: readonly Message[]): Promise<string> {
        if (messages.length === 0) {
            return '';
        }

        const joined = messages
            .map((m) => `${m.role}: ${m.content}`)
            .join('\n');

        if (joined.length <= this.maxChars) {
            return joined;
        }

        const keepHead = Math.floor(this.maxChars * 0.4);
        const keepTail = this.maxChars - keepHead - 20;
        return (
            joined.slice(0, keepHead) +
            '\n... [truncated] ...\n' +
            joined.slice(-keepTail)
        );
    }
}

// ============================================================================
// Anthropic-backed summarizer
// ============================================================================

const ANTHROPIC_ENDPOINT = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_DEFAULT_MODEL = 'claude-haiku-4-5-20251001';
const ANTHROPIC_API_VERSION = '2023-06-01';
const SUMMARIZER_TIMEOUT_MS = 30_000;
const SUMMARIZER_MAX_TOKENS = 1024;

export interface AnthropicSummarizerOptions {
    apiKey?: string;
    model?: string;
    endpoint?: string;
    timeoutMs?: number;
}

export class AnthropicSummarizer implements ISummarizer {
    private readonly apiKey: string;
    private readonly model: string;
    private readonly endpoint: string;
    private readonly timeoutMs: number;

    constructor(options: AnthropicSummarizerOptions = {}) {
        const apiKey = options.apiKey ?? process.env.ANTHROPIC_API_KEY;
        if (!apiKey) {
            throw new Error(
                'AnthropicSummarizer requires ANTHROPIC_API_KEY (or apiKey option).'
            );
        }
        this.apiKey = apiKey;
        this.model = options.model ?? ANTHROPIC_DEFAULT_MODEL;
        this.endpoint = options.endpoint ?? ANTHROPIC_ENDPOINT;
        this.timeoutMs = options.timeoutMs ?? SUMMARIZER_TIMEOUT_MS;
    }

    public async summarize(messages: readonly Message[]): Promise<string> {
        if (messages.length === 0) {
            return '';
        }
        const userContent = messages
            .map((m) => `${m.role}: ${m.content}`)
            .join('\n');

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

        try {
            const response = await fetch(this.endpoint, {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    'x-api-key': this.apiKey,
                    'anthropic-version': ANTHROPIC_API_VERSION,
                },
                body: JSON.stringify({
                    model: this.model,
                    max_tokens: SUMMARIZER_MAX_TOKENS,
                    system: SUMMARY_SYSTEM_PROMPT,
                    messages: [
                        { role: 'user', content: userContent.slice(0, 200_000) },
                    ],
                }),
                signal: controller.signal,
            });

            if (!response.ok) {
                const body = await response.text().catch(() => '');
                throw new Error(
                    `Anthropic summarize failed: ${response.status} ${response.statusText} ${body.slice(0, 200)}`
                );
            }

            const data = (await response.json()) as {
                content?: Array<{ type: string; text?: string }>;
            };
            const text =
                data.content
                    ?.filter((c) => c.type === 'text' && typeof c.text === 'string')
                    .map((c) => c.text ?? '')
                    .join('\n')
                    .trim() ?? '';
            return text;
        } finally {
            clearTimeout(timeout);
        }
    }
}

// ============================================================================
// Google AI-backed summarizer
// ============================================================================

const GOOGLE_AI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';
const GOOGLE_AI_DEFAULT_MODEL = 'gemini-2.5-flash';

export interface GoogleAISummarizerOptions {
    apiKey?: string;
    model?: string;
    endpoint?: string;
    timeoutMs?: number;
}

export class GoogleAISummarizer implements ISummarizer {
    private readonly apiKey: string;
    private readonly model: string;
    private readonly endpoint: string;
    private readonly timeoutMs: number;

    constructor(options: GoogleAISummarizerOptions = {}) {
        const apiKey = options.apiKey ?? process.env.GOOGLE_AI_API_KEY;
        if (!apiKey) {
            throw new Error(
                'GoogleAISummarizer requires GOOGLE_AI_API_KEY (or apiKey option).'
            );
        }
        this.apiKey = apiKey;
        this.model = options.model ?? GOOGLE_AI_DEFAULT_MODEL;
        this.endpoint = options.endpoint ?? GOOGLE_AI_ENDPOINT;
        this.timeoutMs = options.timeoutMs ?? SUMMARIZER_TIMEOUT_MS;
    }

    public async summarize(messages: readonly Message[]): Promise<string> {
        if (messages.length === 0) {
            return '';
        }
        const joined = messages
            .map((m) => `${m.role}: ${m.content}`)
            .join('\n');

        const url = `${this.endpoint}/${encodeURIComponent(this.model)}:generateContent?key=${encodeURIComponent(this.apiKey)}`;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    systemInstruction: { parts: [{ text: SUMMARY_SYSTEM_PROMPT }] },
                    contents: [
                        {
                            role: 'user',
                            parts: [{ text: joined.slice(0, 200_000) }],
                        },
                    ],
                    generationConfig: { maxOutputTokens: SUMMARIZER_MAX_TOKENS },
                }),
                signal: controller.signal,
            });

            if (!response.ok) {
                const body = await response.text().catch(() => '');
                throw new Error(
                    `Google AI summarize failed: ${response.status} ${response.statusText} ${body.slice(0, 200)}`
                );
            }

            const data = (await response.json()) as {
                candidates?: Array<{
                    content?: { parts?: Array<{ text?: string }> };
                }>;
            };
            const text =
                data.candidates?.[0]?.content?.parts
                    ?.map((p) => p.text ?? '')
                    .join('\n')
                    .trim() ?? '';
            return text;
        } finally {
            clearTimeout(timeout);
        }
    }
}

// ============================================================================
// Factory
// ============================================================================

/**
 * Pick an ISummarizer based on available credentials:
 *   1. ANTHROPIC_API_KEY → AnthropicSummarizer
 *   2. GOOGLE_AI_API_KEY → GoogleAISummarizer
 *   3. fallback        → TruncatingSummarizer (no network, no key)
 *
 * Anthropic sits first because this project is Claude-adjacent; users
 * who prefer Gemini can either unset ANTHROPIC_API_KEY or construct
 * GoogleAISummarizer directly.
 */
export function createSummarizerFromEnv(): ISummarizer {
    if (process.env.ANTHROPIC_API_KEY) {
        try {
            return new AnthropicSummarizer();
        } catch {
            // Fall through to next option.
        }
    }
    if (process.env.GOOGLE_AI_API_KEY) {
        try {
            return new GoogleAISummarizer();
        } catch {
            // Fall through.
        }
    }
    return new TruncatingSummarizer();
}
