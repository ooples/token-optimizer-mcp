/**
 * Configuration management for Hypercontext MCP
 */

import { z } from 'zod';
import { HypercontextConfig, OptimizationConfig } from './types.js';
import { readFileSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

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

const OptimizationConfigSchema = z.object({
  compressionTokenThreshold: z.number().min(0).max(1),
  compressionPreserveThreshold: z.number().min(0).max(1),
  minTokensBeforeCompression: z.number().int().nonnegative(),
  modelTokenLimits: z.record(z.string(), z.number().int().positive()),
  minOutputSizeBytes: z.number().int().nonnegative(),
  quality: z.enum(['fast', 'balanced', 'max']),
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
    optimization: OptimizationConfigSchema.partial().optional(),
  })
  .passthrough();

export class ConfigManager {
  private config: HypercontextConfig;
  private configPath: string;

  constructor(configPath?: string) {
    this.configPath =
      configPath || join(homedir(), '.hypercontext', 'config.json');
    this.config = this.loadConfig();
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
      optimization?: Partial<OptimizationConfig>;
    }
  ): HypercontextConfig {
    return {
      cache: { ...defaults.cache, ...user.cache },
      monitoring: { ...defaults.monitoring, ...user.monitoring },
      intelligence: { ...defaults.intelligence, ...user.intelligence },
      performance: { ...defaults.performance, ...user.performance },
      optimization: { ...DEFAULT_OPTIMIZATION, ...(user.optimization ?? {}) },
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
