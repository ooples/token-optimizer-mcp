/**
 * Configuration management for Hypercontext MCP
 */

import { z } from 'zod';
import { HypercontextConfig, OptimizationConfig } from './types.js';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';

const DEFAULT_OPTIMIZATION: OptimizationConfig = {
  compressionTokenThreshold: 0.7,
  compressionPreserveThreshold: 0.3,
  minTokensBeforeCompression: 1000,
  modelTokenLimits: {
    'gpt-4': 128000,
    'gpt-4-turbo': 128000,
    'gpt-3.5-turbo': 16385,
    'claude-3-opus': 200000,
    'claude-3-sonnet': 200000,
    'claude-3-haiku': 200000,
    'claude-opus-4-7': 1000000,
    'claude-sonnet-4-6': 1000000,
    'gemini-1.5-pro': 2000000,
    'gemini-2.5-flash': 1000000,
  },
  minOutputSizeBytes: 500,
  quality: 'balanced',
  cacheSettings: {
    maxSize: 1000,
    ttlSeconds: 3600,
  },
  chatCompression: {
    enabled: true,
    strategy: 'summarize',
  },
};

const DEFAULT_CONFIG: HypercontextConfig = {
  cache: {
    enabled: true,
    maxSizeMB: 500,
    defaultTTL: 300, // 5 minutes
    ttlByType: {
      file_read: 300,
      git_status: 60,
      git_diff: 120,
      build_result: 600,
      test_result: 300,
    },
    compression: 'auto',
  },
  monitoring: {
    enabled: true,
    detailedLogging: false,
    metricsRetentionDays: 30,
    dashboardPort: 3100,
    enableWebUI: false,
  },
  intelligence: {
    enablePatternDetection: false,
    enableWorkflowLearning: false,
    enablePredictiveCaching: false,
  },
  performance: {
    maxConcurrentOps: 10,
    streamingThreshold: 1024 * 1024, // 1MB
    enableStreaming: false,
  },
  optimization: DEFAULT_OPTIMIZATION,
};

const CacheSettingsSchema = z.object({
  maxSize: z.number().int().positive(),
  ttlSeconds: z.number().int().nonnegative(),
});

const ChatCompressionSchema = z.object({
  enabled: z.boolean(),
  tokenLimit: z.number().int().positive().optional(),
  strategy: z.enum(['summarize', 'truncate']),
});

const OptimizationConfigSchema = z.object({
  compressionTokenThreshold: z.number().min(0).max(1),
  compressionPreserveThreshold: z.number().min(0).max(1),
  minTokensBeforeCompression: z.number().int().nonnegative(),
  modelTokenLimits: z.record(z.string(), z.number().int().positive()),
  minOutputSizeBytes: z.number().int().nonnegative(),
  quality: z.enum(['fast', 'balanced', 'max']),
  cacheSettings: CacheSettingsSchema,
  chatCompression: ChatCompressionSchema,
});

/**
 * User-supplied optimization schema. Partial at every depth so users can
 * override just one field (e.g. `{ cacheSettings: { maxSize: 42 } }`)
 * without having to re-supply the entire sub-object.
 */
const OptimizationConfigUserSchema = OptimizationConfigSchema.partial().extend({
  cacheSettings: CacheSettingsSchema.partial().optional(),
  chatCompression: ChatCompressionSchema.partial().optional(),
});

const HypercontextConfigSchema = z
  .object({
    cache: z
      .object({
        enabled: z.boolean(),
        maxSizeMB: z.number().int().positive(),
        defaultTTL: z.number().int().nonnegative(),
        ttlByType: z.record(z.string(), z.number().int().nonnegative()),
        compression: z.enum(['none', 'gzip', 'brotli', 'auto']),
      })
      .partial()
      .optional(),
    monitoring: z
      .object({
        enabled: z.boolean(),
        detailedLogging: z.boolean(),
        metricsRetentionDays: z.number().int().nonnegative(),
        dashboardPort: z.number().int().positive(),
        enableWebUI: z.boolean(),
      })
      .partial()
      .optional(),
    intelligence: z
      .object({
        enablePatternDetection: z.boolean(),
        enableWorkflowLearning: z.boolean(),
        enablePredictiveCaching: z.boolean(),
        mlModelPath: z.string(),
      })
      .partial()
      .optional(),
    performance: z
      .object({
        maxConcurrentOps: z.number().int().positive(),
        streamingThreshold: z.number().int().positive(),
        enableStreaming: z.boolean(),
      })
      .partial()
      .optional(),
    optimization: OptimizationConfigUserSchema.optional(),
  })
  .passthrough();

export class ConfigManager {
  private config: HypercontextConfig;
  private configPath: string;

  constructor(configPath?: string, options: { writeDefaults?: boolean } = {}) {
    this.configPath =
      configPath || join(homedir(), '.token-optimizer', 'config.json');
    const writeDefaults = options.writeDefaults ?? true;
    if (writeDefaults && !existsSync(this.configPath)) {
      this.writeDefaultConfig();
    }
    this.config = this.loadConfig();
  }

  /**
   * Write DEFAULT_CONFIG to configPath on first run — addresses #120's
   * "Default config created on first run" acceptance criterion.
   * Errors are logged and non-fatal; callers still get an in-memory
   * DEFAULT_CONFIG via loadConfig().
   */
  private writeDefaultConfig(): void {
    try {
      const dir = dirname(this.configPath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      writeFileSync(this.configPath, JSON.stringify(DEFAULT_CONFIG, null, 2));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(
        `ConfigManager: failed to write default config to ${this.configPath}: ${message}`
      );
    }
  }

  private loadConfig(): HypercontextConfig {
    if (!existsSync(this.configPath)) {
      return DEFAULT_CONFIG;
    }

    try {
      const fileContent = readFileSync(this.configPath, 'utf-8');
      const rawUserConfig = JSON.parse(fileContent);
      const parsed = HypercontextConfigSchema.safeParse(rawUserConfig);
      if (!parsed.success) {
        const issues = parsed.error.issues
          .map((i) => `  - ${i.path.join('.') || 'root'}: ${i.message}`)
          .join('\n');
        console.warn(
          `Invalid config at ${this.configPath}, using defaults:\n${issues}`
        );
        return DEFAULT_CONFIG;
      }
      return this.mergeConfig(DEFAULT_CONFIG, parsed.data);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`Failed to load config, using defaults: ${message}`);
      return DEFAULT_CONFIG;
    }
  }

  private mergeConfig(
    defaults: HypercontextConfig,
    user: {
      cache?: Partial<HypercontextConfig['cache']>;
      monitoring?: Partial<HypercontextConfig['monitoring']>;
      intelligence?: Partial<HypercontextConfig['intelligence']>;
      performance?: Partial<HypercontextConfig['performance']>;
      optimization?: Partial<
        Omit<OptimizationConfig, 'cacheSettings' | 'chatCompression'>
      > & {
        cacheSettings?: Partial<OptimizationConfig['cacheSettings']>;
        chatCompression?: Partial<OptimizationConfig['chatCompression']>;
      };
    }
  ): HypercontextConfig {
    const userOpt = user.optimization ?? {};
    return {
      cache: { ...defaults.cache, ...user.cache },
      monitoring: { ...defaults.monitoring, ...user.monitoring },
      intelligence: { ...defaults.intelligence, ...user.intelligence },
      performance: { ...defaults.performance, ...user.performance },
      optimization: {
        ...DEFAULT_OPTIMIZATION,
        ...userOpt,
        cacheSettings: {
          ...DEFAULT_OPTIMIZATION.cacheSettings,
          ...(userOpt.cacheSettings ?? {}),
        },
        chatCompression: {
          ...DEFAULT_OPTIMIZATION.chatCompression,
          ...(userOpt.chatCompression ?? {}),
        },
      },
    };
  }

  public getOptimizationConfig(): OptimizationConfig {
    return this.config.optimization ?? DEFAULT_OPTIMIZATION;
  }

  public getModelTokenLimit(modelName: string): number | undefined {
    return this.getOptimizationConfig().modelTokenLimits[modelName];
  }

  get(): HypercontextConfig {
    return { ...this.config };
  }

  update(updates: Partial<HypercontextConfig>): void {
    this.config = this.mergeConfig(this.config, updates);
  }

  getCacheTTL(type: string): number {
    return this.config.cache.ttlByType[type] ?? this.config.cache.defaultTTL;
  }

  isCacheEnabled(): boolean {
    return this.config.cache.enabled;
  }

  isMonitoringEnabled(): boolean {
    return this.config.monitoring.enabled;
  }
}
