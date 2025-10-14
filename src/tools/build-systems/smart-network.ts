/**
 * Smart Network Tool - Network Diagnostics and Monitoring
 *
 * Provides intelligent network analysis with:
 * - Connectivity testing
 * - Latency measurement
 * - Port scanning
 * - DNS resolution
 * - Token-optimized output
 */

import { spawn } from "childprocess";
import { CacheEngine } from "../../core/cache-engine";
import { createHash } from "crypto";
import { homedir } from "os";
import { join } from "path";
import * as dns from "dns";
import * as net from "net";
import { promisify } from "util";

const _dnsResolve = promisify(dns.resolve);
const dnsLookup = promisify(dns.lookup);

interface ConnectivityResult {
  host: string;
  reachable: boolean;
  latency?: number;
  error?: string;
}

interface PortCheckResult {
  host: string;
  port: number;
  open: boolean;
  service?: string;
}

interface DnsResult {
  hostname: string;
  addresses: string[];
  error?: string;
}

interface NetworkResult {
  success: boolean;
  connectivity: ConnectivityResult[];
  ports?: PortCheckResult[];
  dns?: DnsResult[];
  latencyStats?: {
    min: number;
    max: number;
    avg: number;
  };
  duration: number;
  timestamp: number;
}

interface SmartNetworkOptions {
  /**
   * Network operation to perform
   */
  operation: "ping" | "port-scan" | "dns" | "traceroute" | "all";

  /**
   * Hosts to test (for ping/port-scan operations)
   */
  hosts?: string[];

  /**
   * Ports to scan (for port-scan operation)
   */
  ports?: number[];

  /**
   * Hostnames for DNS resolution
   */
  hostnames?: string[];

  /**
   * Number of ping attempts per host
   */
  pingCount?: number;

  /**
   * Timeout in milliseconds
   */
  timeout?: number;

  /**
   * Project root directory
   */
  projectRoot?: string;

  /**
   * Maximum cache age in seconds (default: 300 = 5 minutes)
   */
  maxCacheAge?: number;
}

interface SmartNetworkOutput {
  /**
   * Summary
   */
  summary: {
    success: boolean;
    operation: string;
    hostsChecked: number;
    reachableHosts: number;
    duration: number;
    fromCache: boolean;
  };

  /**
   * Connectivity results
   */
  connectivity: Array<{
    host: string;
    reachable: boolean;
    latency?: number;
    status: "online" | "offline" | "timeout";
  }>;

  /**
   * Port scan results
   */
  ports?: Array<{
    host: string;
    port: number;
    open: boolean;
    service?: string;
  }>;

  /**
   * DNS resolution results
   */
  dns?: Array<{
    hostname: string;
    addresses: string[];
    resolved: boolean;
  }>;

  /**
   * Latency statistics
   */
  latencyStats?: {
    min: number;
    max: number;
    avg: number;
    distribution: string;
  };

  /**
   * Network diagnostics
   */
  diagnostics: Array<{
    type: "connectivity" | "dns" | "performance";
    message: string;
    severity: "critical" | "warning" | "info";
  }>;

  /**
   * Recommendations
   */
  recommendations: Array<{
    type: "connectivity" | "performance" | "configuration";
    message: string;
    impact: "high" | "medium" | "low";
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

export class SmartNetwork {
  private cache: CacheEngine;
  private cacheNamespace = "smart_network";
  private projectRoot: string;

  constructor(cache: CacheEngine, projectRoot?: string) {
    this.cache = cache;
    this.projectRoot = projectRoot || process.cwd();
  }

  /**
   * Run network diagnostics
   */
  async run(options: SmartNetworkOptions): Promise<SmartNetworkOutput> {
    const {
      operation,
      hosts = ["8.8.8.8", "google.com"],
      ports = [80, 443],
      hostnames = ["google.com", "github.com"],
      pingCount = 4,
      timeout = 5000,
      maxCacheAge = 300,
    } = options;

    const startTime = Date.now();

    // Generate cache key
    const cacheKey = this.generateCacheKey(operation, hosts, ports, hostnames);

    // Check cache first
    const cached = this.getCachedResult(cacheKey, maxCacheAge);
    if (cached) {
      return this.formatCachedOutput(cached);
    }

    // Run network operation
    const result = await this.runNetworkOperation({
      operation,
      hosts,
      ports,
      hostnames,
      pingCount,
      timeout,
    });

    const duration = Date.now() - startTime;
    result.duration = duration;

    // Cache the result
    this.cacheResult(cacheKey, result);

    // Generate diagnostics and recommendations
    const diagnostics = this.generateDiagnostics(result);
    const recommendations = this.generateRecommendations(result);

    // Transform to smart output
    return this.transformOutput(result, diagnostics, recommendations);
  }

  /**
   * Run network operation
   */
  private async runNetworkOperation(options: {
    operation: string;
    hosts: string[];
    ports: number[];
    hostnames: string[];
    pingCount: number;
    timeout: number;
  }): Promise<NetworkResult> {
    const { operation, hosts, ports, hostnames, pingCount, timeout } = options;

    const result: NetworkResult = {
      success: true,
      connectivity: [],
      duration: 0,
      timestamp: Date.now(),
    };

    // Connectivity checks
    if (operation === "ping" || operation === "all") {
      result.connectivity = await this.pingHosts(hosts, pingCount, timeout);
      result.latencyStats = this.calculateLatencyStats(result.connectivity);
    }

    // Port scanning
    if (operation === "port-scan" || operation === "all") {
      result.ports = await this.scanPorts(hosts, ports, timeout);
    }

    // DNS resolution
    if (operation === "dns" || operation === "all") {
      result.dns = await this.resolveDns(hostnames);
    }

    // Traceroute
    if (operation === "traceroute") {
      // Traceroute is complex and platform-specific, simplified for now
      result.connectivity = await this.pingHosts(hosts, 1, timeout);
    }

    return result;
  }

  /**
   * Ping hosts
   */
  private async pingHosts(
    hosts: string[],
    count: number,
    timeout: number,
  ): Promise<ConnectivityResult[]> {
    const results: ConnectivityResult[] = [];

    for (const host of hosts) {
      const result = await this.pingHost(host, count, timeout);
      results.push(result);
    }

    return results;
  }

  /**
   * Ping a single host
   */
  private async pingHost(
    host: string,
    count: number,
    timeout: number,
  ): Promise<ConnectivityResult> {
    return new Promise((resolve) => {
      let output = "";

      // Platform-specific ping command
      const isWindows = process.platform === "win32";
      const command = isWindows ? "ping" : "ping";
      const args = isWindows
        ? ["-n", count.toString(), "-w", timeout.toString(), host]
        : ["-c", count.toString(), "-W", (timeout / 1000).toString(), host];

      const child = spawn(command, args, { shell: true });

      child.stdout.on("data", (data) => {
        output += data.toString();
      });

      child.on("close", (code) => {
        if (code === 0) {
          const latency = this.parsePingLatency(output);
          resolve({
            host,
            reachable: true,
            latency,
          });
        } else {
          resolve({
            host,
            reachable: false,
            error: "Host unreachable",
          });
        }
      });

      child.on("error", (err) => {
        resolve({
          host,
          reachable: false,
          error: err.message,
        });
      });
    });
  }

  /**
   * Parse ping latency from output
   */
  private parsePingLatency(output: string): number {
    // Windows: Average = XXXms
    const windowsMatch = output.match(/Average\s*=\s*(\d+)ms/);
    if (windowsMatch) {
      return parseInt(windowsMatch[1], 10);
    }

    // Unix: rtt min/avg/max/mdev = X.X/Y.Y/Z.Z/W.W ms
    const unixMatch = output.match(
      /rtt[^=]*=\s*[\d.]+\/([\d.]+)\/([\d.]+)\/([\d.]+)/,
    );
    if (unixMatch) {
      return parseFloat(unixMatch[2]); // avg
    }

    return 0;
  }

  /**
   * Scan ports on hosts
   */
  private async scanPorts(
    hosts: string[],
    ports: number[],
    timeout: number,
  ): Promise<PortCheckResult[]> {
    const results: PortCheckResult[] = [];

    for (const host of hosts) {
      for (const port of ports) {
        const result = await this.checkPort(host, port, timeout);
        results.push(result);
      }
    }

    return results;
  }

  /**
   * Check if a port is open
   */
  private async checkPort(
    host: string,
    port: number,
    timeout: number,
  ): Promise<PortCheckResult> {
    return new Promise((resolve) => {
      const socket = new net.Socket();

      const timer = setTimeout(() => {
        socket.destroy();
        resolve({
          host,
          port,
          open: false,
        });
      }, timeout);

      socket.connect(port, host, () => {
        clearTimeout(timer);
        socket.destroy();
        resolve({
          host,
          port,
          open: true,
          service: this.getServiceName(port),
        });
      });

      socket.on("error", () => {
        clearTimeout(timer);
        resolve({
          host,
          port,
          open: false,
        });
      });
    });
  }

  /**
   * Get service name for common ports
   */
  private getServiceName(port: number): string {
    const services: Record<number, string> = {
      20: "FTP Data",
      21: "FTP Control",
      22: "SSH",
      23: "Telnet",
      25: "SMTP",
      53: "DNS",
      80: "HTTP",
      110: "POP3",
      143: "IMAP",
      443: "HTTPS",
      465: "SMTPS",
      587: "SMTP Submission",
      993: "IMAPS",
      995: "POP3S",
      3306: "MySQL",
      5432: "PostgreSQL",
      6379: "Redis",
      8080: "HTTP Alt",
      8443: "HTTPS Alt",
      27017: "MongoDB",
    };

    return services[port] || `Port ${port}`;
  }

  /**
   * Resolve DNS for hostnames
   */
  private async resolveDns(hostnames: string[]): Promise<DnsResult[]> {
    const results: DnsResult[] = [];

    for (const hostname of hostnames) {
      try {
        const lookup = await dnsLookup(hostname);
        results.push({
          hostname,
          addresses: [lookup.address],
        });
      } catch (err) {
        results.push({
          hostname,
          addresses: [],
          error: (err as Error).message,
        });
      }
    }

    return results;
  }

  /**
   * Calculate latency statistics
   */
  private calculateLatencyStats(connectivity: ConnectivityResult[]):
    | {
        min: number;
        max: number;
        avg: number;
      }
    | undefined {
    const latencies = connectivity
      .filter((c) => c.latency !== undefined)
      .map((c) => c.latency!);

    if (latencies.length === 0) {
      return undefined;
    }

    const min = Math.min(...latencies);
    const max = Math.max(...latencies);
    const avg = latencies.reduce((sum, l) => sum + l, 0) / latencies.length;

    return {
      min: Math.round(min * 100) / 100,
      max: Math.round(max * 100) / 100,
      avg: Math.round(avg * 100) / 100,
    };
  }

  /**
   * Generate diagnostics
   */
  private generateDiagnostics(result: NetworkResult): Array<{
    type: "connectivity" | "dns" | "performance";
    message: string;
    severity: "critical" | "warning" | "info";
  }> {
    const diagnostics: Array<{
      type: "connectivity" | "dns" | "performance";
      message: string;
      severity: "critical" | "warning" | "info";
    }> = [];

    // Connectivity diagnostics
    const unreachableHosts = result.connectivity.filter((c) => !c.reachable);
    if (unreachableHosts.length > 0) {
      diagnostics.push({
        type: "connectivity",
        severity:
          unreachableHosts.length === result.connectivity.length
            ? "critical"
            : "warning",
        message: `${unreachableHosts.length} host(s) unreachable: ${unreachableHosts.map((h) => h.host).join(", ")}`,
      });
    }

    // Performance diagnostics
    if (result.latencyStats) {
      if (result.latencyStats.avg > 200) {
        diagnostics.push({
          type: "performance",
          severity: result.latencyStats.avg > 500 ? "warning" : "info",
          message: `High average latency: ${result.latencyStats.avg}ms`,
        });
      }
    }

    // DNS diagnostics
    if (result.dns) {
      const failedDns = result.dns.filter((d) => d.error);
      if (failedDns.length > 0) {
        diagnostics.push({
          type: "dns",
          severity: "warning",
          message: `DNS resolution failed for: ${failedDns.map((d) => d.hostname).join(", ")}`,
        });
      }
    }

    return diagnostics;
  }

  /**
   * Generate recommendations
   */
  private generateRecommendations(result: NetworkResult): Array<{
    type: "connectivity" | "performance" | "configuration";
    message: string;
    impact: "high" | "medium" | "low";
  }> {
    const recommendations: Array<{
      type: "connectivity" | "performance" | "configuration";
      message: string;
      impact: "high" | "medium" | "low";
    }> = [];

    // Check if all hosts are unreachable
    const allUnreachable = result.connectivity.every((c) => !c.reachable);
    if (allUnreachable && result.connectivity.length > 0) {
      recommendations.push({
        type: "connectivity",
        message:
          "All hosts unreachable. Check firewall, VPN, or internet connection.",
        impact: "high",
      });
    }

    // High latency recommendations
    if (result.latencyStats && result.latencyStats.avg > 200) {
      recommendations.push({
        type: "performance",
        message:
          "High network latency detected. Consider using a CDN or checking network quality.",
        impact: "medium",
      });
    }

    // Port security recommendations
    if (result.ports) {
      const openPorts = result.ports.filter((p) => p.open);
      const sensitivePorts = openPorts.filter((p) =>
        [23, 21, 3306, 5432, 27017].includes(p.port),
      );
      if (sensitivePorts.length > 0) {
        recommendations.push({
          type: "configuration",
          message: `Sensitive ports open: ${sensitivePorts.map((p) => p.service).join(", ")}. Ensure proper security measures.`,
          impact: "high",
        });
      }
    }

    return recommendations;
  }

  /**
   * Generate cache key
   */
  private generateCacheKey(
    operation: string,
    hosts: string[],
    ports: number[],
    hostnames: string[],
  ): string {
    const keyParts = [
      operation,
      hosts.join(","),
      ports.join(","),
      hostnames.join(","),
    ];
    return createHash("md5").update(keyParts.join(":")).digest("hex");
  }

  /**
   * Get cached result
   */
  private getCachedResult(key: string, maxAge: number): NetworkResult | null {
    const cached = this.cache.get(this.cacheNamespace + ":" + key);
    if (!cached) return null;

    try {
      const result = JSON.parse(cached.toString("utf-8")) as NetworkResult & {
        cachedAt: number;
      };
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
  private cacheResult(key: string, result: NetworkResult): void {
    const cacheData = { ...result, cachedAt: Date.now() };
    this.cache.set(
      this.cacheNamespace + ":" + key,
      Buffer.from(JSON.stringify(cacheData)),
      3600,
      0,
    );
  }

  /**
   * Transform to smart output
   */
  private transformOutput(
    result: NetworkResult,
    diagnostics: Array<{
      type: "connectivity" | "dns" | "performance";
      message: string;
      severity: "critical" | "warning" | "info";
    }>,
    recommendations: Array<{
      type: "connectivity" | "performance" | "configuration";
      message: string;
      impact: "high" | "medium" | "low";
    }>,
    fromCache = false,
  ): SmartNetworkOutput {
    const connectivity = result.connectivity.map((c) => ({
      host: c.host,
      reachable: c.reachable,
      latency: c.latency,
      status: c.reachable
        ? ("online" as const)
        : c.error?.includes("timeout")
          ? ("timeout" as const)
          : ("offline" as const),
    }));

    const ports = result.ports?.map((p) => ({
      host: p.host,
      port: p.port,
      open: p.open,
      service: p.service,
    }));

    const dns = result.dns?.map((d) => ({
      hostname: d.hostname,
      addresses: d.addresses,
      resolved: !d.error,
    }));

    let latencyStats = result.latencyStats
      ? {
          ...result.latencyStats,
          distribution: this.getLatencyDistribution(result.latencyStats),
        }
      : undefined;

    const originalSize = this.estimateOriginalOutputSize(result);
    const compactSize = this.estimateCompactSize({ connectivity, ports, dns });

    const reachableCount = connectivity.filter((c) => c.reachable).length;

    return {
      summary: {
        success: result.success,
        operation: "network diagnostics",
        hostsChecked: connectivity.length,
        reachableHosts: reachableCount,
        duration: result.duration,
        fromCache,
      },
      connectivity,
      ports,
      dns,
      latencyStats,
      diagnostics,
      recommendations,
      metrics: {
        originalTokens: Math.ceil(originalSize / 4),
        compactedTokens: Math.ceil(compactSize / 4),
        reductionPercentage: Math.round(
          ((originalSize - compactSize) / originalSize) * 100,
        ),
      },
    };
  }

  /**
   * Get latency distribution description
   */
  private getLatencyDistribution(stats: {
    min: number;
    max: number;
    avg: number;
  }): string {
    if (stats.avg < 50) return "Excellent";
    if (stats.avg < 100) return "Good";
    if (stats.avg < 200) return "Fair";
    if (stats.avg < 500) return "Poor";
    return "Very Poor";
  }

  /**
   * Format cached output
   */
  private formatCachedOutput(result: NetworkResult): SmartNetworkOutput {
    return this.transformOutput(result, [], [], true);
  }

  /**
   * Estimate original output size
   */
  private estimateOriginalOutputSize(result: NetworkResult): number {
    // Verbose ping/traceroute output
    let size = 1000;

    size += result.connectivity.length * 200;
    size += (result.ports?.length || 0) * 100;
    size += (result.dns?.length || 0) * 150;

    return size;
  }

  /**
   * Estimate compact output size
   */
  private estimateCompactSize(output: {
    connectivity: unknown[];
    ports?: unknown[];
    dns?: unknown[];
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
export function getSmartNetwork(
  cache: CacheEngine,
  projectRoot?: string,
): SmartNetwork {
  return new SmartNetwork(cache, projectRoot);
}

/**
 * CLI-friendly function for running smart network diagnostics
 */
export async function runSmartNetwork(
  options: SmartNetworkOptions,
): Promise<string> {
  const cache = new CacheEngine(100, join(homedir(), ".hypercontext", "cache"));
  const smartNetwork = getSmartNetwork(cache, options.projectRoot);
  try {
    const result = await smartNetwork.run(options);

    let output = `\n🌐 Smart Network Diagnostics ${result.summary.fromCache ? "(cached)" : ""}\n`;
    output += `${"=".repeat(50)}\n\n`;

    // Summary
    output += `Summary:\n`;
    output += `  Operation: ${result.summary.operation}\n`;
    output += `  Hosts Checked: ${result.summary.hostsChecked}\n`;
    output += `  Reachable: ${result.summary.reachableHosts}/${result.summary.hostsChecked}\n`;
    output += `  Duration: ${(result.summary.duration / 1000).toFixed(2)}s\n\n`;

    // Connectivity
    if (result.connectivity.length > 0) {
      output += `Connectivity:\n`;
      for (const conn of result.connectivity) {
        const icon =
          conn.status === "online"
            ? "✓"
            : conn.status === "timeout"
              ? "⏱"
              : "✗";
        output += `  ${icon} ${conn.host}: ${conn.status}`;
        if (conn.latency) {
          output += ` (${conn.latency}ms)`;
        }
        output += "\n";
      }
      output += "\n";
    }

    // Latency stats
    if (result.latencyStats) {
      output += `Latency Statistics:\n`;
      output += `  Min: ${result.latencyStats.min}ms\n`;
      output += `  Avg: ${result.latencyStats.avg}ms\n`;
      output += `  Max: ${result.latencyStats.max}ms\n`;
      output += `  Quality: ${result.latencyStats.distribution}\n\n`;
    }

    // Ports
    if (result.ports && result.ports.length > 0) {
      output += `Port Scan Results:\n`;
      for (const port of result.ports) {
        const icon = port.open ? "🟢" : "🔴";
        output += `  ${icon} ${port.host}:${port.port} (${port.service || "Unknown"}) - ${port.open ? "Open" : "Closed"}\n`;
      }
      output += "\n";
    }

    // DNS
    if (result.dns && result.dns.length > 0) {
      output += `DNS Resolution:\n`;
      for (const dns of result.dns) {
        const icon = dns.resolved ? "✓" : "✗";
        output += `  ${icon} ${dns.hostname}`;
        if (dns.resolved) {
          output += `: ${dns.addresses.join(", ")}`;
        } else {
          output += ": Failed to resolve";
        }
        output += "\n";
      }
      output += "\n";
    }

    // Diagnostics
    if (result.diagnostics.length > 0) {
      output += `Diagnostics:\n`;
      for (const diag of result.diagnostics) {
        const icon =
          diag.severity === "critical"
            ? "🔴"
            : diag.severity === "warning"
              ? "⚠️"
              : "ℹ️";
        output += `  ${icon} [${diag.type}] ${diag.message}\n`;
      }
      output += "\n";
    }

    // Recommendations
    if (result.recommendations.length > 0) {
      output += `Recommendations:\n`;
      for (const rec of result.recommendations) {
        const icon =
          rec.impact === "high" ? "🔴" : rec.impact === "medium" ? "🟡" : "🟢";
        output += `  ${icon} [${rec.type}] ${rec.message}\n`;
      }
      output += "\n";
    }

    // Metrics
    output += `Token Reduction:\n`;
    output += `  Original: ${result.metrics.originalTokens} tokens\n`;
    output += `  Compacted: ${result.metrics.compactedTokens} tokens\n`;
    output += `  Reduction: ${result.metrics.reductionPercentage}%\n`;

    return output;
  } finally {
    smartNetwork.close();
  }
}
