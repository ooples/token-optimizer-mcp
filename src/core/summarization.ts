import { Message } from './session.js';

/**
 * Pluggable summarization interface — part of issue #121.
 *
 * A production deployment should plug in an LLM-backed summarizer that
 * condenses a list of Messages into a single natural-language summary.
 * The default TruncatingSummarizer keeps the module self-contained and
 * testable without an API key; it concatenates role+content and trims
 * to a reasonable length.
 */

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
