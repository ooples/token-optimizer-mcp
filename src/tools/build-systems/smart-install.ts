/**
 * Smart Install Tool - Package Installation with Dependency Analysis
 *
 * Wraps package managers (npm/yarn/pnpm) to provide:
 * - Package manager auto-detection
 * - Dependency analysis and conflict detection
 * - Installation progress tracking
 * - Token-optimized output
 */

import { spawn } from 'child_process';
import { CacheEngine } from '../../core/cache-engine';
import { createHash } from 'crypto';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

interface PackageInfo {
  name: string;
  version: string;
  type: 'dependency' | 'devDependency' | 'peerDependency';
}

interface DependencyConflict {
  package: string;
  requested: string;
  installed: string;
  severity: 'error' | 'warning';
}

interface InstallResult {
  success: boolean;
  packageManager: 'npm' | 'yarn' | 'pnpm';
  packagesInstalled: PackageInfo[];
  conflicts: DependencyConflict[];
  duration: number;
  timestamp: number;
}

interface SmartInstallOptions {
  /**
   * Force reinstall (ignore cache)
   */
  force?: boolean;

  /**
   * Project root directory
   */
  projectRoot?: string;

  /**
   * Package manager to use (auto-detect if not specified)
   */
  packageManager?: 'npm' | 'yarn' | 'pnpm';

  /**
   * Packages to install (if empty, installs all from package.json)
   */
  packages?: string[];

  /**
   * Install as dev dependency
   */
  dev?: boolean;

  /**
   * Maximum cache age in seconds (default: 3600 = 1 hour)
   */
  maxCacheAge?: number;
}

interface SmartInstallOutput {
  /**
   * Installation summary
   */
  summary: {
    success: boolean;
    packageManager: string;
    packagesInstalled: number;
    conflictsFound: number;
    duration: number;
    fromCache: boolean;
  };

  /**
   * Installed packages
   */
  packages: Array<{
    name: string;
    version: string;
    type: string;
  }>;

  /**
   * Dependency conflicts
   */
  conflicts: Array<{
    package: string;
    requested: string;
    installed: string;
    severity: string;
    resolution: string;
  }>;

  /**
   * Installation recommendations
   */
  recommendations: Array<{
    type: 'security' | 'performance' | 'compatibility';
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

export class SmartInstall {
  private cache: CacheEngine;
  private cacheNamespace = 'smart_install';
  private projectRoot: string;

  constructor(cache: CacheEngine, projectRoot?: string) {
    this.cache = cache;
    this.projectRoot = projectRoot || process.cwd();
  }

  /**
   * Run installation with smart analysis
   */
  async run(options: SmartInstallOptions = {}): Promise<SmartInstallOutput> {
    const {
      force = false,
      packageManager,
      packages = [],
      dev = false,
      maxCacheAge = 3600,
    } = options;

    const startTime = Date.now();

    // Detect package manager
    const detectedPm = packageManager || this.detectPackageManager();

    // Check if lockfile exists BEFORE running install (for recommendations)
    const lockFile =
      detectedPm === 'npm'
        ? 'package-lock.json'
        : detectedPm === 'yarn'
          ? 'yarn.lock'
          : 'pnpm-lock.yaml';
    const hadLockfileBeforeInstall = existsSync(
      join(this.projectRoot, lockFile)
    );

    // Generate cache key
    const cacheKey = this.generateCacheKey(detectedPm, packages, dev);

    // Check cache first (unless force mode)
    if (!force) {
      const cached = this.getCachedResult(cacheKey, maxCacheAge);
      if (cached) {
        return this.formatCachedOutput(cached);
      }
    }

    // Run installation
    const result = await this.runInstall({
      packageManager: detectedPm,
      packages,
      dev,
    });

    // Store pre-install lockfile state for recommendations
    (result as any).hadLockfileBeforeInstall = hadLockfileBeforeInstall;

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
   * Detect which package manager is in use
   */
  private detectPackageManager(): 'npm' | 'yarn' | 'pnpm' {
    const projectRoot = this.projectRoot;

    // Check for lock files
    if (existsSync(join(projectRoot, 'pnpm-lock.yaml'))) {
      return 'pnpm';
    }
    if (existsSync(join(projectRoot, 'yarn.lock'))) {
      return 'yarn';
    }
    if (existsSync(join(projectRoot, 'package-lock.json'))) {
      return 'npm';
    }

    // Default to npm
    return 'npm';
  }

  /**
   * Run package installation
   */
  private async runInstall(options: {
    packageManager: 'npm' | 'yarn' | 'pnpm';
    packages: string[];
    dev: boolean;
  }): Promise<InstallResult> {
    const { packageManager, packages, dev } = options;

    let args: string[] = [];

    // Build command args based on package manager
    if (packages.length === 0) {
      // Install all dependencies
      args = packageManager === 'yarn' ? [] : ['install'];
    } else {
      // Install specific packages
      if (packageManager === 'npm') {
        args = ['install', ...packages];
        if (dev) args.push('--save-dev');
      } else if (packageManager === 'yarn') {
        args = ['add', ...packages];
        if (dev) args.push('--dev');
      } else if (packageManager === 'pnpm') {
        args = ['add', ...packages];
        if (dev) args.push('--save-dev');
      }
    }

    return new Promise((resolve, reject) => {
      let stdout = '';
      let stderr = '';

      const child = spawn(packageManager, args, {
        cwd: this.projectRoot,
        shell: true,
      });

      child.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      child.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      child.on('close', (code) => {
        const output = stdout + stderr;
        const installedPackages = this.parseInstalledPackages(output, packages);
        const conflicts = this.detectConflicts(output);

        resolve({
          success: code === 0,
          packageManager,
          packagesInstalled: installedPackages,
          conflicts,
          duration: 0, // Set by caller
          timestamp: Date.now(),
        });
      });

      child.on('error', (err) => {
        reject(err);
      });
    });
  }

  /**
   * Parse installed packages from output
   */
  private parseInstalledPackages(
    _output: string,
    requestedPackages: string[]
  ): PackageInfo[] {
    const packages: PackageInfo[] = [];

    // Parse package.json to get actual versions
    const packageJsonPath = join(this.projectRoot, 'package.json');
    if (existsSync(packageJsonPath)) {
      const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));

      // If specific packages requested, use those
      if (requestedPackages.length > 0) {
        for (const pkg of requestedPackages) {
          const [name, version] = pkg.split('@');
          const actualVersion =
            packageJson.dependencies?.[name] ||
            packageJson.devDependencies?.[name] ||
            version ||
            'latest';
          const type = packageJson.devDependencies?.[name]
            ? 'devDependency'
            : 'dependency';

          packages.push({ name, version: actualVersion, type });
        }
      } else {
        // All dependencies
        for (const [name, version] of Object.entries(
          packageJson.dependencies || {}
        )) {
          packages.push({
            name,
            version: version as string,
            type: 'dependency',
          });
        }
        for (const [name, version] of Object.entries(
          packageJson.devDependencies || {}
        )) {
          packages.push({
            name,
            version: version as string,
            type: 'devDependency',
          });
        }
      }
    }

    return packages;
  }

  /**
   * Detect dependency conflicts
   */
  private detectConflicts(output: string): DependencyConflict[] {
    const conflicts: DependencyConflict[] = [];
    const lines = output.split('\n');

    for (const line of lines) {
      // npm: WARN ... requires ... but will install ...
      const npmMatch = line.match(
        /WARN.*?(\S+).*?requires.*?(\S+).*?will install.*?(\S+)/
      );
      if (npmMatch) {
        conflicts.push({
          package: npmMatch[1],
          requested: npmMatch[2],
          installed: npmMatch[3],
          severity: 'warning',
        });
      }

      // yarn/pnpm: warning ... has unmet peer dependency ...
      const peerMatch = line.match(
        /warning.*?(\S+).*?unmet peer dependency.*?(\S+)@(\S+)/
      );
      if (peerMatch) {
        conflicts.push({
          package: peerMatch[1],
          requested: peerMatch[3],
          installed: 'not installed',
          severity: 'warning',
        });
      }
    }

    return conflicts;
  }

  /**
   * Generate installation recommendations
   */
  private generateRecommendations(result: InstallResult): Array<{
    type: 'security' | 'performance' | 'compatibility';
    message: string;
    impact: 'high' | 'medium' | 'low';
  }> {
    const recommendations = [];

    // Check for conflicts
    if (result.conflicts.length > 0) {
      recommendations.push({
        type: 'compatibility' as const,
        message: `Found ${result.conflicts.length} dependency conflicts. Run 'npm ls' to investigate.`,
        impact: 'high' as const,
      });
    }

    // Check for lockfile (use pre-install state to avoid false positives)
    const lockFile =
      result.packageManager === 'npm'
        ? 'package-lock.json'
        : result.packageManager === 'yarn'
          ? 'yarn.lock'
          : 'pnpm-lock.yaml';
    const hadLockfile = (result as any).hadLockfileBeforeInstall;
    if (
      hadLockfile === false ||
      (!hadLockfile && !existsSync(join(this.projectRoot, lockFile)))
    ) {
      recommendations.push({
        type: 'security' as const,
        message: `Missing ${lockFile}. Commit it for reproducible builds.`,
        impact: 'high' as const,
      });
    }

    // Performance: suggest pnpm for large projects
    if (
      result.packagesInstalled.length > 100 &&
      result.packageManager !== 'pnpm'
    ) {
      recommendations.push({
        type: 'performance' as const,
        message: 'Consider using pnpm for faster installs on large projects.',
        impact: 'medium' as const,
      });
    }

    return recommendations;
  }

  /**
   * Generate cache key
   */
  private generateCacheKey(
    packageManager: string,
    packages: string[],
    dev: boolean
  ): string {
    const packageJsonPath = join(this.projectRoot, 'package.json');
    const packageJsonHash = existsSync(packageJsonPath)
      ? createHash('md5').update(readFileSync(packageJsonPath)).digest('hex')
      : 'no-package-json';

    const key = `${packageManager}:${packages.join(',')}:${dev}:${packageJsonHash}`;
    return createHash('md5').update(key).digest('hex');
  }

  /**
   * Get cached result
   */
  private getCachedResult(key: string, maxAge: number): InstallResult | null {
    const cached = this.cache.get(this.cacheNamespace + ':' + key);
    if (!cached) return null;

    try {
      const result = JSON.parse(cached) as InstallResult & { cachedAt: number };
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
  private cacheResult(key: string, result: InstallResult): void {
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
    result: InstallResult,
    recommendations: Array<{
      type: 'security' | 'performance' | 'compatibility';
      message: string;
      impact: 'high' | 'medium' | 'low';
    }>,
    fromCache = false
  ): SmartInstallOutput {
    const conflicts = result.conflicts.map((c) => ({
      package: c.package,
      requested: c.requested,
      installed: c.installed,
      severity: c.severity,
      resolution:
        c.severity === 'error'
          ? 'Must resolve before installation'
          : 'Consider upgrading or adding peer dependency',
    }));

    const packages = result.packagesInstalled.map((p) => ({
      name: p.name,
      version: p.version,
      type: p.type,
    }));

    const originalSize = this.estimateOriginalOutputSize(result);
    const compactSize = this.estimateCompactSize(result);

    return {
      summary: {
        success: result.success,
        packageManager: result.packageManager,
        packagesInstalled: result.packagesInstalled.length,
        conflictsFound: result.conflicts.length,
        duration: result.duration,
        fromCache,
      },
      packages: packages.slice(0, 20), // Limit to 20 for output
      conflicts,
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
   * Format cached output
   */
  private formatCachedOutput(result: InstallResult): SmartInstallOutput {
    const recommendations = this.generateRecommendations(result);
    return this.transformOutput(result, recommendations, true);
  }

  /**
   * Estimate original output size (full npm install output)
   */
  private estimateOriginalOutputSize(result: InstallResult): number {
    // Estimate: each package line ~100 chars
    const packageSize = result.packagesInstalled.length * 100;
    // Plus progress bars and verbose output ~2000 chars
    return packageSize + 2000;
  }

  /**
   * Estimate compact output size
   */
  private estimateCompactSize(result: InstallResult): number {
    const summary = {
      success: result.success,
      packagesInstalled: result.packagesInstalled.length,
      conflictsFound: result.conflicts.length,
    };

    const packages = result.packagesInstalled.slice(0, 20);
    const conflicts = result.conflicts;

    return JSON.stringify({ summary, packages, conflicts }).length;
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
export function getSmartInstall(
  cache: CacheEngine,
  projectRoot?: string
): SmartInstall {
  return new SmartInstall(cache, projectRoot);
}

/**
 * CLI-friendly function for running smart install
 */
export async function runSmartInstall(
  options: SmartInstallOptions = {}
): Promise<string> {
  const cache = new CacheEngine(join(homedir(), '.hypercontext', 'cache'), 100);
  const smartInstall = getSmartInstall(cache, options.projectRoot);
  try {
    const result = await smartInstall.run(options);

    let output = `\n📦 Smart Install Results ${result.summary.fromCache ? '(cached)' : ''}\n`;
    output += `${'='.repeat(50)}\n\n`;

    // Summary
    output += `Summary:\n`;
    output += `  Status: ${result.summary.success ? '✓ Success' : '✗ Failed'}\n`;
    output += `  Package Manager: ${result.summary.packageManager}\n`;
    output += `  Packages Installed: ${result.summary.packagesInstalled}\n`;
    output += `  Conflicts: ${result.summary.conflictsFound}\n`;
    output += `  Duration: ${(result.summary.duration / 1000).toFixed(2)}s\n\n`;

    // Packages
    if (result.packages.length > 0) {
      output += `Installed Packages (showing ${Math.min(result.packages.length, 20)}):\n`;
      for (const pkg of result.packages.slice(0, 20)) {
        output += `  • ${pkg.name}@${pkg.version} (${pkg.type})\n`;
      }
      if (result.packages.length > 20) {
        output += `  ... and ${result.packages.length - 20} more\n`;
      }
      output += '\n';
    }

    // Conflicts
    if (result.conflicts.length > 0) {
      output += `Dependency Conflicts:\n`;
      for (const conflict of result.conflicts) {
        const icon = conflict.severity === 'error' ? '🔴' : '⚠️';
        output += `  ${icon} ${conflict.package}\n`;
        output += `      Requested: ${conflict.requested}\n`;
        output += `      Installed: ${conflict.installed}\n`;
        output += `      Resolution: ${conflict.resolution}\n`;
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
    smartInstall.close();
  }
}
