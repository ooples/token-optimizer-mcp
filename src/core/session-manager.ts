import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import {
    Session,
    SessionOptions,
    SessionSnapshot,
    MessageRole,
} from './session.js';
import { ITokenizer } from './tokenizers/i-tokenizer.js';
import { ISummarizer } from './summarization.js';

/**
 * Singleton-style SessionManager — addresses issues #121 / #122.
 *
 * Persists all sessions to a single JSON file so they survive restarts.
 * When a message is added we check whether the session has exceeded its
 * token budget and, if so, auto-compress the history (#121).
 */

export interface SessionManagerOptions {
    persistencePath?: string;
    tokenizer?: ITokenizer;
    summarizer?: ISummarizer;
    defaultMaxTokens?: number;
}

interface PersistedState {
    sessions: SessionSnapshot[];
}

export class SessionManager {
    private readonly sessions = new Map<string, Session>();
    private readonly persistencePath: string | null;
    private readonly tokenizer: ITokenizer | undefined;
    private readonly summarizer: ISummarizer | undefined;
    private readonly defaultMaxTokens: number | undefined;

    constructor(options: SessionManagerOptions = {}) {
        this.persistencePath = options.persistencePath ?? null;
        this.tokenizer = options.tokenizer;
        this.summarizer = options.summarizer;
        this.defaultMaxTokens = options.defaultMaxTokens;
        if (this.persistencePath && existsSync(this.persistencePath)) {
            this.load();
        }
    }

    public createSession(options: SessionOptions = {}): Session {
        const session = new Session({
            tokenizer: this.tokenizer,
            summarizer: this.summarizer,
            maxTokens: options.maxTokens ?? this.defaultMaxTokens,
            ...options,
        });
        this.sessions.set(session.id, session);
        this.persist();
        return session;
    }

    public getSession(id: string): Session | undefined {
        return this.sessions.get(id);
    }

    public listSessions(): Session[] {
        return Array.from(this.sessions.values());
    }

    public deleteSession(id: string): boolean {
        const removed = this.sessions.delete(id);
        if (removed) {
            this.persist();
        }
        return removed;
    }

    /**
     * Add a message to the session and auto-compress the history if the
     * token budget is exceeded (#121).
     *
     * Returns the post-add token count of the session.
     */
    public async addMessage(
        sessionId: string,
        role: MessageRole,
        content: string
    ): Promise<number> {
        const session = this.sessions.get(sessionId);
        if (!session) {
            throw new Error(`Unknown session: ${sessionId}`);
        }
        session.addMessage(role, content);
        const currentTokens = await session.getHistoryTokenCount();
        let finalTokens = currentTokens;
        if (currentTokens > session.maxTokens) {
            finalTokens = await session.compressHistory();
        }
        this.persist();
        return finalTokens;
    }

    public updateFileState(
        sessionId: string,
        filePath: string,
        content: string
    ): void {
        const session = this.sessions.get(sessionId);
        if (!session) {
            throw new Error(`Unknown session: ${sessionId}`);
        }
        session.setFileContent(filePath, content);
        this.persist();
    }

    private persist(): void {
        if (!this.persistencePath) {
            return;
        }
        const state: PersistedState = {
            sessions: this.listSessions().map((s) => s.toSnapshot()),
        };
        const dir = dirname(this.persistencePath);
        if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true });
        }
        writeFileSync(this.persistencePath, JSON.stringify(state, null, 2));
    }

    private load(): void {
        if (!this.persistencePath) {
            return;
        }
        try {
            const raw = readFileSync(this.persistencePath, 'utf-8');
            const parsed = JSON.parse(raw) as PersistedState;
            if (!parsed || !Array.isArray(parsed.sessions)) {
                return;
            }
            for (const snapshot of parsed.sessions) {
                const session = Session.fromSnapshot(snapshot, {
                    tokenizer: this.tokenizer,
                    summarizer: this.summarizer,
                });
                this.sessions.set(session.id, session);
            }
        } catch (error) {
            const message =
                error instanceof Error ? error.message : String(error);
            console.warn(
                `SessionManager: failed to load sessions from ${this.persistencePath}: ${message}`
            );
        }
    }
}
