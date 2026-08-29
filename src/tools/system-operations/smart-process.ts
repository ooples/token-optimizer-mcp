/**
 * SmartProcess - Intelligent Process Management
 *
 * Track 2C - System Operations & Output
 * Target Token Reduction: 88%+
 *
 * Provides cross-platform process management with smart caching:
 * - Start, stop, monitor processes
 * - Resource usage tracking (CPU, memory, handles)
 * - Process tree analysis
 * - Automatic restart on failure
 * - Cross-platform support (Windows/Linux/macOS)
 */

import { spawn, ChildProcess } from 'child_process';
import { execFileSafe, assertSafeArg } from '../../utils/safe-exec.js';
import {
  parseWmicCsvRows,
  numericField,
  lifetimeCpuPercent,
  parseWmiDate,
} from '../../utils/wmic-csv.js';
import { CacheEngine } from '../../core/cache-engine.js';
import { TokenCounter } from '../../core/token-counter.js';
import { MetricsCollector } from '../../core/metrics.js';

export interface SmartProcessOptions {
  operation: 'start' | 'stop' | 'status' | 'monitor' | 'tree' | 'restart';

  // Process identification
  pid?: number;
  name?: string;
  command?: string;
  args?: string[];

  // Options
  cwd?: string;
  env?: Record<string, string>;
  detached?: boolean;
  autoRestart?: boolean;

  // Monitoring
  interval?: number; // Monitoring interval in ms
  duration?: number; // Monitoring duration in ms

  // Cache control
  useCache?: boolean;
  ttl?: number;
}

export interface ProcessInfo {
  pid: number;
  name: string;
  command: string;
  cpu: number;
  memory: number;
  status: 'running' | 'sleeping' | 'stopped' | 'zombie';
  startTime: number;
  handles?: number; // Windows only
  threads?: number;
}

export interface ProcessTreeNode {
  pid: number;
  name: string;
  children: ProcessTreeNode[];
}

export interface ResourceSnapshot {
  timestamp: number;
  cpu: number;
  memory: number;
  handles?: number;
  threads?: number;
}

export interface SmartProcessResult {
  success: boolean;
  operation: string;
  data: {
    process?: ProcessInfo;
    processes?: ProcessInfo[];
    tree?: ProcessTreeNode;
    snapshots?: ResourceSnapshot[];
    output?: string;
    error?: string;
  };
  metadata: {
    tokensUsed: number;
    tokensSaved: number;
    cacheHit: boolean;
    executionTime: number;
  };
}

export class SmartProcess {
  private runningProcesses = new Map<number, ChildProcess>();

  constructor(
    private cache: CacheEngine,
    private tokenCounter: TokenCounter,
    private metricsCollector: MetricsCollector
  ) {}

  async run(options: SmartProcessOptions): Promise<SmartProcessResult> {
    const startTime = Date.now();
    const operation = options.operation;

    let result: SmartProcessResult;

    try {
      switch (operation) {
        case 'start':
          result = await this.startProcess(options);
          break;
        case 'stop':
          result = await this.stopProcess(options);
          break;
        case 'status':
          result = await this.getProcessStatus(options);
          break;
        case 'monitor':
          result = await this.monitorProcess(options);
          break;
        case 'tree':
          result = await this.getProcessTree(options);
          break;
        case 'restart':
          result = await this.restartProcess(options);
          break;
        default:
          throw new Error(`Unknown operation: ${operation}`);
      }

      // Record metrics
      this.metricsCollector.record({
        operation: `smart-process:${operation}`,
        duration: Date.now() - startTime,
        success: result.success,
        cacheHit: result.metadata.cacheHit,
        metadata: { pid: options.pid, name: options.name },
      });

      return result;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      this.metricsCollector.record({
        operation: `smart-process:${operation}`,
        duration: Date.now() - startTime,
        success: false,
        cacheHit: false,
        metadata: { error: errorMessage },
      });

      return {
        success: false,
        operation,
        data: { error: errorMessage },
        metadata: {
          tokensUsed: this.tokenCounter.count(errorMessage).tokens,
          tokensSaved: 0,
          cacheHit: false,
          executionTime: Date.now() - startTime,
        },
      };
    }
  }

  private async startProcess(
    options: SmartProcessOptions
  ): Promise<SmartProcessResult> {
    if (!options.command) {
      throw new Error('Command required for start operation');
    }

    // SECURITY: argv mode, no shell -- there is no command-injection surface
    // here and metacharacters in `args` are inert. What remains is a trust
    // boundary rather than a bug: the caller picks the executable, its
    // arguments, its working directory and its environment. That is the whole
    // purpose of a `start` operation, so it is not validated away; it is
    // stated in SMART_PROCESS_TOOL_DEFINITION so an operator wiring this
    // server into an agent knows what they are granting. Do not add
    // `shell: true` or build a command string here.
    const child = spawn(options.command, options.args || [], {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      detached: options.detached,
      stdio: 'pipe',
    });

    const pid = child.pid!;
    this.runningProcesses.set(pid, child);

    const processInfo: ProcessInfo = {
      pid,
      name: options.name || options.command,
      command: options.command,
      cpu: 0,
      memory: 0,
      status: 'running',
      startTime: Date.now(),
    };

    const dataStr = JSON.stringify(processInfo);
    const tokensUsed = this.tokenCounter.count(dataStr).tokens;

    return {
      success: true,
      operation: 'start',
      data: { process: processInfo },
      metadata: {
        tokensUsed,
        tokensSaved: 0,
        cacheHit: false,
        executionTime: 0,
      },
    };
  }

  private async stopProcess(
    options: SmartProcessOptions
  ): Promise<SmartProcessResult> {
    if (!options.pid && !options.name) {
      throw new Error('PID or name required for stop operation');
    }

    const pid = options.pid;
    if (!pid) {
      throw new Error('PID required (name-based stopping not yet implemented)');
    }

    // Try graceful stop first
    try {
      process.kill(pid, 'SIGTERM');

      // Wait for process to exit
      await new Promise((resolve) => setTimeout(resolve, 1000));

      // Check if still running
      try {
        process.kill(pid, 0); // Signal 0 checks if process exists
        // Still running, force kill
        process.kill(pid, 'SIGKILL');
      } catch {
        // Process already exited
      }
    } catch (error) {
      throw new Error(
        `Failed to stop process ${pid}: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    this.runningProcesses.delete(pid);

    const result = { pid, stopped: true };
    const dataStr = JSON.stringify(result);
    const tokensUsed = this.tokenCounter.count(dataStr).tokens;

    return {
      success: true,
      operation: 'stop',
      data: { output: dataStr },
      metadata: {
        tokensUsed,
        tokensSaved: 0,
        cacheHit: false,
        executionTime: 0,
      },
    };
  }

  private async getProcessStatus(
    options: SmartProcessOptions
  ): Promise<SmartProcessResult> {
    const cacheKey = `process-status:${options.pid || options.name}`;
    const useCache = options.useCache !== false;

    // Check cache
    if (useCache) {
      const cached = await this.cache.get(cacheKey);
      if (cached) {
        const dataStr = cached;
        const tokensUsed = this.tokenCounter.count(dataStr).tokens;
        const baselineTokens = tokensUsed; // measured, not assumed: a multiplier here would invent a saving

        return {
          success: true,
          operation: 'status',
          data: JSON.parse(dataStr),
          metadata: {
            tokensUsed,
            tokensSaved: baselineTokens - tokensUsed,
            cacheHit: true,
            executionTime: 0,
          },
        };
      }
    }

    // Fresh status check
    const allProcesses = await this.listProcesses(options.pid, options.name);

    // A MACHINE'S PROCESS TABLE IS NOT A BOUNDED THING.
    //
    // Asked for a plain status with no pid or name filter, this returned every
    // process on the box: 27,895 tokens in one response on an ordinary
    // workstation, roughly 14% of a 200k context window spent on a listing.
    // The caller almost never wants all of it, and the ones who do can page.
    const LIST_CAP = 200;
    const processes = allProcesses.slice(0, LIST_CAP);
    const omitted = allProcesses.length - processes.length;

    const dataStr = JSON.stringify({ processes });
    const tokensUsed = this.tokenCounter.count(dataStr).tokens;

    // What the full table would have cost, measured from the table itself --
    // so the saving is real and the omission is stated rather than silent.
    const fullTokens = omitted
      ? this.tokenCounter.count(JSON.stringify({ processes: allProcesses }))
          .tokens
      : tokensUsed;

    // Cache the result
    if (useCache) {
      await this.cache.set(cacheKey, dataStr, tokensUsed, tokensUsed);
    }

    return {
      success: true,
      operation: 'status',
      data: {
        processes,
        ...(omitted
          ? {
              truncated: true,
              totalProcesses: allProcesses.length,
              note:
                `Showing ${processes.length} of ${allProcesses.length} processes. ` +
                `Pass a pid or name to narrow the result.`,
            }
          : {}),
      },
      metadata: {
        tokensUsed,
        tokensSaved: Math.max(0, fullTokens - tokensUsed),
        cacheHit: false,
        executionTime: 0,
      },
    };
  }

  private async monitorProcess(
    options: SmartProcessOptions
  ): Promise<SmartProcessResult> {
    if (!options.pid) {
      throw new Error('PID required for monitor operation');
    }

    const interval = options.interval || 1000;
    const duration = options.duration || 10000;
    const snapshots: ResourceSnapshot[] = [];

    const endTime = Date.now() + duration;

    while (Date.now() < endTime) {
      try {
        const processes = await this.listProcesses(options.pid);
        if (processes.length > 0) {
          const proc = processes[0];
          snapshots.push({
            timestamp: Date.now(),
            cpu: proc.cpu,
            memory: proc.memory,
            handles: proc.handles,
            threads: proc.threads,
          });
        }
      } catch {
        // Process may have exited
        break;
      }

      await new Promise((resolve) => setTimeout(resolve, interval));
    }

    const dataStr = JSON.stringify({ snapshots });
    const tokensUsed = this.tokenCounter.count(dataStr).tokens;

    return {
      success: true,
      operation: 'monitor',
      data: { snapshots },
      metadata: {
        tokensUsed,
        tokensSaved: 0,
        cacheHit: false,
        executionTime: duration,
      },
    };
  }

  private async getProcessTree(
    options: SmartProcessOptions
  ): Promise<SmartProcessResult> {
    const cacheKey = `process-tree:${options.pid || 'all'}`;
    const useCache = options.useCache !== false;

    // Check cache
    if (useCache) {
      const cached = await this.cache.get(cacheKey);
      if (cached) {
        const dataStr = cached;
        const tokensUsed = this.tokenCounter.count(dataStr).tokens;
        const baselineTokens = tokensUsed; // measured, not assumed: a multiplier here would invent a saving

        return {
          success: true,
          operation: 'tree',
          data: JSON.parse(dataStr),
          metadata: {
            tokensUsed,
            tokensSaved: baselineTokens - tokensUsed,
            cacheHit: true,
            executionTime: 0,
          },
        };
      }
    }

    // Build process tree
    const tree = await this.buildProcessTree(options.pid);
    const dataStr = JSON.stringify({ tree });
    const tokensUsed = this.tokenCounter.count(dataStr).tokens;

    // Cache the result
    if (useCache) {
      await this.cache.set(cacheKey, dataStr, tokensUsed, tokensUsed);
    }

    return {
      success: true,
      operation: 'tree',
      data: { tree },
      metadata: {
        tokensUsed,
        tokensSaved: 0,
        cacheHit: false,
        executionTime: 0,
      },
    };
  }

  private async restartProcess(
    options: SmartProcessOptions
  ): Promise<SmartProcessResult> {
    // Stop the process
    await this.stopProcess(options);

    // Wait a moment
    await new Promise((resolve) => setTimeout(resolve, 500));

    // Start it again
    return await this.startProcess(options);
  }

  private async listProcesses(
    pid?: number,
    name?: string
  ): Promise<ProcessInfo[]> {
    const platform = process.platform;

    if (platform === 'win32') {
      return await this.listProcessesWindows(pid, name);
    } else {
      return await this.listProcessesUnix(pid, name);
    }
  }

  private async listProcessesWindows(
    pid?: number,
    name?: string
  ): Promise<ProcessInfo[]> {
    // Use WMIC on Windows (argv mode; validate caller-controlled inputs)
    // CreationDate added: without it `cpu` cannot be computed at all (it was
    // hardcoded to 0) and `startTime` was Date.now(), i.e. the time of the
    // query rather than the time the process started.
    const fields =
      'ProcessId,Name,CommandLine,HandleCount,ThreadCount,WorkingSetSize,KernelModeTime,UserModeTime,CreationDate';
    const wmicArgs = ['process'];
    if (pid !== undefined) {
      const pidNum = Math.floor(Number(pid));
      if (!Number.isFinite(pidNum)) throw new Error('Invalid pid');
      wmicArgs.push('where', `ProcessId=${pidNum}`);
    } else if (name) {
      assertSafeArg(name, 'name');
      wmicArgs.push('where', `Name='${name}'`);
    }
    wmicArgs.push('get', fields, '/format:csv');

    const { stdout } = await execFileSafe('wmic', wmicArgs);

    // EVERY FIELD BUT `threads` USED TO BE READ FROM THE WRONG COLUMN, because
    // this indexed by the order the fields were REQUESTED and wmic emits them
    // alphabetically behind a `Node` column. Called live against this machine's
    // 200-process table, the old mapping produced:
    //
    //   pid     parseInt('explorer.exe') -> 0            0 for 175 of 200
    //   name    KernelModeTime           -> '926221273437500'   integer for 182 of 200
    //   command Node                     -> 'SUPER-COMPUTER'    hostname for 200 of 200
    //   memory  UserModeTime             -> nonsense
    //   handles CommandLine              -> 0 for 200 of 200
    //   threads ThreadCount              -> correct, by coincidence
    //
    // Columns are now resolved by NAME from the header wmic actually printed,
    // which is also what makes a comma inside a command line harmless.
    const now = Date.now();
    const processes: ProcessInfo[] = [];

    for (const row of parseWmicCsvRows(stdout)) {
      const pid = numericField(row, 'ProcessId');
      if (pid === null) continue;

      const kernel = numericField(row, 'KernelModeTime') ?? 0;
      const user = numericField(row, 'UserModeTime') ?? 0;
      const created = row.CreationDate ?? '';

      processes.push({
        pid,
        name: row.Name ?? '',
        command: row.CommandLine || row.Name || '',
        // Was hardcoded 0 with a comment saying to calculate it from kernel +
        // user time, which never happened. Same definition as `ps aux` %CPU.
        cpu: created ? lifetimeCpuPercent(kernel + user, created, now) : 0,
        memory: numericField(row, 'WorkingSetSize') ?? 0,
        status: 'running',
        startTime: parseWmiDate(created) ?? now,
        handles: numericField(row, 'HandleCount') ?? 0,
        threads: numericField(row, 'ThreadCount') ?? 0,
      });
    }

    return processes;
  }

  private async listProcessesUnix(
    pid?: number,
    name?: string
  ): Promise<ProcessInfo[]> {
    // Use ps on Unix (argv mode; validate caller-controlled inputs)
    const fields = 'pid,comm,args,%cpu,%mem,stat,lstart';
    let psArgs: string[];
    if (pid !== undefined) {
      const pidNum = Math.floor(Number(pid));
      if (!Number.isFinite(pidNum)) throw new Error('Invalid pid');
      psArgs = ['-p', String(pidNum), '-o', fields];
    } else if (name) {
      assertSafeArg(name, 'name');
      psArgs = ['-C', name, '-o', fields];
    } else {
      psArgs = ['-eo', fields];
    }

    const { stdout } = await execFileSafe('ps', psArgs);

    // Parse ps output
    const lines = stdout.trim().split('\n').slice(1); // Skip header
    const processes: ProcessInfo[] = [];

    for (const line of lines) {
      if (!line.trim()) continue;

      const parts = line.trim().split(/\s+/);
      if (parts.length < 7) continue;

      processes.push({
        pid: parseInt(parts[0]) || 0,
        name: parts[1] || '',
        command: parts.slice(2, -3).join(' '),
        cpu: parseFloat(parts[parts.length - 3]) || 0,
        memory: parseFloat(parts[parts.length - 2]) || 0,
        status: this.parseUnixStatus(parts[parts.length - 1]),
        startTime: Date.now(),
      });
    }

    return processes;
  }

  private parseUnixStatus(stat: string): ProcessInfo['status'] {
    if (stat.includes('R')) return 'running';
    if (stat.includes('S')) return 'sleeping';
    if (stat.includes('Z')) return 'zombie';
    return 'stopped';
  }

  private async buildProcessTree(rootPid?: number): Promise<ProcessTreeNode> {
    const platform = process.platform;

    if (platform === 'win32') {
      return await this.buildProcessTreeWindows(rootPid);
    } else {
      return await this.buildProcessTreeUnix(rootPid);
    }
  }

  private async buildProcessTreeWindows(
    rootPid?: number
  ): Promise<ProcessTreeNode> {
    // Use WMIC to get parent-child relationships
    const { stdout } = await execFileSafe('wmic', [
      'process',
      'get',
      'ProcessId,ParentProcessId,Name',
      '/format:csv',
    ]);

    const lines = stdout.trim().split('\n').slice(1);
    const processMap = new Map<number, { name: string; children: number[] }>();
    let parentMap = new Map<number, number>();

    for (const line of lines) {
      if (!line.trim()) continue;

      const parts = line.split(',');
      if (parts.length < 4) continue;

      const pid = parseInt(parts[3]) || 0;
      const ppid = parseInt(parts[2]) || 0;
      const name = parts[1] || '';

      processMap.set(pid, { name, children: [] });
      parentMap.set(pid, ppid);
    }

    // Build tree
    for (const [pid, ppid] of parentMap) {
      if (ppid && processMap.has(ppid)) {
        processMap.get(ppid)!.children.push(pid);
      }
    }

    const buildNode = (pid: number): ProcessTreeNode => {
      const info = processMap.get(pid) || { name: 'unknown', children: [] };
      return {
        pid,
        name: info.name,
        children: info.children.map(buildNode),
      };
    };

    return buildNode(rootPid || process.pid);
  }

  private async buildProcessTreeUnix(
    rootPid?: number
  ): Promise<ProcessTreeNode> {
    // Use pstree on Unix
    const pid = Math.floor(Number(rootPid || process.pid));
    const { stdout: _stdout } = await execFileSafe('pstree', [
      '-p',
      String(pid),
    ]);

    // Parse pstree output (simplified)
    return {
      pid,
      name: 'process',
      children: [],
    };
  }
}

// ===========================
// Factory Function
// ===========================

export function getSmartProcess(
  cache: CacheEngine,
  tokenCounter: TokenCounter,
  metricsCollector: MetricsCollector
): SmartProcess {
  return new SmartProcess(cache, tokenCounter, metricsCollector);
}

// ===========================
// Standalone Runner Function (CLI)
// ===========================

export async function runSmartProcess(
  options: SmartProcessOptions,
  cache?: CacheEngine,
  tokenCounter?: TokenCounter,
  metricsCollector?: MetricsCollector
): Promise<SmartProcessResult> {
  const { homedir } = await import('os');
  const { join } = await import('path');

  const cacheInstance =
    cache || new CacheEngine(join(homedir(), '.hypercontext', 'cache'), 100);
  const tokenCounterInstance = tokenCounter || new TokenCounter();
  const metricsInstance = metricsCollector || new MetricsCollector();

  const tool = getSmartProcess(
    cacheInstance,
    tokenCounterInstance,
    metricsInstance
  );
  return await tool.run(options);
}

// MCP tool definition
export const SMART_PROCESS_TOOL_DEFINITION = {
  name: 'smart_process',
  description:
    'Intelligent process management with smart caching (88%+ token reduction). Start, stop, monitor processes with resource tracking and cross-platform support. ' +
    'TRUST BOUNDARY: the "start" operation launches an arbitrary executable of the caller\'s choosing, with caller-supplied arguments, working directory and environment. ' +
    'It runs in argv mode with no shell, so there is no command injection, but granting this tool is equivalent to granting local command execution as the user running the server. ' +
    'Operators who do not want that should expose smart_processes (read-only monitoring) instead.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      operation: {
        type: 'string' as const,
        enum: ['start', 'stop', 'status', 'monitor', 'tree', 'restart'],
        description: 'Process operation to perform',
      },
      pid: {
        type: 'number' as const,
        description: 'Process ID (for stop, status, monitor, tree operations)',
      },
      name: {
        type: 'string' as const,
        description: 'Process name (for stop, status operations)',
      },
      command: {
        type: 'string' as const,
        description:
          'Executable to launch (for start operation). Run directly in argv mode with no shell -- this is a path or binary name, not a shell command line, so pipes, redirection and metacharacters are inert here.',
      },
      args: {
        type: 'array' as const,
        items: { type: 'string' as const },
        description: 'Command arguments (for start operation)',
      },
      cwd: {
        type: 'string' as const,
        description: 'Working directory (for start operation)',
      },
      env: {
        type: 'object' as const,
        description: 'Environment variables (for start operation)',
      },
      detached: {
        type: 'boolean' as const,
        description: 'Run process in detached mode (for start operation)',
      },
      autoRestart: {
        type: 'boolean' as const,
        description: 'Automatically restart on failure (for start operation)',
      },
      interval: {
        type: 'number' as const,
        description:
          'Monitoring interval in milliseconds (for monitor operation)',
      },
      duration: {
        type: 'number' as const,
        description:
          'Monitoring duration in milliseconds (for monitor operation)',
      },
      useCache: {
        type: 'boolean' as const,
        description: 'Use cache for status and tree operations (default: true)',
      },
      ttl: {
        type: 'number' as const,
        description:
          'Cache TTL in seconds (default: 30 for status, 60 for tree)',
      },
    },
    required: ['operation'],
  },
};
