import { existsSync } from 'fs';
import { z } from 'zod';
import { Session, SessionOptions, MessageRole } from './session.js';
import { ITokenizer } from './tokenizers/i-tokenizer.js';
import { ISummarizer } from './summarization.js';
import { loadMaybeGzippedFile, saveGzippedFile } from '../utils/gzip.js';

/**
 * Persistent SessionManager — addresses issues #121 / #122.
 *
 * Production behaviors added after the audit:
 *   - Atomic persistence: write to <path>.tmp then rename so a crash mid-
 *     write never produces a corrupt sessions.json.
 *   - Debounced persistence: rapid addMessage calls coalesce into one
 *     disk write per PERSIST_DEBOUNCE_MS window.
 *   - Error-isolated persist(): a disk-full or permission error is logged
 *     and never bubbles up to crash the MCP server.
 *   - Schema-validated load(): malformed persisted state is rejected with
 *     a warning instead of being cast blindly.
 *   - Size / expiry caps: sessions inactive past `sessionTtlMs` are
 *     evicted on load, and no individual file state entry can exceed
 *     `maxFileStateBytes`.
 */

const PERSIST_DEBOUNCE_MS = 250;
const DEFAULT_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const DEFAULT_MAX_FILE_STATE_BYTES = 10 * 1024 * 1024; // 10 MB per file

const MessageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant', 'tool']),
  content: z.string(),
  timestamp: z.number(),
});

const SessionSnapshotSchema = z.object({
  id: z.string(),
  history: z.array(MessageSchema),
  fileState: z.record(z.string(), z.string()),
  maxTokens: z.number(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

const PersistedStateSchema = z.object({
  sessions: z.array(SessionSnapshotSchema),
});

export interface SessionManagerOptions {
  persistencePath?: string;
  tokenizer?: ITokenizer;
  summarizer?: ISummarizer;
  defaultMaxTokens?: number;
  sessionTtlMs?: number;
  maxFileStateBytes?: number;
}

export class SessionManager {
  private readonly sessions = new Map<string, Session>();
  private readonly persistencePath: string | null;
  private readonly tokenizer: ITokenizer | undefined;
  private readonly summarizer: ISummarizer | undefined;
  private readonly defaultMaxTokens: number | undefined;
  private readonly sessionTtlMs: number;
  private readonly maxFileStateBytes: number;
  private pendingPersistTimer: NodeJS.Timeout | null = null;
  private persistInFlight = false;

  constructor(options: SessionManagerOptions = {}) {
    this.persistencePath = options.persistencePath ?? null;
    this.tokenizer = options.tokenizer;
    this.summarizer = options.summarizer;
    this.defaultMaxTokens = options.defaultMaxTokens;
    this.sessionTtlMs = options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
    this.maxFileStateBytes =
      options.maxFileStateBytes ?? DEFAULT_MAX_FILE_STATE_BYTES;
    if (
      this.persistencePath &&
      (existsSync(`${this.persistencePath}.gz`) ||
        existsSync(this.persistencePath))
    ) {
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
    this.schedulePersist();
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
      this.schedulePersist();
    }
    return removed;
  }

  public async addMessage(
    sessionId: string,
    role: MessageRole,
    content: string
  ): Promise<number> {
    const session = this.requireSession(sessionId);
    session.addMessage(role, content);
    // Schedule persistence in `finally` so the mutated session still
    // hits disk even if tokenization or compression throws. Without
    // this, a single tokenizer error leaves the message appended
    // in memory but never persisted, and a restart loses the turn.
    try {
      const currentTokens = await session.getHistoryTokenCount();
      if (currentTokens > session.maxTokens) {
        return await session.compressHistory();
      }
      return currentTokens;
    } finally {
      this.schedulePersist();
    }
  }

  /** Fetch an existing session, or create one with the given id. */
  public getOrCreateSession(id: string): Session {
    const existing = this.sessions.get(id);
    if (existing) {
      return existing;
    }
    return this.createSession({ id });
  }

  public updateFileState(
    sessionId: string,
    filePath: string,
    content: string
  ): void {
    const session = this.requireSession(sessionId);
    if (Buffer.byteLength(content, 'utf8') > this.maxFileStateBytes) {
      throw new Error(
        `Session file state content exceeds ${this.maxFileStateBytes} bytes for ${filePath}`
      );
    }
    session.setFileContent(filePath, content);
    this.schedulePersist();
  }

  public clearFileState(sessionId: string, filePath: string): void {
    const session = this.requireSession(sessionId);
    session.clearFileContent(filePath);
    this.schedulePersist();
  }

  /**
   * Flush any pending debounced persist. Call this from the host's
   * shutdown handler so the last writes survive.
   */
  public async flush(): Promise<void> {
    if (this.pendingPersistTimer) {
      clearTimeout(this.pendingPersistTimer);
      this.pendingPersistTimer = null;
    }
    this.persistNow();
  }

  private requireSession(id: string): Session {
    const session = this.sessions.get(id);
    if (!session) {
      throw new Error(`Unknown session: ${id}`);
    }
    return session;
  }

  private schedulePersist(): void {
    if (!this.persistencePath) {
      return;
    }
    if (this.pendingPersistTimer) {
      return;
    }
    this.pendingPersistTimer = setTimeout(() => {
      this.pendingPersistTimer = null;
      this.persistNow();
    }, PERSIST_DEBOUNCE_MS);
    // Don't keep the event loop alive just for persistence.
    if (typeof this.pendingPersistTimer.unref === 'function') {
      this.pendingPersistTimer.unref();
    }
  }

  private persistNow(): void {
    if (!this.persistencePath || this.persistInFlight) {
      return;
    }
    this.persistInFlight = true;
    try {
      const state = {
        sessions: this.listSessions().map((s) => s.toSnapshot()),
      };
      // Gzip + atomic tmp + rename (handled inside saveGzippedFile).
      saveGzippedFile(this.persistencePath, JSON.stringify(state, null, 2));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(
        `SessionManager: failed to persist to ${this.persistencePath}: ${message}`
      );
    } finally {
      this.persistInFlight = false;
    }
  }

  private load(): void {
    if (!this.persistencePath) {
      return;
    }
    try {
      const raw = loadMaybeGzippedFile(this.persistencePath);
      if (raw === null) {
        return;
      }
      const json = JSON.parse(raw);
      const parsed = PersistedStateSchema.safeParse(json);
      if (!parsed.success) {
        console.warn(
          `SessionManager: invalid persisted state at ${this.persistencePath}, discarding.`
        );
        return;
      }
      const now = Date.now();
      for (const snapshot of parsed.data.sessions) {
        if (now - snapshot.updatedAt > this.sessionTtlMs) {
          continue; // Expired session — drop.
        }
        // Enforce the same per-file size cap on restore that
        // updateFileState enforces on writes; otherwise a
        // tampered or legacy persisted file can smuggle in
        // oversized entries past the live guardrail.
        const maxBytes = this.maxFileStateBytes;
        const sanitizedFileState: Record<string, string> = {};
        for (const [filePath, content] of Object.entries(snapshot.fileState)) {
          if (Buffer.byteLength(content, 'utf8') <= maxBytes) {
            sanitizedFileState[filePath] = content;
          }
        }
        const safeSnapshot = {
          ...snapshot,
          fileState: sanitizedFileState,
        };
        const session = Session.fromSnapshot(safeSnapshot, {
          tokenizer: this.tokenizer,
          summarizer: this.summarizer,
        });
        this.sessions.set(session.id, session);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(
        `SessionManager: failed to load sessions from ${this.persistencePath}: ${message}`
      );
    }
  }
}
