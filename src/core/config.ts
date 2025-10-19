/**
 * Configuration management for Hypercontext MCP
 */

import { HypercontextConfig } from './types.js';
import { readFileSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

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
};

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
      const userConfig = JSON.parse(fileContent);
      return this.mergeConfig(DEFAULT_CONFIG, userConfig);
    } catch (error) {
      console.warn('Failed to load config, using defaults:', error);
      return DEFAULT_CONFIG;
    }
  }

  private mergeConfig(
    defaults: HypercontextConfig,
    user: Partial<HypercontextConfig>
  ): HypercontextConfig {
    return {
      cache: { ...defaults.cache, ...user.cache },
      monitoring: { ...defaults.monitoring, ...user.monitoring },
      intelligence: { ...defaults.intelligence, ...user.intelligence },
      performance: { ...defaults.performance, ...user.performance },
    };
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
