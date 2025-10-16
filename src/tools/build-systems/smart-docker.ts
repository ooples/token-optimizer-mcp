/**
 * Smart Docker Tool - Docker Operations with Intelligence
 *
 * Wraps Docker commands to provide:
 * - Build, run, stop, logs operations
 * - Image layer analysis
 * - Resource usage tracking
 * - Token-optimized output
 */

import { spawn } from "child_process";
import { CacheEngine } from "../../core/cache-engine";
import { createHash } from "crypto";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";

interface ContainerInfo {
  id: string;
  name: string;
  image: string;
  status: string;
  ports: string[];
}

interface DockerImage {
  id: string;
  repository: string;
  tag: string;
  size: string;
  created: string;
}

interface DockerResult {
  success: boolean;
  operation: "build" | "run" | "stop" | "logs" | "ps";
  containers?: ContainerInfo[];
  images?: DockerImage[];
  logs?: string[];
  buildLayers?: number;
  duration: number;
  timestamp: number;
}

interface SmartDockerOptions {
  /**
   * Docker operation to perform
   */
  operation: "build" | "run" | "stop" | "logs" | "ps";

  /**
   * Force operation (ignore cache)
   */
  force?: boolean;

  /**
   * Project root directory
   */
  projectRoot?: string;

  /**
   * Dockerfile path
   */
  dockerfile?: string;

  /**
   * Image name for build/run
   */
  imageName?: string;

  /**
   * Container name for run/stop/logs
   */
  containerName?: string;

  /**
   * Build context directory
   */
  context?: string;

  /**
   * Port mappings for run (e.g., ['8080:80', '443:443'])
   */
  ports?: string[];

  /**
   * Environment variables for run
   */
  env?: Record<string, string>;

  /**
   * Follow logs (tail mode)
   */
  follow?: boolean;

  /**
   * Number of log lines to show
   */
  tail?: number;

  /**
   * Maximum cache age in seconds (default: 3600 = 1 hour)
   */
  maxCacheAge?: number;
}

interface SmartDockerOutput {
  /**
   * Operation summary
   */
  summary: {
    success: boolean;
    operation: string;
    duration: number;
    fromCache: boolean;
  };

  /**
   * Container information
   */
  containers?: Array<{
    id: string;
    name: string;
    image: string;
    status: string;
    ports: string[];
  }>;

  /**
   * Image information
   */
  images?: Array<{
    id: string;
    repository: string;
    tag: string;
    size: string;
  }>;

  /**
   * Log entries (for logs operation)
   */
  logs?: Array<{
    timestamp: string;
    level: string;
    message: string;
  }>;

  /**
   * Build information (for build operation)
   */
  buildInfo?: {
    layers: number;
    cacheHits: number;
    totalSize: string;
  };

  /**
   * Optimization suggestions
   */
  suggestions: Array<{
    type: "performance" | "security" | "size";
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

export class SmartDocker {
  private cache: CacheEngine;
  private cacheNamespace = "smart_docker";
  private projectRoot: string;

  constructor(cache: CacheEngine, projectRoot?: string) {
    this.cache = cache;
    this.projectRoot = projectRoot || process.cwd();
  }

  /**
   * Run Docker operation with smart analysis
   */
  async run(options: SmartDockerOptions): Promise<SmartDockerOutput> {
    const { operation, force = false, maxCacheAge = 3600 } = options;

    const startTime = Date.now();

    // Generate cache key
    const cacheKey = this.generateCacheKey(operation, options);

    // Check cache first (unless force mode or logs operations)
    // Note: ps operations are cached with shorter TTL since they can change
    if (!force && operation !== "logs") {
      const cached = this.getCachedResult(cacheKey, maxCacheAge);
      if (cached) {
        return this.formatCachedOutput(cached);
      }
    }

    // Run Docker operation
    const result = await this.runDockerOperation(options);

    const duration = Date.now() - startTime;
    result.duration = duration;

    // Cache the result (except logs which are dynamic)
    // ps operations use shorter cache TTL (60 seconds) compared to builds (3600 seconds)
    if (operation !== "logs") {
      const cacheTTL = operation === "ps" ? 60 : 3600;
      this.cacheResult(cacheKey, result, cacheTTL);
    }

    // Generate suggestions
    const suggestions = this.generateSuggestions(result, options);

    // Transform to smart output
    return this.transformOutput(result, suggestions);
  }

  /**
   * Run Docker operation
   */
  private async runDockerOperation(
    options: SmartDockerOptions,
  ): Promise<DockerResult> {
    const { operation } = options;

    switch (operation) {
      case "build":
        return this.dockerBuild(options);
      case "run":
        return this.dockerRun(options);
      case "stop":
        return this.dockerStop(options);
      case "logs":
        return this.dockerLogs(options);
      case "ps":
        return this.dockerPs(options);
      default:
        throw new Error(`Unknown operation: ${operation}`);
    }
  }

  /**
   * Docker build operation
   */
  private async dockerBuild(
    options: SmartDockerOptions,
  ): Promise<DockerResult> {
    const {
      dockerfile = "Dockerfile",
      imageName = "app:latest",
      context = ".",
    } = options;

    const args = ["build", "-f", dockerfile, "-t", imageName, context];

    return this.execDocker(args, "build");
  }

  /**
   * Docker run operation
   */
  private async dockerRun(options: SmartDockerOptions): Promise<DockerResult> {
    const {
      imageName = "app:latest",
      containerName = "app-container",
      ports = [],
      env = {},
    } = options;

    const args = ["run", "-d", "--name", containerName];

    // Add port mappings
    for (const port of ports) {
      args.push("-p", port);
    }

    // Add environment variables
    for (const [key, value] of Object.entries(env)) {
      args.push("-e", `${key}=${value}`);
    }

    args.push(imageName);

    return this.execDocker(args, "run");
  }

  /**
   * Docker stop operation
   */
  private async dockerStop(options: SmartDockerOptions): Promise<DockerResult> {
    const { containerName = "app-container" } = options;
    const args = ["stop", containerName];

    return this.execDocker(args, "stop");
  }

  /**
   * Docker logs operation
   */
  private async dockerLogs(options: SmartDockerOptions): Promise<DockerResult> {
    const {
      containerName = "app-container",
      follow = false,
      tail = 100,
    } = options;

    const args = ["logs"];

    if (follow) {
      args.push("-f");
    }

    if (tail) {
      args.push("--tail", tail.toString());
    }

    args.push(containerName);

    return this.execDocker(args, "logs");
  }

  /**
   * Docker ps operation
   */
  private async dockerPs(_options: SmartDockerOptions): Promise<DockerResult> {
    const args = [
      "ps",
      "-a",
      "--format",
      "{{.ID}}|{{.Names}}|{{.Image}}|{{.Status}}|{{.Ports}}",
    ];

    return this.execDocker(args, "ps");
  }

  /**
   * Execute Docker command
   */
  private async execDocker(
    args: string[],
    operation: "build" | "run" | "stop" | "logs" | "ps",
  ): Promise<DockerResult> {
    return new Promise((resolve, reject) => {
      let stdout = "";
      let stderr = "";

      const docker = spawn("docker", args, {
        cwd: this.projectRoot,
        shell: true,
      });

      docker.stdout.on("data", (data) => {
        stdout += data.toString();
      });

      docker.stderr.on("data", (data) => {
        stderr += data.toString();
      });

      docker.on("close", (code) => {
        const output = stdout + stderr;

        const result: DockerResult = {
          success: code === 0,
          operation,
          duration: 0, // Set by caller
          timestamp: Date.now(),
        };

        // Parse output based on operation
        if (operation === "ps") {
          result.containers = this.parseContainers(stdout);
        } else if (operation === "logs") {
          result.logs = this.parseLogs(stdout);
        } else if (operation === "build") {
          result.buildLayers = this.countBuildLayers(output);
        }

        resolve(result);
      });

      docker.on("error", (err) => {
        reject(err);
      });
    });
  }

  /**
   * Parse container list
   */
  private parseContainers(output: string): ContainerInfo[] {
    const containers: ContainerInfo[] = [];
    const lines = output.split("\n").filter((l) => l.trim());

    for (const line of lines) {
      const [id, name, image, status, ports] = line.split("|");
      if (id && name) {
        containers.push({
          id: id.substring(0, 12),
          name,
          image,
          status,
          ports: ports ? ports.split(",").map((p) => p.trim()) : [],
        });
      }
    }

    return containers;
  }

  /**
   * Parse log output
   */
  private parseLogs(output: string): string[] {
    return output
      .split("\n")
      .filter((l) => l.trim())
      .slice(-100); // Keep last 100 lines
  }

  /**
   * Count build layers
   */
  private countBuildLayers(output: string): number {
    const stepMatches = output.match(/Step \d+\/\d+/g);
    return stepMatches ? stepMatches.length : 0;
  }

  /**
   * Generate optimization suggestions
   */
  private generateSuggestions(
    result: DockerResult,
    options: SmartDockerOptions,
  ): Array<{
    type: "performance" | "security" | "size";
    message: string;
    impact: "high" | "medium" | "low";
  }> {
    const suggestions = [];

    // Check for Dockerfile best practices
    const dockerfilePath = join(
      this.projectRoot,
      options.dockerfile || "Dockerfile",
    );
    if (existsSync(dockerfilePath)) {
      const dockerfileContent = readFileSync(dockerfilePath, "utf-8");

      // Check for .dockerignore
      if (!existsSync(join(this.projectRoot, ".dockerignore"))) {
        suggestions.push({
          type: "size" as const,
          message: "Add .dockerignore to reduce build context size.",
          impact: "medium" as const,
        });
      }

      // Check for multi-stage builds
      // Count layers from Dockerfile if not available from build operation
      const layerCount =
        result.buildLayers || this.countDockerfileLayers(dockerfileContent);

      if (!dockerfileContent.includes("AS ") && layerCount > 10) {
        suggestions.push({
          type: "size" as const,
          message: "Consider using multi-stage builds to reduce image size.",
          impact: "high" as const,
        });
      }

      // Check for latest tag
      if (
        dockerfileContent.includes("FROM ") &&
        dockerfileContent.includes(":latest")
      ) {
        suggestions.push({
          type: "security" as const,
          message:
            "Avoid using :latest tag in FROM statements for reproducible builds.",
          impact: "high" as const,
        });
      }

      // Check for root user
      if (!dockerfileContent.includes("USER ")) {
        suggestions.push({
          type: "security" as const,
          message: "Specify a non-root USER in Dockerfile for better security.",
          impact: "medium" as const,
        });
      }
    }

    return suggestions;
  }

  /**
   * Generate cache key
   */
  private generateCacheKey(
    operation: string,
    options: SmartDockerOptions,
  ): string {
    const keyParts = [
      operation,
      options.imageName || "",
      options.containerName || "",
      options.dockerfile || "",
    ];

    // Include Dockerfile hash for build operations
    if (operation === "build") {
      const dockerfilePath = join(
        this.projectRoot,
        options.dockerfile || "Dockerfile",
      );
      if (existsSync(dockerfilePath)) {
        const hash = createHash("md5")
          .update(readFileSync(dockerfilePath))
          .digest("hex");
        keyParts.push(hash);
      }
    }

    return createHash("md5").update(keyParts.join(":")).digest("hex");
  }

  /**
   * Count layers in a Dockerfile
   */
  private countDockerfileLayers(content: string): number {
    const layerCommands = ["RUN", "COPY", "ADD", "WORKDIR", "ENV"];
    const lines = content.split("\n");
    let count = 0;
    for (const line of lines) {
      const trimmed = line.trim();
      if (layerCommands.some((cmd) => trimmed.startsWith(cmd + " "))) {
        count++;
      }
    }
    return count;
  }

  /**
   * Get cached result
   */
  private getCachedResult(key: string, maxAge: number): DockerResult | null {
    const cached = this.cache.get(this.cacheNamespace + ":" + key);
    if (!cached) return null;

    try {
      const result = JSON.parse(cached) as DockerResult & {
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
  private cacheResult(
    key: string,
    result: DockerResult,
    ttl: number = 3600,
  ): void {
    const cacheData = { ...result, cachedAt: Date.now() };
    this.cache.set(
      this.cacheNamespace + ":" + key,
      JSON.stringify(cacheData)),
      ttl,
      0,
    );
  }

  /**
   * Transform to smart output
   */
  private transformOutput(
    result: DockerResult,
    suggestions: Array<{
      type: "performance" | "security" | "size";
      message: string;
      impact: "high" | "medium" | "low";
    }>,
    fromCache = false,
  ): SmartDockerOutput {
    const output: SmartDockerOutput = {
      summary: {
        success: result.success,
        operation: result.operation,
        duration: result.duration,
        fromCache,
      },
      suggestions,
      metrics: {
        originalTokens: 0,
        compactedTokens: 0,
        reductionPercentage: 0,
      },
    };

    // Add operation-specific data
    if (result.containers) {
      output.containers = result.containers.map((c) => ({
        id: c.id,
        name: c.name,
        image: c.image,
        status: c.status,
        ports: c.ports,
      }));
    }

    if (result.logs) {
      output.logs = result.logs.map((line) => {
        const timestampMatch = line.match(
          /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z)/,
        );
        const levelMatch = line.match(/\[(ERROR|WARN|INFO|DEBUG)\]/);

        return {
          timestamp: timestampMatch ? timestampMatch[1] : "unknown",
          level: levelMatch ? levelMatch[1] : "info",
          message: line,
        };
      });
    }

    if (result.buildLayers) {
      output.buildInfo = {
        layers: result.buildLayers,
        cacheHits: 0, // TODO: Parse from build output
        totalSize: "unknown", // TODO: Get from docker images
      };
    }

    // Calculate metrics
    const originalSize = this.estimateOriginalOutputSize(result);
    const compactSize = this.estimateCompactSize(output);

    output.metrics = {
      originalTokens: Math.ceil(originalSize / 4),
      compactedTokens: Math.ceil(compactSize / 4),
      reductionPercentage: Math.round(
        ((originalSize - compactSize) / originalSize) * 100,
      ),
    };

    return output;
  }

  /**
   * Format cached output
   */
  private formatCachedOutput(result: DockerResult): SmartDockerOutput {
    return this.transformOutput(result, [], true);
  }

  /**
   * Estimate original output size
   */
  private estimateOriginalOutputSize(result: DockerResult): number {
    // Estimate: Docker verbose output can be very large
    let size = 1000; // Base

    if (result.containers) {
      size += result.containers.length * 200;
    }

    if (result.logs) {
      size += result.logs.reduce((sum, log) => sum + log.length, 0);
    }

    if (result.buildLayers) {
      size += result.buildLayers * 150; // Each layer output
    }

    return size;
  }

  /**
   * Estimate compact output size
   */
  private estimateCompactSize(output: SmartDockerOutput): number {
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
export function getSmartDocker(
  cache: CacheEngine,
  projectRoot?: string,
): SmartDocker {
  return new SmartDocker(cache, projectRoot);
}

/**
 * CLI-friendly function for running smart docker
 */
export async function runSmartDocker(
  options: SmartDockerOptions,
): Promise<string> {
  const cache = new CacheEngine(100, join(homedir(), ".hypercontext", "cache"));
  const smartDocker = getSmartDocker(cache, options.projectRoot);
  try {
    const result = await smartDocker.run(options);

    let output = `\n🐳 Smart Docker Results ${result.summary.fromCache ? "(cached)" : ""}\n`;
    output += `${"=".repeat(50)}\n\n`;

    // Summary
    output += `Summary:\n`;
    output += `  Operation: ${result.summary.operation}\n`;
    output += `  Status: ${result.summary.success ? "✓ Success" : "✗ Failed"}\n`;
    output += `  Duration: ${(result.summary.duration / 1000).toFixed(2)}s\n\n`;

    // Containers
    if (result.containers && result.containers.length > 0) {
      output += `Containers:\n`;
      for (const container of result.containers) {
        output += `  • ${container.name} (${container.id})\n`;
        output += `    Image: ${container.image}\n`;
        output += `    Status: ${container.status}\n`;
        if (container.ports.length > 0) {
          output += `    Ports: ${container.ports.join(", ")}\n`;
        }
      }
      output += "\n";
    }

    // Build info
    if (result.buildInfo) {
      output += `Build Information:\n`;
      output += `  Layers: ${result.buildInfo.layers}\n`;
      output += `  Cache Hits: ${result.buildInfo.cacheHits}\n`;
      output += `  Total Size: ${result.buildInfo.totalSize}\n\n`;
    }

    // Logs
    if (result.logs && result.logs.length > 0) {
      output += `Recent Logs (${result.logs.length} entries):\n`;
      for (const log of result.logs.slice(-20)) {
        const icon =
          log.level === "ERROR" ? "🔴" : log.level === "WARN" ? "⚠️" : "ℹ️";
        output += `  ${icon} ${log.message}\n`;
      }
      output += "\n";
    }

    // Suggestions
    if (result.suggestions.length > 0) {
      output += `Optimization Suggestions:\n`;
      for (const suggestion of result.suggestions) {
        const icon =
          suggestion.impact === "high"
            ? "🔴"
            : suggestion.impact === "medium"
              ? "🟡"
              : "🟢";
        output += `  ${icon} [${suggestion.type}] ${suggestion.message}\n`;
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
    smartDocker.close();
  }
}
