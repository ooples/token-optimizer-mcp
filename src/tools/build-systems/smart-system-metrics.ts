/**
 * Smart System Metrics Tool - System Resource Monitoring
 *
 * Provides intelligent system monitoring with:
 * - CPU, memory, disk usage tracking
 * - Anomaly detection
 * - Performance recommendations
 * - Token-optimized output
 */

import { spawn } from 'child_process';
import { CacheEngine } from '../../core/cache-engine.js';
import { createHash } from 'crypto';
import { homedir } from 'os';
import { join } from 'path';
import * as os from 'os';

interface CpuMetrics {
  usage: number;
  cores: number;
  model: string;
  speed: number;
}

interface MemoryMetrics {
  total: number;
  used: number;
  free: number;
  usagePercent: number;
}

interface DiskMetrics {
  total: number;
  used: number;
  free: number;
  usagePercent: number;
  path: string;
}

interface SystemMetrics {
  timestamp: number;
  cpu: CpuMetrics;
  memory: MemoryMetrics;
  disk: DiskMetrics[];
  uptime: number;
  loadAverage: number[];
}

interface MetricsResult {
  success: boolean;
  current: SystemMetrics;
  previous?: SystemMetrics;
  anomalies: Array<{
    type: 'cpu' | 'memory' | 'disk';
    severity: 'critical' | 'warning' | 'info';
    message: string;
  }>;
  duration: number;
  timestamp: number;
}

interface SmartSystemMetricsOptions {
  /**
   * Force operation (ignore cache)
   */
  force?: boolean;

  /**
   * Project root directory
   */
  projectRoot?: string;

  /**
   * Include disk metrics
   */
  includeDisk?: boolean;

  /**
   * Disk paths to monitor (default: root partition)
   */
  diskPaths?: string[];

  /**
   * Detect anomalies by comparing with previous snapshot
   */
  detectAnomalies?: boolean;

  /**
   * Maximum cache age in seconds (default: 60 = 1 minute for metrics)
   */
  maxCacheAge?: number;
}

interface SmartSystemMetricsOutput {
  /**
   * Summary
   */
  summary: {
    success: boolean;
    timestamp: string;
    uptime: string;
    duration: number;
    fromCache: boolean;
  };

  /**
   * CPU metrics
   */
  cpu: {
    usage: number;
    cores: number;
    model: string;
    speed: number;
    status: 'normal' | 'high' | 'critical';
  };

  /**
   * Memory metrics
   */
  memory: {
    total: string;
    used: string;
    free: string;
    usagePercent: number;
    status: 'normal' | 'high' | 'critical';
  };

  /**
   * Disk metrics
   */
  disk: Array<{
    path: string;
    total: string;
    used: string;
    free: string;
    usagePercent: number;
    status: 'normal' | 'high' | 'critical';
  }>;

  /**
   * Detected anomalies
   */
  anomalies: Array<{
    type: string;
    severity: string;
    message: string;
  }>;

  /**
   * Performance recommendations
   */
  recommendations: Array<{
    type: 'cpu' | 'memory' | 'disk' | 'general';
    message: string;
    impact: 'high' | 'medium' | 'low';
  }>;

  /**
   * Token reduction metrics
   */
  metrics: {
    originalTokens: number;
    compactedTokens: number;
    reductionPercentage: number;
  };
}

export class SmartSystemMetrics {
  private cache: CacheEngine;
  private cacheNamespace = 'smart_system_metrics';

  constructor(cache: CacheEngine, _projectRoot?: string) {
    this.cache = cache;
  }

  /**
   * Collect and analyze system metrics
   */
  async run(
    options: SmartSystemMetricsOptions = {}
  ): Promise<SmartSystemMetricsOutput> {
    const {
      force = false,
      includeDisk = true,
      diskPaths = ['/'],
      detectAnomalies = true,
      maxCacheAge = 60, // Short cache for metrics
    } = options;

    const startTime = Date.now();

    // Generate cache key
    const cacheKey = this.generateCacheKey(includeDisk, diskPaths);

    // Check cache first (unless force mode)
    if (!force) {
      const cached = this.getCachedResult(cacheKey, maxCacheAge);
      if (cached) {
        const recommendations = this.generateRecommendations(cached);
        return this.transformOutput(cached, recommendations, true);
      }
    }

    // Get previous metrics for anomaly detection
    const cachedResult = detectAnomalies
      ? this.getCachedResult(cacheKey, 3600)
      : null;
    const previous = cachedResult?.current || null;

    // Collect current metrics
    const result = await this.collectMetrics({
      includeDisk,
      diskPaths,
      previous: previous || undefined,
    });

    const duration = Date.now() - startTime;
    result.duration = duration;

    // Cache the result
    this.cacheResult(cacheKey, result);

    // Generate recommendations
    const recommendations = this.generateRecommendations(result);

    // Transform to smart output
    return this.transformOutput(result, recommendations);
  }

  /**
   * Collect system metrics
   */
  private async collectMetrics(options: {
    includeDisk: boolean;
    diskPaths: string[];
    previous?: SystemMetrics;
  }): Promise<MetricsResult> {
    const { includeDisk, diskPaths, previous } = options;

    // Collect CPU metrics
    const cpu = await this.getCpuMetrics();

    // Collect memory metrics
    const memory = this.getMemoryMetrics();

    // Collect disk metrics
    const disk = includeDisk ? await this.getDiskMetrics(diskPaths) : [];

    // System uptime
    const uptime = os.uptime();

    // Load average
    const loadAverage = os.loadavg();

    const current: SystemMetrics = {
      timestamp: Date.now(),
      cpu,
      memory,
      disk,
      uptime,
      loadAverage,
    };

    // Detect anomalies
    const anomalies = previous ? this.detectAnomalies(current, previous) : [];

    return {
      success: true,
      current,
      previous,
      anomalies,
      duration: 0, // Set by caller
      timestamp: Date.now(),
    };
  }

  /**
   * Get CPU metrics
   */
  private async getCpuMetrics(): Promise<CpuMetrics> {
    const cpus = os.cpus();

    // Calculate CPU usage
    const usage = await this.calculateCpuUsage();

    return {
      usage,
      cores: cpus.length,
      model: cpus[0].model,
      speed: cpus[0].speed,
    };
  }

  /**
   * Calculate CPU usage percentage
   */
  private async calculateCpuUsage(): Promise<number> {
    const cpus1 = os.cpus();
    const idle1 = cpus1.reduce((acc, cpu) => acc + cpu.times.idle, 0);
    const total1 = cpus1.reduce(
      (acc, cpu) =>
        acc +
        cpu.times.user +
        cpu.times.nice +
        cpu.times.sys +
        cpu.times.idle +
        cpu.times.irq,
      0
    );

    // Wait 100ms
    await new Promise((resolve) => setTimeout(resolve, 100));

    const cpus2 = os.cpus();
    const idle2 = cpus2.reduce((acc, cpu) => acc + cpu.times.idle, 0);
    const total2 = cpus2.reduce(
      (acc, cpu) =>
        acc +
        cpu.times.user +
        cpu.times.nice +
        cpu.times.sys +
        cpu.times.idle +
        cpu.times.irq,
      0
    );

    const idleDiff = idle2 - idle1;
    const totalDiff = total2 - total1;

    const usage = 100 - (100 * idleDiff) / totalDiff;
    return Math.round(usage * 100) / 100;
  }

  /**
   * Get memory metrics
   */
  private getMemoryMetrics(): MemoryMetrics {
    const total = os.totalmem();
    const free = os.freemem();
    const used = total - free;
    const usagePercent = (used / total) * 100;

    return {
      total,
      used,
      free,
      usagePercent: Math.round(usagePercent * 100) / 100,
    };
  }

  /**
   * Get disk metrics
   */
  private async getDiskMetrics(paths: string[]): Promise<DiskMetrics[]> {
    const metrics: DiskMetrics[] = [];

    for (const path of paths) {
      const diskInfo = await this.getDiskInfo(path);
      if (diskInfo) {
        metrics.push(diskInfo);
      }
    }

    return metrics;
  }

  /**
   * Get disk info for a specific path
   */
  private async getDiskInfo(path: string): Promise<DiskMetrics | null> {
    return new Promise((resolve) => {
      let output = '';

      // Platform-specific disk info commands
      let command: string;
      let args: string[];

      if (process.platform === 'win32') {
        // Windows: use wmic
        command = 'wmic';
        args = ['logicaldisk', 'get', 'size,freespace,caption'];
      } else {
        // Unix: use df
        command = 'df';
        args = ['-k', path];
      }

      const child = spawn(command, args, { shell: true });

      child.stdout.on('data', (data) => {
        output += data.toString();
      });

      child.on('close', () => {
        const parsed = this.parseDiskOutput(output, path);
        resolve(parsed);
      });

      child.on('error', () => {
        resolve(null);
      });
    });
  }

  /**
   * Parse disk output
   */
  private parseDiskOutput(output: string, path: string): DiskMetrics | null {
    if (process.platform === 'win32') {
      // Parse Windows wmic output
      const lines = output.split('\n').filter((l) => l.trim());
      // Format: Caption  FreeSpace  Size
      const dataLine = lines.find((l) => l.includes('C:'));
      if (dataLine) {
        const parts = dataLine.trim().split(/\s+/);
        if (parts.length >= 3) {
          const free = parseInt(parts[1], 10);
          const total = parseInt(parts[2], 10);
          const used = total - free;
          const usagePercent = (used / total) * 100;

          return {
            path: parts[0],
            total,
            used,
            free,
            usagePercent: Math.round(usagePercent * 100) / 100,
          };
        }
      }
    } else {
      // Parse Unix df output
      const lines = output.split('\n').filter((l) => l.trim());
      const dataLine = lines[1]; // First line is header
      if (dataLine) {
        const parts = dataLine.trim().split(/\s+/);
        if (parts.length >= 6) {
          const total = parseInt(parts[1], 10) * 1024; // Convert KB to bytes
          const used = parseInt(parts[2], 10) * 1024;
          const free = parseInt(parts[3], 10) * 1024;
          const usagePercent = parseFloat(parts[4].replace('%', ''));

          return {
            path,
            total,
            used,
            free,
            usagePercent,
          };
        }
      }
    }

    return null;
  }

  /**
   * Detect anomalies by comparing current with previous
   */
  private detectAnomalies(
    current: SystemMetrics,
    previous: SystemMetrics
  ): Array<{
    type: 'cpu' | 'memory' | 'disk';
    severity: 'critical' | 'warning' | 'info';
    message: string;
  }> {
    const anomalies: Array<{
      type: 'cpu' | 'memory' | 'disk';
      severity: 'critical' | 'warning' | 'info';
      message: string;
    }> = [];

    // CPU spike detection
    const cpuDiff = current.cpu.usage - previous.cpu.usage;
    if (cpuDiff > 30) {
      anomalies.push({
        type: 'cpu',
        severity: cpuDiff > 50 ? 'critical' : 'warning',
        message: `CPU usage spike: increased by ${cpuDiff.toFixed(1)}% (now at ${current.cpu.usage.toFixed(1)}%)`,
      });
    }

    // Memory spike detection
    const memDiff = current.memory.usagePercent - previous.memory.usagePercent;
    if (memDiff > 20) {
      anomalies.push({
        type: 'memory',
        severity: memDiff > 40 ? 'critical' : 'warning',
        message: `Memory usage spike: increased by ${memDiff.toFixed(1)}% (now at ${current.memory.usagePercent.toFixed(1)}%)`,
      });
    }

    // Disk usage growth
    for (const currentDisk of current.disk) {
      const previousDisk = previous.disk.find(
        (d) => d.path === currentDisk.path
      );
      if (previousDisk) {
        const diskDiff = currentDisk.usagePercent - previousDisk.usagePercent;
        if (diskDiff > 5) {
          anomalies.push({
            type: 'disk',
            severity: diskDiff > 10 ? 'warning' : 'info',
            message: `Disk ${currentDisk.path} usage increased by ${diskDiff.toFixed(1)}% (now at ${currentDisk.usagePercent.toFixed(1)}%)`,
          });
        }
      }
    }

    return anomalies;
  }

  /**
   * Generate performance recommendations
   */
  private generateRecommendations(result: MetricsResult): Array<{
    type: 'cpu' | 'memory' | 'disk' | 'general';
    message: string;
    impact: 'high' | 'medium' | 'low';
  }> {
    const recommendations = [];

    // CPU recommendations
    if (result.current.cpu.usage > 80) {
      recommendations.push({
        type: 'cpu' as const,
        message: `High CPU usage (${result.current.cpu.usage.toFixed(1)}%). Consider profiling to find bottlenecks.`,
        impact: 'high' as const,
      });
    }

    // Memory recommendations
    if (result.current.memory.usagePercent > 85) {
      recommendations.push({
        type: 'memory' as const,
        message: `High memory usage (${result.current.memory.usagePercent.toFixed(1)}%). Check for memory leaks.`,
        impact: 'high' as const,
      });
    }

    // Disk recommendations
    for (const disk of result.current.disk) {
      if (disk.usagePercent > 90) {
        recommendations.push({
          type: 'disk' as const,
          message: `Disk ${disk.path} is ${disk.usagePercent.toFixed(1)}% full. Clean up old files or expand storage.`,
          impact: 'high' as const,
        });
      } else if (disk.usagePercent > 80) {
        recommendations.push({
          type: 'disk' as const,
          message: `Disk ${disk.path} is ${disk.usagePercent.toFixed(1)}% full. Monitor space usage.`,
          impact: 'medium' as const,
        });
      }
    }

    // Load average recommendations (Unix-like systems)
    if (result.current.loadAverage.length > 0) {
      const load1 = result.current.loadAverage[0];
      const cores = result.current.cpu.cores;
      if (load1 > cores * 1.5) {
        recommendations.push({
          type: 'general' as const,
          message: `High system load (${load1.toFixed(2)} on ${cores} cores). System may be overloaded.`,
          impact: 'high' as const,
        });
      }
    }

    return recommendations;
  }

  /**
   * Generate cache key
   */
  private generateCacheKey(includeDisk: boolean, diskPaths: string[]): string {
    const keyParts = [includeDisk.toString(), diskPaths.join(',')];
    return createHash('md5').update(keyParts.join(':')).digest('hex');
  }

  /**
   * Get cached result
   */
  private getCachedResult(key: string, maxAge: number): MetricsResult | null {
    const cached = this.cache.get(this.cacheNamespace + ':' + key);
    if (!cached) return null;

    try {
      const result = JSON.parse(cached) as MetricsResult & { cachedAt: number };
      const age = (Date.now() - result.cachedAt) / 1000;

      if (age <= maxAge) {
        return result;
      }
    } catch (err) {
      return null;
    }

    return null;
  }

  /**
   * Cache result
   */
  private cacheResult(key: string, result: MetricsResult): void {
    const cacheData = { ...result, cachedAt: Date.now() };
    const dataToCache = JSON.stringify(cacheData);
    const dataSize = dataToCache.length;
    this.cache.set(
      this.cacheNamespace + ':' + key,
      dataToCache,
      dataSize,
      dataSize
    );
  }

  /**
   * Transform to smart output
   */
  private transformOutput(
    result: MetricsResult,
    recommendations: Array<{
      type: 'cpu' | 'memory' | 'disk' | 'general';
      message: string;
      impact: 'high' | 'medium' | 'low';
    }>,
    fromCache = false
  ): SmartSystemMetricsOutput {
    const formatBytes = (bytes: number): string => {
      const gb = bytes / 1024 ** 3;
      return `${gb.toFixed(2)} GB`;
    };

    const getStatus = (percent: number): 'normal' | 'high' | 'critical' => {
      if (percent > 90) return 'critical';
      if (percent > 80) return 'high';
      return 'normal';
    };

    const cpu = {
      usage: Math.round(result.current.cpu.usage * 100) / 100,
      cores: result.current.cpu.cores,
      model: result.current.cpu.model,
      speed: result.current.cpu.speed,
      status: getStatus(result.current.cpu.usage),
    };

    const memory = {
      total: formatBytes(result.current.memory.total),
      used: formatBytes(result.current.memory.used),
      free: formatBytes(result.current.memory.free),
      usagePercent: Math.round(result.current.memory.usagePercent * 100) / 100,
      status: getStatus(result.current.memory.usagePercent),
    };

    const disk = result.current.disk.map((d) => ({
      path: d.path,
      total: formatBytes(d.total),
      used: formatBytes(d.used),
      free: formatBytes(d.free),
      usagePercent: Math.round(d.usagePercent * 100) / 100,
      status: getStatus(d.usagePercent),
    }));

    const uptime = result.current.uptime;
    const hours = Math.floor(uptime / 3600);
    const minutes = Math.floor((uptime % 3600) / 60);
    const uptimeStr = `${hours}h ${minutes}m`;

    const originalSize = this.estimateOriginalOutputSize(result);
    const compactSize = this.estimateCompactSize({ cpu, memory, disk });

    return {
      summary: {
        success: result.success,
        timestamp: new Date(result.timestamp).toISOString(),
        uptime: uptimeStr,
        duration: result.duration,
        fromCache,
      },
      cpu,
      memory,
      disk,
      anomalies: result.anomalies,
      recommendations,
      metrics: {
        originalTokens: Math.ceil(originalSize / 4),
        compactedTokens: Math.ceil(compactSize / 4),
        reductionPercentage: Math.round(
          ((originalSize - compactSize) / originalSize) * 100
        ),
      },
    };
  }

  /**
   * Estimate original output size
   */
  private estimateOriginalOutputSize(result: MetricsResult): number {
    // Verbose system metrics output
    return 2000 + result.current.disk.length * 200;
  }

  /**
   * Estimate compact output size
   */
  private estimateCompactSize(output: {
    cpu: unknown;
    memory: unknown;
    disk: unknown[];
  }): number {
    return JSON.stringify(output).length;
  }

  /**
   * Close cache connection
   */
  close(): void {
    this.cache.close();
  }
}

/**
 * Factory function for dependency injection
 */
export function getSmartSystemMetrics(
  cache: CacheEngine,
  projectRoot?: string
): SmartSystemMetrics {
  return new SmartSystemMetrics(cache, projectRoot);
}

/**
 * CLI-friendly function for running smart system metrics
 */
export async function runSmartSystemMetrics(
  options: SmartSystemMetricsOptions = {}
): Promise<string> {
  const cache = new CacheEngine(
    join(homedir(), '.token-optimizer-cache', 'cache.db')
  );
  const smartMetrics = getSmartSystemMetrics(cache, options.projectRoot);
  try {
    const result = await smartMetrics.run(options);

    let output = `\n📊 Smart System Metrics ${result.summary.fromCache ? '(cached)' : ''}\n`;
    output += `${'='.repeat(50)}\n\n`;

    // Summary
    output += `Summary:\n`;
    output += `  Timestamp: ${new Date(result.summary.timestamp).toLocaleString()}\n`;
    output += `  Uptime: ${result.summary.uptime}\n`;
    output += `  Duration: ${(result.summary.duration / 1000).toFixed(2)}s\n\n`;

    // CPU
    const cpuIcon =
      result.cpu.status === 'critical'
        ? '🔴'
        : result.cpu.status === 'high'
          ? '⚠️'
          : '✓';
    output += `CPU:\n`;
    output += `  ${cpuIcon} Usage: ${result.cpu.usage}%\n`;
    output += `  Cores: ${result.cpu.cores}\n`;
    output += `  Model: ${result.cpu.model}\n`;
    output += `  Speed: ${result.cpu.speed} MHz\n\n`;

    // Memory
    const memIcon =
      result.memory.status === 'critical'
        ? '🔴'
        : result.memory.status === 'high'
          ? '⚠️'
          : '✓';
    output += `Memory:\n`;
    output += `  ${memIcon} Usage: ${result.memory.usagePercent}%\n`;
    output += `  Total: ${result.memory.total}\n`;
    output += `  Used: ${result.memory.used}\n`;
    output += `  Free: ${result.memory.free}\n\n`;

    // Disk
    if (result.disk.length > 0) {
      output += `Disk:\n`;
      for (const disk of result.disk) {
        const diskIcon =
          disk.status === 'critical'
            ? '🔴'
            : disk.status === 'high'
              ? '⚠️'
              : '✓';
        output += `  ${diskIcon} ${disk.path}: ${disk.usagePercent}% used\n`;
        output += `     Total: ${disk.total}, Used: ${disk.used}, Free: ${disk.free}\n`;
      }
      output += '\n';
    }

    // Anomalies
    if (result.anomalies.length > 0) {
      output += `Anomalies Detected:\n`;
      for (const anomaly of result.anomalies) {
        const icon =
          anomaly.severity === 'critical'
            ? '🔴'
            : anomaly.severity === 'warning'
              ? '⚠️'
              : 'ℹ️';
        output += `  ${icon} [${anomaly.type}] ${anomaly.message}\n`;
      }
      output += '\n';
    }

    // Recommendations
    if (result.recommendations.length > 0) {
      output += `Recommendations:\n`;
      for (const rec of result.recommendations) {
        const icon =
          rec.impact === 'high' ? '🔴' : rec.impact === 'medium' ? '🟡' : '🟢';
        output += `  ${icon} [${rec.type}] ${rec.message}\n`;
      }
      output += '\n';
    }

    // Metrics
    output += `Token Reduction:\n`;
    output += `  Original: ${result.metrics.originalTokens} tokens\n`;
    output += `  Compacted: ${result.metrics.compactedTokens} tokens\n`;
    output += `  Reduction: ${result.metrics.reductionPercentage}%\n`;

    return output;
  } finally {
    smartMetrics.close();
  }
}

// MCP Tool definition
export const SMART_SYSTEM_METRICS_TOOL_DEFINITION = {
  name: 'smart_system_metrics',
  description:
    'System resource monitoring with CPU, memory, disk usage tracking, anomaly detection, and performance recommendations',
  inputSchema: {
    type: 'object',
    properties: {
      force: {
        type: 'boolean',
        description: 'Force operation (ignore cache)',
        default: false,
      },
      projectRoot: {
        type: 'string',
        description: 'Project root directory',
      },
      includeDisk: {
        type: 'boolean',
        description: 'Include disk metrics',
        default: true,
      },
      diskPaths: {
        type: 'array',
        items: { type: 'string' },
        description: 'Disk paths to monitor (default: root partition)',
      },
      detectAnomalies: {
        type: 'boolean',
        description: 'Detect anomalies by comparing with previous snapshot',
        default: true,
      },
      maxCacheAge: {
        type: 'number',
        description: 'Maximum cache age in seconds (default: 60)',
        default: 60,
      },
    },
  },
};
