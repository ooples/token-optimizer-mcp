import { randomUUID } from 'crypto';
import { ITokenizer } from './tokenizers/i-tokenizer.js';
import { ISummarizer, TruncatingSummarizer } from './summarization.js';

/**
 * Session state — addresses issues #121 and #122.
 *
 * A Session holds a single user's conversation history plus a per-file
 * content snapshot. The history is token-budgeted (see #121) and the file
 * snapshots feed context-delta tracking (#122).
 */

export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

export interface Message {
    role: MessageRole;
    content: string;
    timestamp: number;
}

export interface SessionFileState {
    [filePath: string]: string;
}

export interface SessionSnapshot {
    id: string;
    history: Message[];
    fileState: SessionFileState;
    maxTokens: number;
    createdAt: number;
    updatedAt: number;
}

export interface SessionOptions {
    id?: string;
    maxTokens?: number;
    preserveTailRatio?: number;
    tokenizer?: ITokenizer;
    summarizer?: ISummarizer;
}

const DEFAULT_MAX_TOKENS = 100_000;
const DEFAULT_PRESERVE_TAIL_RATIO = 0.3;

export class Session {
    public readonly id: string;
    public maxTokens: number;
    public readonly createdAt: number;
    public updatedAt: number;

    private history: Message[] = [];
    private fileState: SessionFileState = {};
    private readonly preserveTailRatio: number;
    private readonly tokenizer: ITokenizer | null;
    private readonly summarizer: ISummarizer;

    constructor(options: SessionOptions = {}) {
        this.id = options.id ?? randomUUID();
        this.maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
        this.preserveTailRatio = options.preserveTailRatio ?? DEFAULT_PRESERVE_TAIL_RATIO;
        this.tokenizer = options.tokenizer ?? null;
        this.summarizer = options.summarizer ?? new TruncatingSummarizer();
        this.createdAt = Date.now();
        this.updatedAt = this.createdAt;
    }

    public addMessage(role: MessageRole, content: string): Message {
        const message: Message = { role, content, timestamp: Date.now() };
        this.history.push(message);
        this.updatedAt = message.timestamp;
        return message;
    }

    public getHistory(): readonly Message[] {
        return this.history;
    }

    public getFileState(): Readonly<SessionFileState> {
        return this.fileState;
    }

    public getFileContent(filePath: string): string | undefined {
        return this.fileState[filePath];
    }

    public setFileContent(filePath: string, content: string): void {
        this.fileState[filePath] = content;
        this.updatedAt = Date.now();
    }

    /**
     * Total token count of the current history. Uses the injected tokenizer
     * when available; otherwise falls back to the character/4 heuristic.
     */
    public async getHistoryTokenCount(): Promise<number> {
        if (!this.tokenizer) {
            return this.history.reduce(
                (acc, m) => acc + Math.ceil(m.content.length / 4),
                0
            );
        }
        let total = 0;
        for (const message of this.history) {
            total += await this.tokenizer.countTokens(message.content);
        }
        return total;
    }

    /**
     * Compress the history by summarizing everything except the
     * preserve-tail fraction. Does nothing if history fits under maxTokens.
     *
     * Returns the new token count after compression.
     */
    public async compressHistory(): Promise<number> {
        const currentTokens = await this.getHistoryTokenCount();
        if (currentTokens <= this.maxTokens) {
            return currentTokens;
        }
        if (this.history.length <= 1) {
            return currentTokens;
        }

        const preserveCount = Math.max(
            1,
            Math.floor(this.history.length * this.preserveTailRatio)
        );
        const tail = this.history.slice(-preserveCount);
        const head = this.history.slice(0, -preserveCount);
        if (head.length === 0) {
            return currentTokens;
        }

        const summary = await this.summarizer.summarize(head);
        const summaryMessage: Message = {
            role: 'system',
            content: `[summary of earlier conversation] ${summary}`,
            timestamp: head[head.length - 1].timestamp,
        };

        this.history = [summaryMessage, ...tail];
        this.updatedAt = Date.now();
        return this.getHistoryTokenCount();
    }

    public toSnapshot(): SessionSnapshot {
        return {
            id: this.id,
            history: [...this.history],
            fileState: { ...this.fileState },
            maxTokens: this.maxTokens,
            createdAt: this.createdAt,
            updatedAt: this.updatedAt,
        };
    }

    public static fromSnapshot(
        snapshot: SessionSnapshot,
        options: Omit<SessionOptions, 'id' | 'maxTokens'> = {}
    ): Session {
        const session = new Session({
            id: snapshot.id,
            maxTokens: snapshot.maxTokens,
            ...options,
        });
        session.history = [...snapshot.history];
        session.fileState = { ...snapshot.fileState };
        session.updatedAt = snapshot.updatedAt;
        return session;
    }
}
