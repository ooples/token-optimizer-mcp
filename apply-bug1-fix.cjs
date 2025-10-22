const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'src', 'core', 'cache-engine.ts');
let content = fs.readFileSync(filePath, 'utf8');

// Step 1: Add dbPath field to class
const classDefOld = `export class CacheEngine {
  private db: Database.Database;
  private memoryCache: LRUCache<string, string>;
  private stats = {`;

const classDefNew = `export class CacheEngine {
  private db!: Database.Database;
  private memoryCache: LRUCache<string, string>;
  private dbPath!: string;
  private stats = {`;

content = content.replace(classDefOld, classDefNew);

// Step 2: Replace the entire constructor with retry logic
const constructorStart = 'constructor(dbPath?: string, maxMemoryItems: number = 1000) {';
const constructorEnd = '    // Initialize in-memory LRU cache for frequently accessed items\n    this.memoryCache = new LRUCache<string, string>({\n      max: maxMemoryItems,\n      ttl: 1000 * 60 * 60, // 1 hour TTL\n    });\n  }';

const newConstructor = `constructor(dbPath?: string, maxMemoryItems: number = 1000) {
    // Use user-provided path, environment variable, or default to ~/.token-optimizer-cache
    const defaultCacheDir =
      process.env.TOKEN_OPTIMIZER_CACHE_DIR ||
      path.join(os.homedir(), '.token-optimizer-cache');
    const cacheDir = dbPath ? path.dirname(dbPath) : defaultCacheDir;

    // Ensure cache directory exists
    if (!fs.existsSync(cacheDir)) {
      fs.mkdirSync(cacheDir, { recursive: true });
    }

    const finalDbPath = dbPath || path.join(cacheDir, 'cache.db');

    // Retry logic with up to 3 attempts
    let lastError = null;
    const maxAttempts = 3;
    let dbInitialized = false;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        // First attempt: use requested path
        // Second attempt: try cleaning up corrupted files and retry
        // Third attempt: use backup location in temp directory
        const dbPathToUse =
          attempt === 3
            ? path.join(
                os.tmpdir(),
                \`token-optimizer-cache-backup-\${Date.now()}.db\`
              )
            : finalDbPath;

        // If this is attempt 2, try to clean up corrupted files
        if (attempt === 2 && fs.existsSync(finalDbPath)) {
          try {
            fs.unlinkSync(finalDbPath);
            // Also remove WAL files
            const walPath = \`\${finalDbPath}-wal\`;
            const shmPath = \`\${finalDbPath}-shm\`;
            if (fs.existsSync(walPath)) fs.unlinkSync(walPath);
            if (fs.existsSync(shmPath)) fs.unlinkSync(shmPath);
          } catch (cleanupError) {
            // If we can't clean up, we'll try temp directory on next attempt
          }
        }

        this.db = new Database(dbPathToUse);
        this.db.pragma('journal_mode = WAL');

        // Create cache table if it doesn't exist
        this.db.exec(\`
          CREATE TABLE IF NOT EXISTS cache (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            compressed_size INTEGER NOT NULL,
            original_size INTEGER NOT NULL,
            hit_count INTEGER DEFAULT 0,
            created_at INTEGER NOT NULL,
            last_accessed_at INTEGER NOT NULL
          );

          CREATE INDEX IF NOT EXISTS idx_last_accessed ON cache(last_accessed_at);
          CREATE INDEX IF NOT EXISTS idx_hit_count ON cache(hit_count);
        \`);

        // Success! Store the path we used
        this.dbPath = dbPathToUse;
        dbInitialized = true;
        break;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        // Try to close the database if it was partially opened
        try {
          if ((this).db) {
            (this).db.close();
          }
        } catch (closeError) {
          // Ignore close errors
        }

        if (attempt < maxAttempts) {
          // Log warning and try next attempt
          console.warn(
            \`Cache database initialization attempt \${attempt}/\${maxAttempts} failed:\`,
            error
          );
          console.warn(\`Retrying... (attempt \${attempt + 1}/\${maxAttempts})\`);
        }
      }
    }

    // If all attempts failed, throw a comprehensive error
    if (!dbInitialized) {
      throw new Error(
        \`Failed to initialize cache database after \${maxAttempts} attempts. \` +
          \`Last error: \${lastError?.message || 'Unknown error'}. \` +
          \`Attempted paths: \${finalDbPath}, backup location. \` +
          \`Please check disk space and file permissions.\`
      );
    }

    // Initialize in-memory LRU cache for frequently accessed items
    this.memoryCache = new LRUCache<string, string>({
      max: maxMemoryItems,
      ttl: 1000 * 60 * 60, // 1 hour TTL
    });
  }`;

// Find the constructor and replace it
const constructorPattern = /constructor\(dbPath\?: string, maxMemoryItems: number = 1000\) \{[\s\S]*?\/\/ Initialize in-memory LRU cache for frequently accessed items\s+this\.memoryCache = new LRUCache<string, string>\(\{\s+max: maxMemoryItems,\s+ttl: 1000 \* 60 \* 60, \/\/ 1 hour TTL\s+\}\);\s+\}/;

content = content.replace(constructorPattern, newConstructor);

// Write the file
fs.writeFileSync(filePath, content, 'utf8');
console.log('SUCCESS: Bug #1 fix applied - Database initialization with retry logic');
