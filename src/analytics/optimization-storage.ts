import sqlite3 from 'sqlite3';
import { open, Database } from 'sqlite';
import { CompressionEngine } from '../core/compression-engine';

export interface OptimizationResult {
    originalTextHash: string;
    optimizedText: string;
    originalTokens: number;
    optimizedTokens: number;
    tokensSaved: number;
}

export class SqliteOptimizationStorage {
    private db: Database<sqlite3.Database, sqlite3.Statement>;
    private dbPath: string;
    private compressionEngine: CompressionEngine;

    constructor(dbPath: string = './optimization.db') {
        this.dbPath = dbPath;
        this.compressionEngine = new CompressionEngine();
    }

    public async initializeDatabase(): Promise<void> {
        this.db = await open({
            filename: this.dbPath,
            driver: sqlite3.Database
        });

        await this.db.exec(`
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
        `);
    }

    public async save(entry: OptimizationResult): Promise<void> {
        const compressedOptimizedText = this.compressionEngine.compress(entry.optimizedText);

        await this.db.run(
            `INSERT INTO optimization_results (original_text_hash, optimized_text_compressed, compression_algorithm, original_tokens, optimized_tokens, tokens_saved)
             VALUES (?, ?, ?, ?, ?, ?)`, 
            [entry.originalTextHash, compressedOptimizedText.compressed, 'brotli', entry.originalTokens, entry.optimizedTokens, entry.tokensSaved]
        );
    }

    public async get(originalTextHash: string): Promise<OptimizationResult | null> {
        const row = await this.db.get(
            'SELECT optimized_text_compressed, original_tokens, optimized_tokens, tokens_saved FROM optimization_results WHERE original_text_hash = ?',
            originalTextHash
        );

        if (!row) {
            return null;
        }

        const optimizedText = this.compressionEngine.decompress(row.optimized_text_compressed);

        return {
            originalTextHash,
            optimizedText,
            originalTokens: row.original_tokens,
            optimizedTokens: row.optimized_tokens,
            tokensSaved: row.tokens_saved
        };
    }

    public async close(): Promise<void> {
        if (this.db) {
            await this.db.close();
        }
    }
}
