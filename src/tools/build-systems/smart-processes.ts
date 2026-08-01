/**
 * Smart Processes Tool - 60% Token Reduction
 *
 * Monitors running processes with:
 * - Process filtering (hide noise)
 * - Resource usage tracking
 * - Smart aggregation
 * - Anomaly detection
 */

import {
  parseWmicProcessCsv,
  WMIC_PROCESS_COLUMNS,
} from './wmic-process-parser.js';
import { execFileSafe } from '../../utils/safe-exec.js';
import { measured, unmeasured } from '../shared/savings.js';
import { CacheEngine } from '../../core/cache-engine.js';
import { TokenCounter } from '../../core/token-counter.js';
import { MetricsCollector } from '../../core/metrics.js';
import { join } from 'path';
import { homedir, cpus, totalmem } from 'os';

interface ProcessInfo {
  pid: number;
  name: string;
  cpu: number;
  memory: number;
  command: string;
  user: string;
}

interface ProcessSnapshot {
  timestamp: number;
  processes: ProcessInfo[];
  totalCpu: number;
  totalMemory: number;
  systemInfo: {
    platform: string;
    cpuCount: number;
    totalMemoryMB: number;
  };
}

interface SmartProcessesOptions {
  /**
   * Filter processes by name pattern
   */
  filter?: string;

  /**
   * Show only high CPU usage processes (> threshold %)
   */
  cpuThreshold?: number;

  /**
   * Show only high memory usage processes (> threshold MB)
   */
  memoryThreshold?: number;

  /**
   * Include system processes
   */
  includeSystem?: boolean;

  /**
   * Maximum number of processes to show
   */
  limit?: number;

  /**
   * Project root directory
   */
  projectRoot?: string;

  /**
   * Use cached snapshot (for comparison)
   */
  useCache?: boolean;

  /**
   * Maximum cache age in seconds
   */
  maxCacheAge?: number;
}

interface SmartProcessesOutput {
  /**
   * Summary of process state
   */
  summary: {
    totalProcesses: number;
    filteredCount: number;
    highCpuCount: number;
    highMemoryCount: number;
    timestamp: number;
  };

  /**
   * Top processes by resource usage
   */
  topProcesses: {
    byCpu: Array<{
      pid: number;
      name: string;
      cpu: number;
      memory: number;
    }>;
    byMemory: Array<{
      pid: number;
      name: string;
      cpu: number;
      memory: number;
    }>;
  };

  /**
   * Anomalies detected
   */
  anomalies: Array<{
    type: 'cpu_spike' | 'memory_leak' | 'zombie' | 'duplicate';
    severity: 'high' | 'medium' | 'low';
    message: string;
    processes: Array<{
      pid: number;
      name: string;
    }>;
  }>;

  /**
   * Resource usage trends (if cache available)
   */
  trends?: {
    cpuDelta: number;
    memoryDelta: number;
    processCountDelta: number;
  };

  /**
   * Token reduction metrics
   */
  metrics: {
    originalTokens: number;
    compactedTokens: number;
    reductionPercentage: number;
  };
}

export class SmartProcesses {
  private cache: CacheEngine;
  private cacheNamespace = 'smart_processes';
  private platform: NodeJS.Platform;

  constructor(
    cache: CacheEngine,
    _tokenCounter: TokenCounter,
    _metrics: MetricsCollector,
    _projectRoot?: string
  ) {
    this.cache = cache;
    this.platform = process.platform;
  }

  /**
   * Get process information with smart filtering and caching
   */
  async run(
    options: SmartProcessesOptions = {}
  ): Promise<SmartProcessesOutput> {
    const {
      filter,
      // A LISTING TOOL MUST LIST SOMETHING.
      //
      // These defaulted to 10% CPU and 100 MB, so on any machine that is not
      // on fire every process was filtered out and the tool answered with an
      // empty list -- 509 processes counted, none reported. The output is
      // already bounded by `limit` and by the top-10 slices, so the thresholds
      // are not what keeps the response small; they only decided whether there
      // was a response at all. They remain available for callers hunting a
      // runaway process.
      cpuThreshold = 0,
      memoryThreshold = 0,
      includeSystem = false,
      limit = 20,
      useCache = true,
      maxCacheAge = 60,
    } = options;

    // Get current snapshot
    const snapshot = await this.captureSnapshot();

    // Get previous snapshot for comparison (if cache enabled)
    let previousSnapshot: ProcessSnapshot | null = null;
    if (useCache) {
      previousSnapshot = this.getCachedSnapshot(maxCacheAge);
    }

    // Cache current snapshot
    this.cacheSnapshot(snapshot);

    // Filter processes
    const filtered = this.filterProcesses(snapshot.processes, {
      filter,
      cpuThreshold,
      memoryThreshold,
      includeSystem,
    });

    // Analyze and transform
    return this.transformOutput(snapshot, filtered, previousSnapshot, limit);
  }

  /**
   * Capture current process snapshot
   */
  private async captureSnapshot(): Promise<ProcessSnapshot> {
    const processes = await this.getProcessList();

    const totalCpu = processes.reduce((sum, p) => sum + p.cpu, 0);
    const totalMemory = processes.reduce((sum, p) => sum + p.memory, 0);

    return {
      timestamp: Date.now(),
      processes,
      totalCpu,
      totalMemory,
      systemInfo: {
        platform: this.platform,
        cpuCount: cpus().length,
        totalMemoryMB: Math.round(totalmem() / 1024 / 1024),
      },
    };
  }

  /**
   * Get list of running processes
   */
  private async getProcessList(): Promise<ProcessInfo[]> {
    if (this.platform === 'win32') {
      return this.getWindowsProcesses();
    } else {
      return this.getUnixProcesses();
    }
  }

  /**
   * Get processes on Windows.
   *
   * WMIC RETURNS COLUMNS ALPHABETICALLY, not in the order they were requested,
   * and the previous mapping assumed request order. Measured against a real
   * table on this machine, four of five fields were reading the wrong column:
   *
   *   header:  Node,CommandLine,CreationDate,KernelModeTime,Name,ProcessId,...
   *   name    <- CommandLine        ("C:\WINDOWS\Explorer.EXE", not explorer.exe)
   *   cpu     <- parseInt(Name)     always NaN -> 0, for every process
   *   memory  <- UserModeTime       explorer.exe reported as 414,398 MB
   *   command <- Node               the HOSTNAME, identical for every row
   *
   * `cpu` being pinned at 0 is why a default cpuThreshold filtered the entire
   * table away -- the thresholds were lowered to compensate, which treated the
   * symptom. Only `pid` was right.
   */
  private async getWindowsProcesses(): Promise<ProcessInfo[]> {
    let firstError: unknown;
    try {
      return this.parseWmicCsv(
        (
          await execFileSafe(
            'wmic',
            [
              'process',
              'get',
              // Requested order is irrelevant -- the parser anchors to the END
              // of each row rather than trusting any column index.
              WMIC_PROCESS_COLUMNS,
              '/format:csv',
            ],
            { maxBuffer: 32 * 1024 * 1024 }
          )
        ).stdout
      );
    } catch (err) {
      firstError = err;
    }

    // wmic is deprecated and absent from recent Windows builds, where it is
    // simply "not recognised". Falling through to CIM keeps the tool working
    // there; JSON also sidesteps CSV quoting entirely.
    try {
      return await this.getWindowsProcessesViaCim();
    } catch (cimError) {
      // NEVER return [] HERE. An empty list is indistinguishable from "this
      // machine has no processes", and downstream that became a report of 100%
      // tokens saved for an answer that contained nothing. A collection failure
      // has to surface as a failure.
      throw new Error(
        `Could not read the process table. wmic failed (${String(firstError)}) ` +
          `and the Get-CimInstance fallback failed (${String(cimError)}).`
      );
    }
  }

  /** @see parseWmicProcessCsv -- the parsing rules and why they are what they are. */
  private parseWmicCsv(stdout: string): ProcessInfo[] {
    return parseWmicProcessCsv(stdout);
  }

  /**
   * Supported replacement for wmic. Emits JSON, so no CSV parsing is involved.
   */
  private async getWindowsProcessesViaCim(): Promise<ProcessInfo[]> {
    const script =
      'Get-CimInstance Win32_Process | ForEach-Object { [pscustomobject]@{' +
      'pid=$_.ProcessId; name=$_.Name; cmd=$_.CommandLine; ' +
      'cpu100ns=([double]$_.KernelModeTime + [double]$_.UserModeTime); ' +
      'startMs=$(if ($_.CreationDate) { [long]([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() } else { 0 }); ' +
      'ws=$_.WorkingSetSize } } | ConvertTo-Json -Compress -Depth 2';

    const { stdout } = await execFileSafe(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { maxBuffer: 32 * 1024 * 1024 }
    );

    const parsed: unknown = JSON.parse(stdout);
    // A single process serialises as an object rather than an array.
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    const now = Date.now();

    const processes: ProcessInfo[] = [];
    for (const row of rows as Array<Record<string, unknown>>) {
      const pid = Number(row?.pid);
      const bytes = Number(row?.ws);
      if (!Number.isFinite(pid) || !Number.isFinite(bytes)) continue;

      const startMs = Number(row?.startMs);
      const lifetimeMs =
        Number.isFinite(startMs) && startMs > 0 ? now - startMs : 0;
      const cpuSeconds = Number(row?.cpu100ns) / 1e7;

      processes.push({
        pid,
        name: String(row?.name ?? 'Unknown'),
        cpu: lifetimeMs > 0 ? (cpuSeconds / (lifetimeMs / 1000)) * 100 : 0,
        memory: bytes / 1024 / 1024,
        command: String(row?.cmd ?? row?.name ?? ''),
        user: 'current',
      });
    }

    return processes;
  }

  // lifetimeCpuPercent / parseWmiDate now live in wmic-process-parser.ts, so
  // they can be tested on a Linux CI runner that has no wmic to call.

  /**
   * Get processes on Unix/Linux/macOS
   */
  private async getUnixProcesses(): Promise<ProcessInfo[]> {
    try {
      // `--no-headers` is GNU-only (unsupported on macOS/BSD ps), so request
      // the default output and drop the header row in code instead.
      const { stdout } = await execFileSafe('ps', ['aux'], {
        maxBuffer: 10 * 1024 * 1024,
      });

      const processes: ProcessInfo[] = [];
      const lines = stdout.split('\n').slice(1);

      for (const line of lines) {
        if (!line.trim()) continue;

        const parts = line.trim().split(/\s+/);
        if (parts.length < 11) continue;

        const user = parts[0];
        const pid = parseInt(parts[1], 10);
        const cpu = parseFloat(parts[2]);
        const memory = parseFloat(parts[3]);
        const command = parts.slice(10).join(' ');
        const name = parts[10].split('/').pop() || 'Unknown';

        if (isNaN(pid) || isNaN(cpu) || isNaN(memory)) continue;

        // Convert memory % to MB
        const totalMemoryMB = totalmem() / 1024 / 1024;
        const memoryMB = (memory / 100) * totalMemoryMB;

        processes.push({
          pid,
          name,
          cpu,
          memory: memoryMB,
          command,
          user,
        });
      }

      return processes;
    } catch (err) {
      console.error('Error getting Unix processes:', err);
      return [];
    }
  }

  /**
   * Filter processes based on criteria
   */
  private filterProcesses(
    processes: ProcessInfo[],
    options: {
      filter?: string;
      cpuThreshold: number;
      memoryThreshold: number;
      includeSystem: boolean;
    }
  ): ProcessInfo[] {
    let filtered = processes;

    // Filter by name pattern
    if (options.filter) {
      const pattern = new RegExp(options.filter, 'i');
      filtered = filtered.filter(
        (p) => pattern.test(p.name) || pattern.test(p.command)
      );
    }

    // Filter by CPU threshold
    filtered = filtered.filter((p) => p.cpu >= options.cpuThreshold);

    // Filter by memory threshold
    filtered = filtered.filter((p) => p.memory >= options.memoryThreshold);

    // Filter out system processes (if not included)
    if (!options.includeSystem) {
      filtered = filtered.filter(
        (p) =>
          !p.name.startsWith('System') &&
          !p.name.startsWith('kernel') &&
          p.user !== 'root' &&
          p.user !== 'SYSTEM'
      );
    }

    return filtered;
  }

  /**
   * Get cached snapshot
   */
  private getCachedSnapshot(maxAge: number): ProcessSnapshot | null {
    const key = `${this.cacheNamespace}:snapshot`;
    const cached = this.cache.get(key);

    if (!cached) {
      return null;
    }

    try {
      const snapshot = JSON.parse(cached) as ProcessSnapshot;
      const age = (Date.now() - snapshot.timestamp) / 1000;

      if (age <= maxAge) {
        return snapshot;
      }
    } catch (err) {
      return null;
    }

    return null;
  }

  /**
   * Cache snapshot
   */
  private cacheSnapshot(snapshot: ProcessSnapshot): void {
    const key = `${this.cacheNamespace}:snapshot`;
    const dataToCache = JSON.stringify(snapshot);
    const originalSize = this.measureOriginalOutputSize(snapshot);
    const compactSize = dataToCache.length;

    this.cache.set(key, dataToCache, originalSize, compactSize);
  }

  /**
   * Detect anomalies in process list
   */
  private detectAnomalies(
    processes: ProcessInfo[],
    previous: ProcessInfo[] | null
  ): Array<{
    type: 'cpu_spike' | 'memory_leak' | 'zombie' | 'duplicate';
    severity: 'high' | 'medium' | 'low';
    message: string;
    processes: Array<{ pid: number; name: string }>;
  }> {
    const anomalies: Array<{
      type: 'cpu_spike' | 'memory_leak' | 'zombie' | 'duplicate';
      severity: 'high' | 'medium' | 'low';
      message: string;
      processes: Array<{ pid: number; name: string }>;
    }> = [];

    // Detect CPU spikes (> 80%)
    const highCpuProcesses = processes.filter((p) => p.cpu > 80);
    if (highCpuProcesses.length > 0) {
      anomalies.push({
        type: 'cpu_spike',
        severity: 'high',
        message: `${highCpuProcesses.length} process(es) consuming >80% CPU`,
        processes: highCpuProcesses.map((p) => ({ pid: p.pid, name: p.name })),
      });
    }

    // Detect memory leaks (compare with previous if available)
    if (previous) {
      for (const current of processes) {
        const prev = previous.find((p) => p.pid === current.pid);
        if (prev && current.memory > prev.memory * 2) {
          anomalies.push({
            type: 'memory_leak',
            severity: 'medium',
            message: `Memory usage doubled for ${current.name}`,
            processes: [{ pid: current.pid, name: current.name }],
          });
        }
      }
    }

    // Detect duplicate processes
    const nameCounts = new Map<string, number>();
    for (const p of processes) {
      nameCounts.set(p.name, (nameCounts.get(p.name) || 0) + 1);
    }

    for (const [name, count] of nameCounts.entries()) {
      if (count > 5) {
        const duplicates = processes.filter((p) => p.name === name);
        anomalies.push({
          type: 'duplicate',
          severity: 'low',
          message: `${count} instances of ${name} running`,
          processes: duplicates.map((p) => ({ pid: p.pid, name: p.name })),
        });
      }
    }

    return anomalies;
  }

  /**
   * Calculate resource usage trends
   */
  private calculateTrends(
    current: ProcessSnapshot,
    previous: ProcessSnapshot | null
  ):
    | {
        cpuDelta: number;
        memoryDelta: number;
        processCountDelta: number;
      }
    | undefined {
    if (!previous) {
      return undefined;
    }

    return {
      cpuDelta: current.totalCpu - previous.totalCpu,
      memoryDelta: current.totalMemory - previous.totalMemory,
      processCountDelta: current.processes.length - previous.processes.length,
    };
  }

  /**
   * Transform process data to smart output
   */
  private transformOutput(
    snapshot: ProcessSnapshot,
    filtered: ProcessInfo[],
    previous: ProcessSnapshot | null,
    limit: number
  ): SmartProcessesOutput {
    // Sort by CPU and memory
    const byCpu = [...filtered].sort((a, b) => b.cpu - a.cpu).slice(0, limit);
    const byMemory = [...filtered]
      .sort((a, b) => b.memory - a.memory)
      .slice(0, limit);

    // Detect anomalies
    const anomalies = this.detectAnomalies(
      filtered,
      previous ? previous.processes : null
    );

    // Calculate trends
    const trends = this.calculateTrends(snapshot, previous);

    // Count high resource processes
    const highCpuCount = filtered.filter((p) => p.cpu > 50).length;
    const highMemoryCount = filtered.filter((p) => p.memory > 500).length;

    const originalSize = this.measureOriginalOutputSize(snapshot);
    const compactSize = this.estimateCompactSize(filtered, anomalies);

    return {
      summary: {
        totalProcesses: snapshot.processes.length,
        filteredCount: filtered.length,
        highCpuCount,
        highMemoryCount,
        timestamp: snapshot.timestamp,
      },
      topProcesses: {
        byCpu: byCpu.map((p) => ({
          pid: p.pid,
          name: p.name,
          cpu: p.cpu,
          memory: p.memory,
        })),
        byMemory: byMemory.map((p) => ({
          pid: p.pid,
          name: p.name,
          cpu: p.cpu,
          memory: p.memory,
        })),
      },
      anomalies,
      trends,
      // Both sides measured, and the percentage derived from them rather than
      // computed alongside them -- so the three numbers can never disagree.
      metrics: (() => {
        // A saving requires that the answer is still THERE. When the filters
        // remove every process, nothing was compressed -- it was omitted -- and
        // the old code reported that as a 100% reduction. `unmeasured()` claims
        // nothing, which is what an empty answer has earned.
        const s =
          filtered.length === 0 && snapshot.processes.length > 0
            ? unmeasured(Math.ceil(compactSize / 4))
            : measured(Math.ceil(originalSize / 4), Math.ceil(compactSize / 4));
        return {
          originalTokens: s.originalTokenCount,
          compactedTokens: s.tokenCount,
          reductionPercentage: Math.round((1 - s.compressionRatio) * 100),
        };
      })(),
    };
  }

  /**
   * What the full process listing actually costs.
   *
   * THE BASELINE WAS INVENTED. This returned
   * `snapshot.processes.length * 200 + 500` -- an assumed 200 characters per
   * process, measured from nothing. Paired with the default `cpuThreshold` of
   * 10, which filters out everything on a machine that is not on fire, the
   * tool reported a 100% reduction for returning an EMPTY list: 25,825 tokens
   * "saved" by omitting the answer.
   *
   * The snapshot is right here, so it is measured.
   */
  private measureOriginalOutputSize(snapshot: ProcessSnapshot): number {
    return JSON.stringify(snapshot.processes).length;
  }

  /**
   * Estimate compact output size
   */
  private estimateCompactSize(
    filtered: ProcessInfo[],
    anomalies: Array<{
      type: string;
      message: string;
      processes: Array<{ pid: number; name: string }>;
    }>
  ): number {
    const summary = {
      totalProcesses: filtered.length,
      highCpu: filtered.filter((p) => p.cpu > 50).length,
      highMemory: filtered.filter((p) => p.memory > 500).length,
    };

    // Only top 10 processes + anomalies
    const topProcesses = filtered.slice(0, 10).map((p) => ({
      name: p.name,
      cpu: p.cpu,
      memory: p.memory,
    }));

    return JSON.stringify({ summary, topProcesses, anomalies }).length;
  }

  /**
   * Close cache connection
   */
  close(): void {
    this.cache.close();
  }
}

/**
 * Factory function for creating SmartProcesses with shared resources (for benchmarks)
 */
export function getSmartProcessesTool(
  cache: CacheEngine,
  tokenCounter: TokenCounter,
  metrics: MetricsCollector,
  projectRoot?: string
): SmartProcesses {
  return new SmartProcesses(cache, tokenCounter, metrics, projectRoot);
}

/**
 * CLI-friendly function for running smart processes
 */
export async function runSmartProcesses(
  options: SmartProcessesOptions = {}
): Promise<string> {
  const cache = new CacheEngine(
    join(homedir(), '.token-optimizer-cache', 'cache.db')
  );
  const tokenCounter = new TokenCounter();
  const metrics = new MetricsCollector();
  const smartProcesses = new SmartProcesses(
    cache,
    tokenCounter,
    metrics,
    options.projectRoot
  );
  try {
    const result = await smartProcesses.run(options);

    let output = `\n⚙️  Smart Process Monitor\n`;
    output += `${'='.repeat(50)}\n\n`;

    // Summary
    output += `Summary:\n`;
    output += `  Total Processes: ${result.summary.totalProcesses}\n`;
    output += `  Filtered: ${result.summary.filteredCount}\n`;
    output += `  High CPU (>50%): ${result.summary.highCpuCount}\n`;
    output += `  High Memory (>500MB): ${result.summary.highMemoryCount}\n`;
    output += `  Timestamp: ${new Date(result.summary.timestamp).toLocaleTimeString()}\n\n`;

    // Anomalies
    if (result.anomalies.length > 0) {
      output += `🚨 Anomalies Detected:\n`;
      for (const anomaly of result.anomalies) {
        const severityIcon =
          anomaly.severity === 'high'
            ? '🔴'
            : anomaly.severity === 'medium'
              ? '🟡'
              : '🟢';

        output += `  ${severityIcon} [${anomaly.type}] ${anomaly.message}\n`;
        for (const proc of anomaly.processes.slice(0, 3)) {
          output += `    - PID ${proc.pid}: ${proc.name}\n`;
        }
        if (anomaly.processes.length > 3) {
          output += `    ... and ${anomaly.processes.length - 3} more\n`;
        }
      }
      output += '\n';
    }

    // Top processes by CPU
    if (result.topProcesses.byCpu.length > 0) {
      output += `Top CPU Usage:\n`;
      for (const proc of result.topProcesses.byCpu.slice(0, 5)) {
        output += `  ${proc.cpu.toFixed(1)}% | ${proc.memory.toFixed(0)}MB | ${proc.name} (PID ${proc.pid})\n`;
      }
      output += '\n';
    }

    // Top processes by memory
    if (result.topProcesses.byMemory.length > 0) {
      output += `Top Memory Usage:\n`;
      for (const proc of result.topProcesses.byMemory.slice(0, 5)) {
        output += `  ${proc.memory.toFixed(0)}MB | ${proc.cpu.toFixed(1)}% | ${proc.name} (PID ${proc.pid})\n`;
      }
      output += '\n';
    }

    // Trends
    if (result.trends) {
      output += `Resource Trends:\n`;
      output += `  CPU: ${result.trends.cpuDelta > 0 ? '+' : ''}${result.trends.cpuDelta.toFixed(1)}%\n`;
      output += `  Memory: ${result.trends.memoryDelta > 0 ? '+' : ''}${result.trends.memoryDelta.toFixed(0)}MB\n`;
      output += `  Process Count: ${result.trends.processCountDelta > 0 ? '+' : ''}${result.trends.processCountDelta}\n\n`;
    }

    // Metrics
    output += `Token Reduction:\n`;
    output += `  Original: ${result.metrics.originalTokens} tokens\n`;
    output += `  Compacted: ${result.metrics.compactedTokens} tokens\n`;
    output += `  Reduction: ${result.metrics.reductionPercentage}%\n`;

    return output;
  } finally {
    smartProcesses.close();
  }
}

// MCP Tool definition
export const SMART_PROCESSES_TOOL_DEFINITION = {
  name: 'smart_processes',
  description:
    'Monitor and analyze system processes with anomaly detection and resource tracking',
  inputSchema: {
    type: 'object',
    properties: {
      filter: {
        type: 'string',
        description: 'Filter processes by name pattern',
      },
      cpuThreshold: {
        type: 'number',
        description: 'Show only high CPU usage processes (> threshold %)',
      },
      memoryThreshold: {
        type: 'number',
        description: 'Show only high memory usage processes (> threshold MB)',
      },
      includeSystem: {
        type: 'boolean',
        description: 'Include system processes',
        default: false,
      },
      limit: {
        type: 'number',
        description: 'Maximum number of processes to show',
        default: 20,
      },
      projectRoot: {
        type: 'string',
        description: 'Project root directory',
      },
      compareWithPrevious: {
        type: 'boolean',
        description: 'Compare with previous snapshot',
        default: true,
      },
    },
  },
};
