import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';
import { CompressionEngine } from '../core/compression-engine.js';

export interface OptimizationResult {
    originalTextHash: string;
    optimizedText: string;
    originalTokens: number;
    optimizedTokens: number;
    tokensSaved: number;
}

export function getDefaultOptimizationDbPath(): string {
    return join(homedir(), '.token-optimizer', 'optimization.db');
}

export class SqliteOptimizationStorage {
    private db: Database.Database | null = null;
    private readonly dbPath: string;
    private readonly compressionEngine: CompressionEngine;

    constructor(dbPath?: string) {
        this.dbPath = dbPath ?? getDefaultOptimizationDbPath();
        this.compressionEngine = new CompressionEngine();
    }

    public initializeDatabase(): void {
        const dir = dirname(this.dbPath);
        if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true });
        }
        this.db = new Database(this.dbPath);
        this.db.pragma('journal_mode = WAL');
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS optimization_results (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                original_text_hash TEXT NOT NULL UNIQUE,
                optimized_text_compressed BLOB NOT NULL,
                compression_algorithm TEXT NOT NULL,
                original_tokens INTEGER NOT NULL,
                optimized_tokens INTEGER NOT NULL,
                tokens_saved INTEGER NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );
            CREATE INDEX IF NOT EXISTS idx_optimization_hash
                ON optimization_results(original_text_hash);
        `);
    }

    private requireDb(): Database.Database {
        if (!this.db) {
            throw new Error('Optimization storage database is not initialized. Call initializeDatabase() first.');
        }
        return this.db;
    }

    public save(entry: OptimizationResult): void {
        const db = this.requireDb();
        const compressed = this.compressionEngine.compress(entry.optimizedText);

        db.prepare(
            `INSERT OR REPLACE INTO optimization_results
             (original_text_hash, optimized_text_compressed, compression_algorithm,
              original_tokens, optimized_tokens, tokens_saved)
             VALUES (?, ?, ?, ?, ?, ?)`
        ).run(
            entry.originalTextHash,
            compressed.compressed,
            SqliteOptimizationStorage.COMPRESSION_ALGORITHM,
            entry.originalTokens,
            entry.optimizedTokens,
            entry.tokensSaved
        );
    }

    public get(originalTextHash: string): OptimizationResult | null {
        const db = this.requireDb();
        const row = db.prepare(
            `SELECT optimized_text_compressed, compression_algorithm,
                    original_tokens, optimized_tokens, tokens_saved
             FROM optimization_results WHERE original_text_hash = ?`
        ).get(originalTextHash) as
            | {
                  optimized_text_compressed: Buffer;
                  compression_algorithm: string;
                  original_tokens: number;
                  optimized_tokens: number;
                  tokens_saved: number;
              }
            | undefined;

        if (!row) {
            return null;
        }

        return {
            originalTextHash,
            optimizedText: this.decodePayload(
                row.optimized_text_compressed,
                row.compression_algorithm
            ),
            originalTokens: row.original_tokens,
            optimizedTokens: row.optimized_tokens,
            tokensSaved: row.tokens_saved,
        };
    }

    /**
     * Decode a stored payload using the persisted algorithm label. Keeps
     * the door open for additional algorithms (gzip, zstd) without
     * touching the read path, and surfaces an explicit error for
     * unknown labels instead of silently corrupting data.
     */
    private decodePayload(buffer: Buffer, algorithm: string): string {
        switch (algorithm) {
            case 'brotli':
                return this.compressionEngine.decompress(buffer);
            case 'none':
            case '':
                return buffer.toString('utf8');
            default:
                throw new Error(
                    `Unknown compression_algorithm in optimization_results: ${algorithm}`
                );
        }
    }

    /** Algorithm label paired with the current CompressionEngine. */
    public static readonly COMPRESSION_ALGORITHM = 'brotli';

    public close(): void {
        if (this.db) {
            this.db.close();
            this.db = null;
        }
    }
}
