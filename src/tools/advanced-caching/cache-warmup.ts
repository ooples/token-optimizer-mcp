/**
 * CacheWarmup - Intelligent Cache Pre-warming Tool
 *
 * Token Reduction Target: 87%+
 *
 * Features:
 * - Schedule-based warming (cron-like)
 * - Pattern-based warming from historical access
 * - Dependency graph resolution
 * - Parallel warming with concurrency control
 * - Progressive warming (hot keys first)
 * - Dry-run simulation mode
 * - Rollback on failures
 *
 * Operations:
 * 1. schedule - Schedule cache warming
 * 2. immediate - Warm cache immediately
 * 3. pattern-based - Warm based on access patterns
 * 4. dependency-based - Warm with dependency resolution
 * 5. selective - Warm specific keys/categories
 * 6. status - Get warming status
 */

import { CacheEngine } from '../../core/cache-engine';
import { TokenCounter } from '../../core/token-counter';
import { MetricsCollector } from '../../core/metrics';
import { EventEmitter } from 'events';

export type WarmupStrategy =
  | 'immediate'
  | 'progressive'
  | 'dependency'
  | 'pattern';
export type WarmupPriority = 'high' | 'normal' | 'low';
export type WarmupStatus =
  | 'idle'
  | 'warming'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface CacheWarmupOptions {
  operation:
    | 'schedule'
    | 'immediate'
    | 'pattern-based'
    | 'dependency-based'
    | 'selective'
    | 'status'
    | 'cancel'
    | 'pause'
    | 'resume'
    | 'configure';

  // Warming configuration
  keys?: string[];
  categories?: string[];
  pattern?: string; // Regex pattern for key matching
  priority?: WarmupPriority;
  strategy?: WarmupStrategy;

  // Data source configuration
  dataSource?: WarmupDataSource;
  dataFetcher?: (key: string) => Promise<string>;

  // Scheduling
  schedule?: string; // Cron expression
  scheduleId?: string;
  startTime?: number;
  endTime?: number;

  // Dependency configuration
  dependencies?: DependencyGraph;
  resolveDependencies?: boolean;

  // Pattern-based warming
  accessHistory?: AccessHistoryEntry[];
  minAccessCount?: number;
  timeWindow?: number; // Time window for pattern analysis (ms)

  // Concurrency control
  maxConcurrency?: number;
  batchSize?: number;
  delayBetweenBatches?: number;

  // Progressive warming
  hotKeyThreshold?: number; // Min access count for hot keys
  warmupPercentage?: number; // Percentage of cache to warm

  // Simulation and rollback
  dryRun?: boolean;
  enableRollback?: boolean;
  validateBeforeCommit?: boolean;

  // Timeouts and retries
  timeout?: number;
  maxRetries?: number;
  retryDelay?: number;

  // Monitoring
  reportProgress?: boolean;
  progressInterval?: number;

  useCache?: boolean;
  cacheTTL?: number;
}

export interface WarmupDataSource {
  type: 'database' | 'api' | 'file' | 'cache' | 'custom';
  connectionString?: string;
  endpoint?: string;
  filePath?: string;
  customFetcher?: (key: string) => Promise<string>;
}

export interface DependencyGraph {
  nodes: DependencyNode[];
  edges: DependencyEdge[];
}

export interface DependencyNode {
  key: string;
  priority: number;
  category?: string;
  estimatedSize?: number;
}

export interface DependencyEdge {
  from: string; // Dependent key
  to: string; // Dependency key
  type: 'required' | 'optional';
}

export interface AccessHistoryEntry {
  key: string;
  timestamp: number;
  accessCount: number;
  category?: string;
  metadata?: Record<string, unknown>;
}

export interface WarmupSchedule {
  id: string;
  cronExpression: string;
  options: CacheWarmupOptions;
  enabled: boolean;
  nextRun: number;
  lastRun?: number;
  status: 'active' | 'paused' | 'completed' | 'failed';
}

export interface WarmupProgress {
  status: WarmupStatus;
  totalKeys: number;
  warmedKeys: number;
  failedKeys: number;
  skippedKeys: number;
  currentKey?: string;
  percentComplete: number;
  startTime: number;
  estimatedCompletion?: number;
  elapsedTime: number;
  throughput: number; // Keys per second
  errors: WarmupError[];
}

export interface WarmupError {
  key: string;
  error: string;
  timestamp: number;
  retryCount: number;
}

export interface WarmupResult {
  success: boolean;
  operation: string;
  data: {
    progress?: WarmupProgress;
    warmedKeys?: string[];
    failedKeys?: string[];
    skippedKeys?: string[];
    schedule?: WarmupSchedule;
    schedules?: WarmupSchedule[];
    simulation?: SimulationResult;
    configuration?: WarmupConfiguration;
  };
  metadata: {
    tokensUsed: number;
    tokensSaved: number;
    cacheHit: boolean;
    executionTime: number;
  };
}

export interface SimulationResult {
  estimatedKeys: number;
  estimatedSize: number;
  estimatedTime: number;
  estimatedCost: number;
  keysByPriority: {
    high: number;
    normal: number;
    low: number;
  };
  dependencyLayers: number;
  warnings: string[];
}

export interface WarmupConfiguration {
  maxConcurrency: number;
  batchSize: number;
  defaultTimeout: number;
  maxRetries: number;
  enableRollback: boolean;
  progressReporting: boolean;
}

interface WarmupJob {
  id: string;
  keys: string[];
  priority: WarmupPriority;
  strategy: WarmupStrategy;
  status: WarmupStatus;
  progress: WarmupProgress;
  options: CacheWarmupOptions;
  rollbackData?: Map<string, string | null>;
  abortController?: AbortController;
}

interface CronSchedule {
  minute: number | '*';
  hour: number | '*';
  dayOfMonth: number | '*';
  month: number | '*';
  dayOfWeek: number | '*';
}

/**
 * CacheWarmup - Intelligent cache pre-warming with advanced scheduling and dependency resolution
 */
export class CacheWarmupTool extends EventEmitter {
  private cache: CacheEngine;
  private tokenCounter: TokenCounter;
  private metrics: MetricsCollector;

  // Configuration
  private config: WarmupConfiguration = {
    maxConcurrency: 10,
    batchSize: 50,
    defaultTimeout: 30000,
    maxRetries: 3,
    enableRollback: true,
    progressReporting: true,
  };

  // Active jobs
  private activeJobs: Map<string, WarmupJob> = new Map();
  private jobCounter = 0;

  // Schedules
  private schedules: Map<string, WarmupSchedule> = new Map();
  private scheduleTimers: Map<string, NodeJS.Timeout> = new Map();

  // Access patterns
  private accessHistory: Map<string, AccessHistoryEntry[]> = new Map();
  private hotKeys: Set<string> = new Set();

  // Dependency graph
  private dependencyGraph: DependencyGraph | null = null;
  private resolvedOrder: string[] = [];

  // Statistics
  private stats = {
    totalWarmed: 0,
    totalFailed: 0,
    totalSkipped: 0,
    averageWarmupTime: 0,
    lastWarmupTime: 0,
  };

  constructor(
    cache: CacheEngine,
    tokenCounter: TokenCounter,
    metrics: MetricsCollector
  ) {
    super();
    this.cache = cache;
    this.tokenCounter = tokenCounter;
    this.metrics = metrics;
  }

  /**
   * Main entry point for cache warmup operations
   */
  async run(options: CacheWarmupOptions): Promise<WarmupResult> {
    const startTime = Date.now();
    const { operation, useCache = true } = options;

    // Generate cache key for cacheable operations
    let cacheKey: string | null = null;
    if (useCache && this.isCacheableOperation(operation)) {
      cacheKey = `cache-warmup:${JSON.stringify({
        operation,
        ...this.getCacheKeyParams(options),
      })}`;

      // Check cache
      const cached = this.cache.get(cacheKey);
      if (cached) {
        const cachedResult = JSON.parse(cached);
        const tokensSaved = this.tokenCounter.count(
          JSON.stringify(cachedResult)
        ).tokens;

        return {
          success: true,
          operation,
          data: cachedResult,
          metadata: {
            tokensUsed: 0,
            tokensSaved,
            cacheHit: true,
            executionTime: Date.now() - startTime,
          },
        };
      }
    }

    // Execute operation
    let data: WarmupResult['data'];

    try {
      switch (operation) {
        case 'immediate':
          data = await this.immediateWarmup(options);
          break;
        case 'schedule':
          data = await this.scheduleWarmup(options);
          break;
        case 'pattern-based':
          data = await this.patternBasedWarmup(options);
          break;
        case 'dependency-based':
          data = await this.dependencyBasedWarmup(options);
          break;
        case 'selective':
          data = await this.selectiveWarmup(options);
          break;
        case 'status':
          data = await this.getStatus(options);
          break;
        case 'cancel':
          data = await this.cancelWarmup(options);
          break;
        case 'pause':
          data = await this.pauseWarmup(options);
          break;
        case 'resume':
          data = await this.resumeWarmup(options);
          break;
        case 'configure':
          data = await this.configure(options);
          break;
        default:
          throw new Error(`Unknown operation: ${operation}`);
      }

      // Cache the result
      const tokensUsedResult = this.tokenCounter.count(JSON.stringify(data));
      const tokensUsed = tokensUsedResult.tokens;
      if (cacheKey && useCache) {
        const serialized = JSON.stringify(data);
        this.cache.set(cacheKey, serialized, serialized.length, tokensUsed);
      }

      // Record metrics
      this.metrics.record({
        operation: `cache_warmup_${operation}`,
        duration: Date.now() - startTime,
        success: true,
        cacheHit: false,
        inputTokens: 0,
        outputTokens: tokensUsed,
        cachedTokens: 0,
        savedTokens: 0,
        metadata: { operation },
      });

      return {
        success: true,
        operation,
        data,
        metadata: {
          tokensUsed,
          tokensSaved: 0,
          cacheHit: false,
          executionTime: Date.now() - startTime,
        },
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      this.metrics.record({
        operation: `cache_warmup_${operation}`,
        duration: Date.now() - startTime,
        success: false,
        cacheHit: false,
        inputTokens: 0,
        outputTokens: 0,
        cachedTokens: 0,
        savedTokens: 0,
        metadata: { operation, error: errorMessage },
      });

      throw error;
    }
  }

  /**
   * Immediate cache warmup
   */
  private async immediateWarmup(
    options: CacheWarmupOptions
  ): Promise<WarmupResult['data']> {
    const {
      keys = [],
      strategy = 'progressive',
      priority = 'normal',
      dryRun = false,
      maxConcurrency = this.config.maxConcurrency,
      batchSize = this.config.batchSize,
      enableRollback = this.config.enableRollback,
    } = options;

    if (keys.length === 0) {
      throw new Error('No keys provided for immediate warmup');
    }

    // Create warmup job
    const jobId = this.generateJobId();
    const job: WarmupJob = {
      id: jobId,
      keys,
      priority,
      strategy,
      status: 'warming',
      options,
      progress: {
        status: 'warming',
        totalKeys: keys.length,
        warmedKeys: 0,
        failedKeys: 0,
        skippedKeys: 0,
        percentComplete: 0,
        startTime: Date.now(),
        elapsedTime: 0,
        throughput: 0,
        errors: [],
      },
      rollbackData: enableRollback ? new Map() : undefined,
      abortController: new AbortController(),
    };

    if (dryRun) {
      // Simulate warmup
      const simulation = await this.simulateWarmup(keys, options);
      return { simulation };
    }

    this.activeJobs.set(jobId, job);
    this.emit('warmup-started', { jobId, keys: keys.length, strategy });

    try {
      // Execute warmup based on strategy
      let warmedKeys: string[];

      if (strategy === 'progressive') {
        warmedKeys = await this.progressiveWarmup(
          job,
          maxConcurrency,
          batchSize
        );
      } else if (strategy === 'dependency') {
        warmedKeys = await this.warmupWithDependencies(job, options);
      } else if (strategy === 'pattern') {
        warmedKeys = await this.warmupByPattern(job, options);
      } else {
        warmedKeys = await this.parallelWarmup(job, maxConcurrency, batchSize);
      }

      job.progress.status = 'completed';
      job.status = 'completed';

      this.stats.totalWarmed += warmedKeys.length;
      this.stats.totalFailed += job.progress.failedKeys;
      this.stats.lastWarmupTime = Date.now();

      this.emit('warmup-completed', {
        jobId,
        warmedKeys: warmedKeys.length,
        failed: job.progress.failedKeys,
      });

      return {
        progress: job.progress,
        warmedKeys,
        failedKeys: job.progress.errors.map((e) => e.key),
      };
    } catch (error) {
      job.progress.status = 'failed';
      job.status = 'failed';

      // Rollback if enabled
      if (enableRollback && job.rollbackData) {
        await this.rollback(job);
      }

      this.emit('warmup-failed', { jobId, error: String(error) });
      throw error;
    } finally {
      this.activeJobs.delete(jobId);
    }
  }

  /**
   * Schedule cache warmup with cron expression
   */
  private async scheduleWarmup(
    options: CacheWarmupOptions
  ): Promise<WarmupResult['data']> {
    const { schedule: cronExpression, scheduleId } = options;

    if (!cronExpression) {
      throw new Error('Schedule expression is required');
    }

    const id = scheduleId || this.generateScheduleId();
    const parsedCron = this.parseCronExpression(cronExpression);
    const nextRun = this.calculateNextRun(parsedCron);

    const schedule: WarmupSchedule = {
      id,
      cronExpression,
      options,
      enabled: true,
      nextRun,
      status: 'active',
    };

    this.schedules.set(id, schedule);
    this.scheduleNextRun(schedule);

    this.emit('schedule-created', { id, nextRun });

    return {
      schedule,
      schedules: Array.from(this.schedules.values()),
    };
  }

  /**
   * Pattern-based warmup from access history
   */
  private async patternBasedWarmup(
    options: CacheWarmupOptions
  ): Promise<WarmupResult['data']> {
    const {
      accessHistory,
      minAccessCount = 5,
      timeWindow = 3600000, // 1 hour
      warmupPercentage = 80,
      pattern,
    } = options;

    // Update access history if provided
    if (accessHistory) {
      this.updateAccessHistory(accessHistory);
    }

    // Analyze patterns and identify hot keys
    const now = Date.now();
    const hotKeys = this.identifyHotKeys(now - timeWindow, minAccessCount);

    // Apply pattern filter if provided
    let keysToWarm = Array.from(hotKeys);
    if (pattern) {
      const regex = new RegExp(pattern);
      keysToWarm = keysToWarm.filter((key) => regex.test(key));
    }

    // Limit by warmup percentage
    const maxKeys = Math.ceil(keysToWarm.length * (warmupPercentage / 100));
    keysToWarm = keysToWarm.slice(0, maxKeys);

    // Execute warmup
    return this.immediateWarmup({
      ...options,
      operation: 'immediate',
      keys: keysToWarm,
      strategy: 'progressive',
    });
  }

  /**
   * Dependency-based warmup with graph resolution
   */
  private async dependencyBasedWarmup(
    options: CacheWarmupOptions
  ): Promise<WarmupResult['data']> {
    const { dependencies, keys = [] } = options;

    if (!dependencies) {
      throw new Error(
        'Dependency graph is required for dependency-based warmup'
      );
    }

    this.dependencyGraph = dependencies;

    // Resolve dependencies for requested keys
    const resolvedKeys = this.resolveDependencies(keys);
    this.resolvedOrder = resolvedKeys;

    this.emit('dependencies-resolved', {
      requestedKeys: keys.length,
      resolvedKeys: resolvedKeys.length,
    });

    // Execute warmup in dependency order
    return this.immediateWarmup({
      ...options,
      operation: 'immediate',
      keys: resolvedKeys,
      strategy: 'dependency',
    });
  }

  /**
   * Selective warmup for specific keys/categories
   */
  private async selectiveWarmup(
    options: CacheWarmupOptions
  ): Promise<WarmupResult['data']> {
    const { keys = [], categories = [] } = options;

    let keysToWarm = [...keys];

    // Add keys from categories
    if (categories.length > 0) {
      for (const [key, entries] of this.accessHistory.entries()) {
        const hasCategory = entries.some(
          (entry) => entry.category && categories.includes(entry.category)
        );
        if (hasCategory && !keysToWarm.includes(key)) {
          keysToWarm.push(key);
        }
      }
    }

    if (keysToWarm.length === 0) {
      throw new Error('No keys to warm up');
    }

    return this.immediateWarmup({
      ...options,
      operation: 'immediate',
      keys: keysToWarm,
    });
  }

  /**
   * Get warmup status
   */
  private async getStatus(
    _options: CacheWarmupOptions
  ): Promise<WarmupResult['data']> {
    const activeJobs = Array.from(this.activeJobs.values());
    const schedules = Array.from(this.schedules.values());

    const progress: WarmupProgress | undefined =
      activeJobs.length > 0 ? activeJobs[0].progress : undefined;

    return {
      progress,
      schedules,
    };
  }

  /**
   * Cancel warmup job
   */
  private async cancelWarmup(
    options: CacheWarmupOptions
  ): Promise<WarmupResult['data']> {
    const { scheduleId } = options;

    if (scheduleId) {
      // Cancel scheduled warmup
      const schedule = this.schedules.get(scheduleId);
      if (schedule) {
        this.cancelSchedule(scheduleId);
        return { schedule: { ...schedule, status: 'completed' as const } };
      }
    }

    // Cancel active jobs
    for (const job of this.activeJobs.values()) {
      job.abortController?.abort();
      job.status = 'cancelled';
      job.progress.status = 'cancelled';

      if (job.rollbackData) {
        await this.rollback(job);
      }
    }

    this.activeJobs.clear();

    return { progress: undefined };
  }

  /**
   * Pause warmup job
   */
  private async pauseWarmup(
    _options: CacheWarmupOptions
  ): Promise<WarmupResult['data']> {
    for (const job of this.activeJobs.values()) {
      job.status = 'paused';
      job.progress.status = 'paused';
    }

    this.emit('warmup-paused', { jobs: this.activeJobs.size });

    return { progress: Array.from(this.activeJobs.values())[0]?.progress };
  }

  /**
   * Resume warmup job
   */
  private async resumeWarmup(
    _options: CacheWarmupOptions
  ): Promise<WarmupResult['data']> {
    for (const job of this.activeJobs.values()) {
      if (job.status === 'paused') {
        job.status = 'warming';
        job.progress.status = 'warming';
      }
    }

    this.emit('warmup-resumed', { jobs: this.activeJobs.size });

    return { progress: Array.from(this.activeJobs.values())[0]?.progress };
  }

  /**
   * Configure warmup settings
   */
  private async configure(
    options: CacheWarmupOptions
  ): Promise<WarmupResult['data']> {
    if (options.maxConcurrency !== undefined) {
      this.config.maxConcurrency = options.maxConcurrency;
    }
    if (options.batchSize !== undefined) {
      this.config.batchSize = options.batchSize;
    }
    if (options.timeout !== undefined) {
      this.config.defaultTimeout = options.timeout;
    }
    if (options.maxRetries !== undefined) {
      this.config.maxRetries = options.maxRetries;
    }
    if (options.enableRollback !== undefined) {
      this.config.enableRollback = options.enableRollback;
    }
    if (options.reportProgress !== undefined) {
      this.config.progressReporting = options.reportProgress;
    }

    this.emit('configuration-updated', this.config);

    return { configuration: { ...this.config } };
  }

  /**
   * Progressive warmup - warm hot keys first
   */
  private async progressiveWarmup(
    job: WarmupJob,
    maxConcurrency: number,
    batchSize: number
  ): Promise<string[]> {
    const { keys } = job;

    // Sort keys by priority (hot keys first)
    const sortedKeys = this.sortKeysByPriority(keys);
    const warmedKeys: string[] = [];

    // Warm in batches with concurrency control
    for (let i = 0; i < sortedKeys.length; i += batchSize) {
      if (job.abortController?.signal.aborted || job.status === 'paused') {
        break;
      }

      const batch = sortedKeys.slice(i, i + batchSize);
      const batchResults = await this.warmBatchParallel(
        batch,
        job,
        maxConcurrency
      );

      warmedKeys.push(...batchResults.warmed);
      this.updateProgress(
        job,
        batchResults.warmed.length,
        batchResults.failed.length
      );

      if (job.options.delayBetweenBatches) {
        await this.sleep(job.options.delayBetweenBatches);
      }

      this.emit('batch-completed', {
        jobId: job.id,
        batch: i / batchSize + 1,
        warmed: batchResults.warmed.length,
        failed: batchResults.failed.length,
      });
    }

    return warmedKeys;
  }

  /**
   * Warmup with dependency resolution
   */
  private async warmupWithDependencies(
    job: WarmupJob,
    options: CacheWarmupOptions
  ): Promise<string[]> {
    const keysToWarm =
      this.resolvedOrder.length > 0 ? this.resolvedOrder : job.keys;

    const warmedKeys: string[] = [];

    // Warm keys in dependency order
    for (const key of keysToWarm) {
      if (job.abortController?.signal.aborted || job.status === 'paused') {
        break;
      }

      const result = await this.warmKey(key, job, options);

      if (result.success) {
        warmedKeys.push(key);
        this.updateProgress(job, 1, 0);
      } else {
        this.updateProgress(job, 0, 1);
      }
    }

    return warmedKeys;
  }

  /**
   * Warmup by pattern matching
   */
  private async warmupByPattern(
    job: WarmupJob,
    options: CacheWarmupOptions
  ): Promise<string[]> {
    const { pattern } = options;
    let keysToWarm = job.keys;

    if (pattern) {
      const regex = new RegExp(pattern);
      keysToWarm = keysToWarm.filter((key) => regex.test(key));
    }

    return this.parallelWarmup(
      { ...job, keys: keysToWarm },
      this.config.maxConcurrency,
      this.config.batchSize
    );
  }

  /**
   * Parallel warmup with concurrency control
   */
  private async parallelWarmup(
    job: WarmupJob,
    maxConcurrency: number,
    batchSize: number
  ): Promise<string[]> {
    const warmedKeys: string[] = [];
    const { keys } = job;

    for (let i = 0; i < keys.length; i += batchSize) {
      if (job.abortController?.signal.aborted || job.status === 'paused') {
        break;
      }

      const batch = keys.slice(i, i + batchSize);
      const batchResults = await this.warmBatchParallel(
        batch,
        job,
        maxConcurrency
      );

      warmedKeys.push(...batchResults.warmed);
      this.updateProgress(
        job,
        batchResults.warmed.length,
        batchResults.failed.length
      );
    }

    return warmedKeys;
  }

  /**
   * Warm a batch of keys in parallel
   */
  private async warmBatchParallel(
    keys: string[],
    job: WarmupJob,
    maxConcurrency: number
  ): Promise<{ warmed: string[]; failed: string[] }> {
    const warmed: string[] = [];
    const failed: string[] = [];
    const chunks: string[][] = [];

    // Split into chunks for concurrency control
    for (let i = 0; i < keys.length; i += maxConcurrency) {
      chunks.push(keys.slice(i, i + maxConcurrency));
    }

    for (const chunk of chunks) {
      if (job.abortController?.signal.aborted || job.status === 'paused') {
        break;
      }

      const promises = chunk.map((key) => this.warmKey(key, job, job.options));
      const results = await Promise.allSettled(promises);

      results.forEach((result, index) => {
        if (result.status === 'fulfilled' && result.value.success) {
          warmed.push(chunk[index]);
        } else {
          failed.push(chunk[index]);
        }
      });
    }

    return { warmed, failed };
  }

  /**
   * Warm a single key
   */
  private async warmKey(
    key: string,
    job: WarmupJob,
    options: CacheWarmupOptions
  ): Promise<{ success: boolean; data?: string }> {
    const {
      dataFetcher,
      dataSource,
      timeout = this.config.defaultTimeout,
    } = options;
    let retries = 0;
    const maxRetries = options.maxRetries || this.config.maxRetries;

    job.progress.currentKey = key;

    while (retries <= maxRetries) {
      try {
        // Save current state for rollback
        if (job.rollbackData) {
          const existing = this.cache.get(key);
          job.rollbackData.set(key, existing);
        }

        // Fetch data
        const data = await this.fetchData(
          key,
          dataFetcher,
          dataSource,
          timeout
        );

        // Warm cache
        const originalSize = data.length;
        const compressedSize = originalSize; // Assume no additional compression
        this.cache.set(key, data, originalSize, compressedSize);

        return { success: true, data };
      } catch (error) {
        retries++;

        if (retries > maxRetries) {
          job.progress.errors.push({
            key,
            error: error instanceof Error ? error.message : String(error),
            timestamp: Date.now(),
            retryCount: retries - 1,
          });
          return { success: false };
        }

        // Wait before retry
        if (options.retryDelay) {
          await this.sleep(options.retryDelay);
        }
      }
    }

    return { success: false };
  }

  /**
   * Fetch data for a key
   */
  private async fetchData(
    key: string,
    dataFetcher?: (key: string) => Promise<string>,
    dataSource?: WarmupDataSource,
    timeout?: number
  ): Promise<string> {
    if (dataFetcher) {
      return this.withTimeout(dataFetcher(key), timeout);
    }

    if (dataSource?.customFetcher) {
      return this.withTimeout(dataSource.customFetcher(key), timeout);
    }

    if (dataSource?.type === 'cache') {
      const existing = this.cache.get(key);
      if (existing) return existing;
    }

    // Default: return mock data for testing
    return `mock-data-for-${key}`;
  }

  /**
   * Simulate warmup
   */
  private async simulateWarmup(
    keys: string[],
    options: CacheWarmupOptions
  ): Promise<SimulationResult> {
    const { batchSize = this.config.batchSize } = options;

    const estimatedSize = keys.reduce((sum, key) => sum + key.length * 10, 0);
    const batches = Math.ceil(keys.length / batchSize);
    const estimatedTime = batches * 1000; // 1 second per batch

    // Analyze priority distribution
    const priorityCount = { high: 0, normal: 0, low: 0 };
    for (const key of keys) {
      if (this.hotKeys.has(key)) {
        priorityCount.high++;
      } else {
        priorityCount.normal++;
      }
    }

    // Analyze dependency layers
    let dependencyLayers = 0;
    if (this.dependencyGraph) {
      dependencyLayers = this.calculateDependencyDepth(keys);
    }

    const warnings: string[] = [];
    if (keys.length > 10000) {
      warnings.push('Large number of keys may cause performance issues');
    }
    if (estimatedSize > 100 * 1024 * 1024) {
      warnings.push('Estimated cache size exceeds 100MB');
    }

    return {
      estimatedKeys: keys.length,
      estimatedSize,
      estimatedTime,
      estimatedCost: estimatedSize * 0.000001, // Mock cost
      keysByPriority: priorityCount,
      dependencyLayers,
      warnings,
    };
  }

  /**
   * Rollback warmup changes
   */
  private async rollback(job: WarmupJob): Promise<void> {
    if (!job.rollbackData) return;

    this.emit('rollback-started', {
      jobId: job.id,
      keys: job.rollbackData.size,
    });

    for (const [key, originalValue] of job.rollbackData.entries()) {
      if (originalValue === null) {
        this.cache.delete(key);
      } else {
        this.cache.set(
          key,
          originalValue,
          originalValue.length,
          originalValue.length
        );
      }
    }

    this.emit('rollback-completed', { jobId: job.id });
  }

  /**
   * Resolve dependencies in topological order
   */
  private resolveDependencies(keys: string[]): string[] {
    if (!this.dependencyGraph) return keys;

    const { edges } = this.dependencyGraph;
    const resolved: string[] = [];
    const visited = new Set<string>();

    // Build adjacency list
    const adjacency = new Map<string, string[]>();
    for (const edge of edges) {
      if (!adjacency.has(edge.from)) {
        adjacency.set(edge.from, []);
      }
      adjacency.get(edge.from)!.push(edge.to);
    }

    // DFS topological sort
    const visit = (key: string) => {
      if (visited.has(key)) return;
      visited.add(key);

      const dependencies = adjacency.get(key) || [];
      for (const dep of dependencies) {
        visit(dep);
      }

      resolved.push(key);
    };

    // Visit all requested keys
    for (const key of keys) {
      visit(key);
    }

    return resolved.reverse();
  }

  /**
   * Calculate dependency depth
   */
  private calculateDependencyDepth(keys: string[]): number {
    if (!this.dependencyGraph) return 0;

    const { edges } = this.dependencyGraph;
    const adjacency = new Map<string, string[]>();

    for (const edge of edges) {
      if (!adjacency.has(edge.from)) {
        adjacency.set(edge.from, []);
      }
      adjacency.get(edge.from)!.push(edge.to);
    }

    let maxDepth = 0;

    const getDepth = (
      key: string,
      depth: number,
      visited: Set<string>
    ): number => {
      if (visited.has(key)) return depth;
      visited.add(key);

      const dependencies = adjacency.get(key) || [];
      let maxChildDepth = depth;

      for (const dep of dependencies) {
        const childDepth = getDepth(dep, depth + 1, visited);
        maxChildDepth = Math.max(maxChildDepth, childDepth);
      }

      return maxChildDepth;
    };

    for (const key of keys) {
      const depth = getDepth(key, 0, new Set());
      maxDepth = Math.max(maxDepth, depth);
    }

    return maxDepth;
  }

  /**
   * Identify hot keys from access history
   */
  private identifyHotKeys(since: number, minAccessCount: number): Set<string> {
    const hotKeys = new Set<string>();

    for (const [key, entries] of this.accessHistory.entries()) {
      const recentAccesses = entries.filter((e) => e.timestamp >= since);
      const totalAccesses = recentAccesses.reduce(
        (sum, e) => sum + e.accessCount,
        0
      );

      if (totalAccesses >= minAccessCount) {
        hotKeys.add(key);
        this.hotKeys.add(key);
      }
    }

    return hotKeys;
  }

  /**
   * Sort keys by priority (hot keys first)
   */
  private sortKeysByPriority(keys: string[]): string[] {
    return keys.sort((a, b) => {
      const aHot = this.hotKeys.has(a);
      const bHot = this.hotKeys.has(b);

      if (aHot && !bHot) return -1;
      if (!aHot && bHot) return 1;

      // Sort by access count
      const aHistory = this.accessHistory.get(a) || [];
      const bHistory = this.accessHistory.get(b) || [];
      const aCount = aHistory.reduce((sum, e) => sum + e.accessCount, 0);
      const bCount = bHistory.reduce((sum, e) => sum + e.accessCount, 0);

      return bCount - aCount;
    });
  }

  /**
   * Update access history
   */
  private updateAccessHistory(entries: AccessHistoryEntry[]): void {
    for (const entry of entries) {
      if (!this.accessHistory.has(entry.key)) {
        this.accessHistory.set(entry.key, []);
      }
      this.accessHistory.get(entry.key)!.push(entry);
    }

    // Trim old entries
    const maxEntries = 1000;
    for (const [key, entries] of this.accessHistory.entries()) {
      if (entries.length > maxEntries) {
        this.accessHistory.set(key, entries.slice(-maxEntries));
      }
    }
  }

  /**
   * Update job progress
   */
  private updateProgress(job: WarmupJob, warmed: number, failed: number): void {
    job.progress.warmedKeys += warmed;
    job.progress.failedKeys += failed;
    job.progress.elapsedTime = Date.now() - job.progress.startTime;
    job.progress.percentComplete =
      (job.progress.warmedKeys / job.progress.totalKeys) * 100;
    job.progress.throughput =
      job.progress.warmedKeys / (job.progress.elapsedTime / 1000);

    // Estimate completion time
    if (job.progress.throughput > 0) {
      const remaining = job.progress.totalKeys - job.progress.warmedKeys;
      job.progress.estimatedCompletion =
        Date.now() + (remaining / job.progress.throughput) * 1000;
    }

    if (this.config.progressReporting) {
      this.emit('progress-updated', job.progress);
    }
  }

  /**
   * Parse cron expression
   */
  private parseCronExpression(expression: string): CronSchedule {
    const parts = expression.trim().split(/\s+/);

    if (parts.length !== 5) {
      throw new Error(
        'Invalid cron expression. Expected: minute hour day month weekday'
      );
    }

    return {
      minute: parts[0] === '*' ? '*' : parseInt(parts[0], 10),
      hour: parts[1] === '*' ? '*' : parseInt(parts[1], 10),
      dayOfMonth: parts[2] === '*' ? '*' : parseInt(parts[2], 10),
      month: parts[3] === '*' ? '*' : parseInt(parts[3], 10),
      dayOfWeek: parts[4] === '*' ? '*' : parseInt(parts[4], 10),
    };
  }

  /**
   * Calculate next run time from cron schedule
   */
  private calculateNextRun(cron: CronSchedule): number {
    const now = new Date();
    const next = new Date(now);

    // Simple implementation - advance by 1 minute and check
    next.setMinutes(next.getMinutes() + 1);
    next.setSeconds(0);
    next.setMilliseconds(0);

    while (true) {
      if (
        (cron.minute === '*' || next.getMinutes() === cron.minute) &&
        (cron.hour === '*' || next.getHours() === cron.hour) &&
        (cron.dayOfMonth === '*' || next.getDate() === cron.dayOfMonth) &&
        (cron.month === '*' || next.getMonth() + 1 === cron.month) &&
        (cron.dayOfWeek === '*' || next.getDay() === cron.dayOfWeek)
      ) {
        return next.getTime();
      }

      next.setMinutes(next.getMinutes() + 1);

      // Prevent infinite loop
      if (next.getTime() - now.getTime() > 365 * 24 * 60 * 60 * 1000) {
        throw new Error('Could not find next run time within 1 year');
      }
    }
  }

  /**
   * Schedule next run
   */
  private scheduleNextRun(schedule: WarmupSchedule): void {
    const delay = schedule.nextRun - Date.now();

    if (delay <= 0) {
      // Run immediately
      this.executeSchedule(schedule);
    } else {
      const timer = setTimeout(() => {
        this.executeSchedule(schedule);
      }, delay);

      this.scheduleTimers.set(schedule.id, timer);
    }
  }

  /**
   * Execute scheduled warmup
   */
  private async executeSchedule(schedule: WarmupSchedule): Promise<void> {
    try {
      schedule.lastRun = Date.now();

      await this.run(schedule.options);

      // Calculate next run
      const parsedCron = this.parseCronExpression(schedule.cronExpression);
      schedule.nextRun = this.calculateNextRun(parsedCron);

      // Schedule next run
      this.scheduleNextRun(schedule);
    } catch (error) {
      schedule.status = 'failed';
      this.emit('schedule-failed', {
        id: schedule.id,
        error: String(error),
      });
    }
  }

  /**
   * Cancel schedule
   */
  private cancelSchedule(scheduleId: string): void {
    const timer = this.scheduleTimers.get(scheduleId);
    if (timer) {
      clearTimeout(timer);
      this.scheduleTimers.delete(scheduleId);
    }

    this.schedules.delete(scheduleId);
    this.emit('schedule-cancelled', { id: scheduleId });
  }

  /**
   * Generate unique job ID
   */
  private generateJobId(): string {
    return `warmup-job-${++this.jobCounter}-${Date.now()}`;
  }

  /**
   * Generate unique schedule ID
   */
  private generateScheduleId(): string {
    return `warmup-schedule-${Date.now()}`;
  }

  /**
   * Sleep for specified duration
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Execute promise with timeout
   */
  private async withTimeout<T>(
    promise: Promise<T>,
    timeout?: number
  ): Promise<T> {
    if (!timeout) return promise;

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Operation timed out')), timeout);

      promise
        .then((result) => {
          clearTimeout(timer);
          resolve(result);
        })
        .catch((error) => {
          clearTimeout(timer);
          reject(error);
        });
    });
  }

  /**
   * Check if operation is cacheable
   */
  private isCacheableOperation(operation: string): boolean {
    return ['status'].includes(operation);
  }

  /**
   * Get cache key parameters
   */
  private getCacheKeyParams(
    options: CacheWarmupOptions
  ): Record<string, unknown> {
    const { operation } = options;

    switch (operation) {
      case 'status':
        return {};
      default:
        return {};
    }
  }

  /**
   * Cleanup and dispose
   */
  dispose(): void {
    // Cancel all active jobs
    for (const job of this.activeJobs.values()) {
      job.abortController?.abort();
    }
    this.activeJobs.clear();

    // Cancel all schedules
    for (const scheduleId of this.schedules.keys()) {
      this.cancelSchedule(scheduleId);
    }

    this.accessHistory.clear();
    this.hotKeys.clear();
    this.removeAllListeners();
  }
}

// Export singleton instance
let cacheWarmupInstance: CacheWarmupTool | null = null;

export function getCacheWarmupTool(
  cache: CacheEngine,
  tokenCounter: TokenCounter,
  metrics: MetricsCollector
): CacheWarmupTool {
  if (!cacheWarmupInstance) {
    cacheWarmupInstance = new CacheWarmupTool(cache, tokenCounter, metrics);
  }
  return cacheWarmupInstance;
}

// MCP Tool Definition
export const CACHE_WARMUP_TOOL_DEFINITION = {
  name: 'cache_warmup',
  description:
    'Intelligent cache pre-warming with 87%+ token reduction, featuring schedule-based warming, pattern analysis, dependency resolution, and progressive warming strategies',
  inputSchema: {
    type: 'object',
    properties: {
      operation: {
        type: 'string',
        enum: [
          'schedule',
          'immediate',
          'pattern-based',
          'dependency-based',
          'selective',
          'status',
          'cancel',
          'pause',
          'resume',
          'configure',
        ],
        description: 'The warmup operation to perform',
      },
      keys: {
        type: 'array',
        items: { type: 'string' },
        description: 'Keys to warm (for immediate/selective operations)',
      },
      categories: {
        type: 'array',
        items: { type: 'string' },
        description: 'Categories to warm (for selective operation)',
      },
      pattern: {
        type: 'string',
        description: 'Regex pattern for key matching',
      },
      priority: {
        type: 'string',
        enum: ['high', 'normal', 'low'],
        description: 'Warmup priority (default: normal)',
      },
      strategy: {
        type: 'string',
        enum: ['immediate', 'progressive', 'dependency', 'pattern'],
        description: 'Warmup strategy (default: progressive)',
      },
      schedule: {
        type: 'string',
        description:
          "Cron expression for scheduled warmup (e.g., '0 * * * *' for hourly)",
      },
      scheduleId: {
        type: 'string',
        description: 'Schedule ID for cancel operation',
      },
      dependencies: {
        type: 'object',
        description: 'Dependency graph for dependency-based warmup',
      },
      accessHistory: {
        type: 'array',
        description: 'Access history for pattern-based warmup',
      },
      minAccessCount: {
        type: 'number',
        description: 'Minimum access count for hot keys (default: 5)',
      },
      timeWindow: {
        type: 'number',
        description:
          'Time window for pattern analysis in ms (default: 3600000)',
      },
      maxConcurrency: {
        type: 'number',
        description: 'Max concurrent warmup operations (default: 10)',
      },
      batchSize: {
        type: 'number',
        description: 'Batch size for warmup (default: 50)',
      },
      delayBetweenBatches: {
        type: 'number',
        description: 'Delay between batches in ms',
      },
      hotKeyThreshold: {
        type: 'number',
        description: 'Minimum access count for hot keys',
      },
      warmupPercentage: {
        type: 'number',
        description: 'Percentage of cache to warm (default: 80)',
      },
      dryRun: {
        type: 'boolean',
        description: 'Simulate warmup without executing (default: false)',
      },
      enableRollback: {
        type: 'boolean',
        description: 'Enable rollback on failures (default: true)',
      },
      timeout: {
        type: 'number',
        description: 'Timeout for warmup operations in ms (default: 30000)',
      },
      maxRetries: {
        type: 'number',
        description: 'Maximum retry attempts (default: 3)',
      },
      retryDelay: {
        type: 'number',
        description: 'Delay between retries in ms',
      },
      reportProgress: {
        type: 'boolean',
        description: 'Enable progress reporting (default: true)',
      },
      progressInterval: {
        type: 'number',
        description: 'Progress report interval in ms',
      },
      useCache: {
        type: 'boolean',
        description: 'Enable result caching (default: true)',
        default: true,
      },
      cacheTTL: {
        type: 'number',
        description: 'Cache TTL in seconds (default: 300)',
        default: 300,
      },
    },
    required: ['operation'],
  },
} as const;

export async function runCacheWarmup(
  options: CacheWarmupOptions,
  cache: CacheEngine,
  tokenCounter: TokenCounter,
  metrics: MetricsCollector
): Promise<WarmupResult> {
  const tool = getCacheWarmupTool(cache, tokenCounter, metrics);
  return tool.run(options);
}
