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
    /**
     * When true, getHistoryTokenCount may fall back to a character/4
     * heuristic if no tokenizer is supplied. Production code should
     * always pass a real tokenizer and leave this false (the default).
     */
    allowCharHeuristic?: boolean;
    /** Override for createdAt — used by fromSnapshot. */
    createdAt?: number;
    /** Override for updatedAt — used by fromSnapshot. */
    updatedAt?: number;
}

const DEFAULT_MAX_TOKENS = 100_000;
const DEFAULT_PRESERVE_TAIL_RATIO = 0.3;
const CHAR_HEURISTIC_RATIO = 4;

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
    private readonly allowCharHeuristic: boolean;

    constructor(options: SessionOptions = {}) {
        this.id = options.id ?? randomUUID();
        this.maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
        this.preserveTailRatio = options.preserveTailRatio ?? DEFAULT_PRESERVE_TAIL_RATIO;
        this.tokenizer = options.tokenizer ?? null;
        this.summarizer = options.summarizer ?? new TruncatingSummarizer();
        this.allowCharHeuristic = options.allowCharHeuristic ?? false;
        const now = Date.now();
        this.createdAt = options.createdAt ?? now;
        this.updatedAt = options.updatedAt ?? this.createdAt;
    }

    public addMessage(role: MessageRole, content: string): Message {
        const message: Message = { role, content, timestamp: Date.now() };
        this.history.push(message);
        this.updatedAt = message.timestamp;
        return message;
    }

    public getHistory(): readonly Message[] {
        // Defensive copy so external mutation (push/splice/in-place
        // edit) can't bypass updatedAt tracking or corrupt the history.
        return this.history.map((message) => ({ ...message }));
    }

    public getFileState(): Readonly<SessionFileState> {
        return { ...this.fileState };
    }

    public getFileContent(filePath: string): string | undefined {
        return this.fileState[filePath];
    }

    public setFileContent(filePath: string, content: string): void {
        this.fileState[filePath] = content;
        this.updatedAt = Date.now();
    }

    public clearFileContent(filePath: string): void {
        if (filePath in this.fileState) {
            delete this.fileState[filePath];
            this.updatedAt = Date.now();
        }
    }

    /**
     * Total token count of the current history.
     *
     * Requires a tokenizer unless the caller opted into the character/4
     * heuristic via `allowCharHeuristic: true`. We default to requiring a
     * tokenizer because #124's whole point is eliminating char/4.
     */
    public async getHistoryTokenCount(): Promise<number> {
        if (!this.tokenizer) {
            if (!this.allowCharHeuristic) {
                throw new Error(
                    'Session.getHistoryTokenCount requires a tokenizer. ' +
                        'Construct the Session with TokenizerFactory.create(...) ' +
                        'or pass allowCharHeuristic: true to opt into the fallback.'
                );
            }
            return this.history.reduce(
                (acc, m) => acc + Math.ceil(m.content.length / CHAR_HEURISTIC_RATIO),
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
        // Store summaries as `assistant`, not `system` — a user turn
        // can contain prompt-injection text, and promoting it into a
        // system-role message after compression would let that text
        // act as a higher-priority instruction. Assistant role keeps
        // the context without the privilege escalation.
        const summaryMessage: Message = {
            role: 'assistant',
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
            history: this.history.map((message) => ({ ...message })),
            fileState: { ...this.fileState },
            maxTokens: this.maxTokens,
            createdAt: this.createdAt,
            updatedAt: this.updatedAt,
        };
    }

    public static fromSnapshot(
        snapshot: SessionSnapshot,
        options: Omit<SessionOptions, 'id' | 'maxTokens' | 'createdAt' | 'updatedAt'> = {}
    ): Session {
        const session = new Session({
            id: snapshot.id,
            maxTokens: snapshot.maxTokens,
            createdAt: snapshot.createdAt,
            updatedAt: snapshot.updatedAt,
            ...options,
        });
        session.history = snapshot.history.map((message) => ({ ...message }));
        session.fileState = { ...snapshot.fileState };
        return session;
    }
}
