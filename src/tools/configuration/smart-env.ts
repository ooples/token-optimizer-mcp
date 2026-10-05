/**
 * Smart Environment Variable Tool
 *
 * Features:
 * - Parse and validate .env files
 * - Detect missing required variables
 * - Cache env configs with 1-hour TTL
 * - Environment-specific suggestions (dev/staging/prod)
 * - Security issue detection (exposed secrets, weak configs)
 * - File hash-based invalidation
 */

import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { CacheEngine, resolveCacheLocation } from '../../core/cache-engine.js';
import type { TokenCounter } from '../../core/token-counter.js';
import type { MetricsCollector } from '../../core/metrics.js';
import { displayPath, shortHash } from '../shared/report-shape.js';

// ===========================
// Types & Interfaces
// ===========================

export interface SmartEnvOptions {
  envFile?: string; // Path to .env file (default: .env)
  envContent?: string; // Direct .env content (instead of file)
  checkSecurity?: boolean; // Check for security issues
  suggestMissing?: boolean; // Suggest missing variables
  environment?: 'development' | 'staging' | 'production'; // Environment type
  requiredVars?: string[]; // Required variable names
  includeLocations?: boolean; // Report each variable's line and value length (default: false)
  force?: boolean; // Bypass cache
  ttl?: number; // Cache TTL in seconds (default: 3600)
}

export interface EnvVariable {
  key: string;
  /**
   * INTERNAL ONLY. Present while parsing, because the security checks genuinely
   * need it -- weak-password detection, localhost URLs, unquoted whitespace --
   * but the response carries no value field at all. See {@link tabulate}.
   */
  value: string;
  line: number;
  hasQuotes: boolean;
  isEmpty: boolean;
}

/**
 * The fields a row holds when the caller asked where each variable is.
 */
export const ENV_LOCATED_COLUMNS = ['key', 'line', 'length'] as const;

/**
 * The fields a row holds by default: the name, and nothing else.
 *
 * MEASURED, AND IT IS WHY THIS TOOL USED TO LOSE ON EVERY FIXTURE. On the
 * 48-variable fixture the two extra numbers were 242 of 538 tokens -- 45% of
 * the report -- and they moved the reading from +39.0% against the file to
 * -10.9%, a tool that cost more than reading the thing it summarised. Both
 * numbers answer "where is it", which is a question about editing the file,
 * not about what is configured in it; the caller that is about to edit asks
 * for them with `includeLocations` and pays for them then.
 */
export const ENV_KEY_COLUMNS = ['key'] as const;

export type EnvVariableColumn = (typeof ENV_LOCATED_COLUMNS)[number];

/**
 * One variable: its name alone, or its name with the line it is on and the
 * characters its value had. The width is the caller's choice, so it is read
 * from `columns` rather than assumed.
 */
export type EnvVariableRow = [string] | [string, number, number];

/**
 * The variables, as a table rather than a list of objects.
 *
 * An array of objects repeats every field name once per variable. On the
 * 48-variable fixture that was 48 copies of "key", "line", "length",
 * "hasQuotes", "isEmpty" and "value" -- 157 tokens of field names, and 48
 * copies of the same "[redacted]" placeholder, for 48 rows of data. Naming each
 * field once costs the same information a third as much, so the report gets
 * smaller without anything being dropped from it.
 *
 * `quoted` and `empty` name only the variables the flag is TRUE of, which in a
 * real .env is almost none of them. An absent list means no variable has that
 * property.
 */
export interface EnvVariableTable {
  columns: EnvVariableColumn[];
  rows: EnvVariableRow[];
  quoted?: string[];
  empty?: string[];
}

/**
 * A .env is where credentials live, so its VALUES must never be returned.
 *
 * Measured live: the tool echoed `"value": "CANARY_password_hunter2_correct"`
 * for every variable, including DB_PASSWORD, JWT_SECRET and STRIPE_KEY, and
 * `checkSecurity: true` made no difference. Every secret in a project therefore
 * landed in the model's context on a single call -- and off the machine
 * entirely for anyone using a hosted model.
 *
 * The key, line, quoting, emptiness and length are all preserved, which is what
 * every legitimate use of this tool actually needs: knowing WHICH variables are
 * defined, not what they are set to.
 */
function tabulate(
  vars: EnvVariable[],
  includeLocations: boolean
): EnvVariableTable {
  const quoted = vars.filter((v) => v.hasQuotes).map((v) => v.key);
  const empty = vars.filter((v) => v.isEmpty).map((v) => v.key);

  return {
    columns: includeLocations ? [...ENV_LOCATED_COLUMNS] : [...ENV_KEY_COLUMNS],
    rows: includeLocations
      ? vars.map((v): EnvVariableRow => [v.key, v.line, v.value.length])
      : vars.map((v): EnvVariableRow => [v.key]),
    ...(quoted.length > 0 ? { quoted } : {}),
    ...(empty.length > 0 ? { empty } : {}),
  };
}

/**
 * Bumped whenever the response shape changes.
 *
 * The cache lives in the user's home directory and outlives any release, and
 * the key was built from the file digest and the options alone. So the run that
 * turned the variable list into a table would have kept serving the previous
 * shape -- objects with a redacted value field -- to anyone whose cache already
 * held an entry for that file, with no error and no way to tell.
 */
const RESPONSE_VERSION = 3;

export interface SecurityIssue {
  severity: 'critical' | 'high' | 'medium' | 'low';
  variable: string;
  issue: string;
  recommendation: string;
  line?: number;
}

export interface MissingVariable {
  name: string;
  description: string;
  defaultValue?: string;
  required: boolean;
}

export interface SmartEnvResult {
  success: boolean;
  environment: string;
  variables: {
    total: number;
    loaded: number;
    empty: number;
    commented: number;
  };
  parsed?: EnvVariableTable;
  missing?: MissingVariable[];
  security?: {
    score: number; // 0-100
    issues: SecurityIssue[];
    hasSecrets: boolean;
  };
  suggestions?: string[];
  metadata: {
    /** The file's sha256, shortened by {@link shortHash}. */
    fileHash?: string;
    filePath?: string;
    cached: boolean;
    // NO TOKEN FIGURES, DELIBERATELY. baselineTokens, tokensUsed and their
    // difference used to sit here. The baseline was honest -- the .env file is
    // exactly what reading it would have cost -- but it is the recorder's to
    // measure now, from the envFile the caller named. The other two were not:
    // tokensUsed counted the report object before this metadata block existed
    // and before the serialised reply was built around it, so it was never the
    // figure the caller was charged, and the difference inherited that error.
  };
}

// ===========================
// Smart Env Class
// ===========================

export class SmartEnv {
  constructor(
    private cache: CacheEngine,
    // ACCEPTED AND NOT USED: this tool no longer counts tokens, because the
    // only figure it counted them for was one it could not stand behind. The
    // parameter stays so the construction call is unchanged for every caller.
    _tokenCounter: TokenCounter,
    private metrics: MetricsCollector
  ) {}

  /**
   * Main entry point for environment analysis
   */
  async run(options: SmartEnvOptions): Promise<SmartEnvResult> {
    const startTime = Date.now();

    try {
      // Get env content (from file or direct content)
      const { content, filePath, fileHash } = await this.getEnvContent(options);

      // Check cache
      const cacheKey = this.generateCacheKey(fileHash, options);
      if (!options.force) {
        const cached = await this.getCached(cacheKey, options.ttl || 3600);
        if (cached) {
          const executionTime = Date.now() - startTime;
          // A cache hit saves the analysis, not the tokens: the same report is
          // still sent. No token figure belongs on this record at all -- what
          // was sent is counted at the wire.
          this.metrics.record({
            operation: 'smart-env',
            duration: executionTime,
            success: true,
            cacheHit: true,
          });
          return cached;
        }
      }

      // Parse environment variables
      const parsed = this.parseEnvContent(content);

      // Analyze variables
      const result = await this.analyzeEnvironment(
        parsed,
        content,
        options,
        filePath,
        fileHash
      );

      // Cache result
      await this.cacheResult(cacheKey, result);

      const executionTime = Date.now() - startTime;

      this.metrics.record({
        operation: 'smart-env',
        duration: executionTime,
        success: true,
        cacheHit: false,
      });

      return result;
    } catch (error) {
      const executionTime = Date.now() - startTime;
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      this.metrics.record({
        operation: 'smart-env',
        duration: executionTime,
        success: false,
        cacheHit: false,
        metadata: { error: errorMessage },
      });

      return {
        success: false,
        environment: options.environment || 'unknown',
        variables: {
          total: 0,
          loaded: 0,
          empty: 0,
          commented: 0,
        },
        metadata: {
          cached: false,
        },
      };
    }
  }

  /**
   * Get environment content from file or direct input
   */
  private async getEnvContent(options: SmartEnvOptions): Promise<{
    content: string;
    filePath?: string;
    fileHash: string;
  }> {
    let content: string;
    let filePath: string | undefined;

    if (options.envContent) {
      content = options.envContent;
    } else {
      filePath = options.envFile || '.env';

      // Resolve relative paths
      if (!path.isAbsolute(filePath)) {
        filePath = path.join(process.cwd(), filePath);
      }

      if (!fs.existsSync(filePath)) {
        throw new Error(`Environment file not found: ${filePath}`);
      }

      content = fs.readFileSync(filePath, 'utf-8');
    }

    // Generate file hash for cache invalidation
    const fileHash = createHash('sha256').update(content).digest('hex');

    return { content, filePath, fileHash };
  }

  /**
   * Parse .env file content into structured variables
   */
  private parseEnvContent(content: string): EnvVariable[] {
    const lines = content.split('\n');
    const variables: EnvVariable[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      const lineNumber = i + 1;

      // Skip empty lines and comments
      if (!line || line.startsWith('#')) {
        continue;
      }

      // Parse KEY=VALUE format
      const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (!match) {
        continue;
      }

      const key = match[1];
      let value = match[2];

      // Check for quotes
      const hasQuotes =
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"));

      // Remove quotes if present
      if (hasQuotes) {
        value = value.slice(1, -1);
      }

      // Handle inline comments (not inside quotes)
      if (!hasQuotes && value.includes('#')) {
        const commentIndex = value.indexOf('#');
        value = value.substring(0, commentIndex).trim();
      }

      variables.push({
        key,
        value,
        line: lineNumber,
        hasQuotes,
        isEmpty: value.length === 0,
      });
    }

    return variables;
  }

  /**
   * Analyze environment variables and generate insights
   */
  private async analyzeEnvironment(
    parsed: EnvVariable[],
    content: string,
    options: SmartEnvOptions,
    filePath?: string,
    fileHash?: string
  ): Promise<SmartEnvResult> {
    const environment = options.environment || this.detectEnvironment(parsed);

    // Count variable types
    const total = parsed.length;
    const loaded = parsed.filter((v) => !v.isEmpty).length;
    const empty = parsed.filter((v) => v.isEmpty).length;
    const commented = content
      .split('\n')
      .filter((line) => line.trim().startsWith('#')).length;

    // Check for missing required variables
    let missing: MissingVariable[] | undefined;
    if (options.suggestMissing) {
      missing = this.detectMissingVariables(
        parsed,
        environment,
        options.requiredVars
      );
    }

    // Security analysis
    let security: SmartEnvResult['security'] | undefined;
    if (options.checkSecurity) {
      security = this.analyzeSecurityIssues(parsed, environment);
    }

    // Generate suggestions
    const suggestions = this.generateSuggestions(
      parsed,
      environment,
      missing,
      security
    );

    // THE REPORT IS COUNTED, NOT ESTIMATED.
    //
    // This used to build a second, smaller object it never sent -- environment,
    // three counts and an issue tally -- count THAT, report its size as
    // tokensUsed, and call the difference between the two a saving. So the tool
    // reported the cost of a payload the caller never received, and measured
    // its "saving" against its own output rather than against the file the
    // caller would otherwise have read. On the eight-line fixture it claimed 24
    // tokens used and 223 saved while sending 375 tokens to replace a 97-token
    // file.
    const report = {
      success: true as const,
      environment,
      variables: { total, loaded, empty, commented },
      // TABULATED HERE, after the security analysis above has used the real
      // values and before anything leaves this module. The response shape has
      // no value field, so a value cannot reach the caller by omission.
      parsed: tabulate(parsed, options.includeLocations === true),
      missing,
      security,
      suggestions,
    };

    return {
      ...report,
      metadata: {
        fileHash: fileHash === undefined ? undefined : shortHash(fileHash),
        filePath: filePath === undefined ? undefined : displayPath(filePath),
        cached: false,
      },
    };
  }

  /**
   * Detect environment type from variable names
   */
  private detectEnvironment(parsed: EnvVariable[]): string {
    const keys = parsed.map((v) => v.key.toLowerCase());

    // Check for explicit environment variable
    const envVar = parsed.find(
      (v) => v.key === 'NODE_ENV' || v.key === 'ENVIRONMENT' || v.key === 'ENV'
    );
    if (envVar) {
      return envVar.value.toLowerCase();
    }

    // Heuristic detection
    if (keys.some((k) => k.includes('prod') || k.includes('production'))) {
      return 'production';
    }
    if (keys.some((k) => k.includes('stag') || k.includes('staging'))) {
      return 'staging';
    }
    if (
      keys.some(
        (k) =>
          k.includes('dev') || k.includes('development') || k.includes('local')
      )
    ) {
      return 'development';
    }

    return 'unknown';
  }

  /**
   * Detect missing required variables
   */
  private detectMissingVariables(
    parsed: EnvVariable[],
    environment: string,
    requiredVars?: string[]
  ): MissingVariable[] {
    const existing = new Set(parsed.map((v) => v.key));
    const missing: MissingVariable[] = [];

    // Check user-specified required variables
    if (requiredVars) {
      for (const varName of requiredVars) {
        if (!existing.has(varName)) {
          missing.push({
            name: varName,
            description: `Required variable not found`,
            required: true,
          });
        }
      }
    }

    // Common variables by environment
    const commonVars = this.getCommonVariables(environment);
    for (const [varName, info] of Object.entries(commonVars)) {
      if (!existing.has(varName) && !requiredVars?.includes(varName)) {
        missing.push({
          name: varName,
          description: info.description,
          defaultValue: info.defaultValue,
          required: info.required,
        });
      }
    }

    return missing;
  }

  /**
   * Get common variables for environment type
   */
  private getCommonVariables(environment: string): Record<
    string,
    {
      description: string;
      defaultValue?: string;
      required: boolean;
    }
  > {
    const common: Record<string, any> = {
      NODE_ENV: {
        description: 'Node.js environment mode',
        defaultValue: environment,
        required: true,
      },
      PORT: {
        description: 'Application port',
        defaultValue: '3000',
        required: false,
      },
      LOG_LEVEL: {
        description: 'Logging level (error, warn, info, debug)',
        defaultValue: environment === 'production' ? 'warn' : 'debug',
        required: false,
      },
    };

    if (environment === 'production') {
      common.REDIS_URL = {
        description: 'Redis connection URL',
        required: true,
      };
      common.DATABASE_URL = {
        description: 'Database connection URL',
        required: true,
      };
    }

    return common;
  }

  /**
   * Analyze security issues in environment variables
   */
  private analyzeSecurityIssues(
    parsed: EnvVariable[],
    environment: string
  ): SmartEnvResult['security'] {
    const issues: SecurityIssue[] = [];
    let score = 100;
    let hasSecrets = false;

    // Security patterns
    const secretPatterns = [
      {
        pattern: /secret|password|pwd|key|token|api_key/i,
        severity: 'critical' as const,
      },
      { pattern: /private|credential|auth/i, severity: 'high' as const },
    ];

    const weakValuePatterns = [
      {
        pattern: /^(password|secret|admin|root|12345|test)$/i,
        name: 'weak value',
        severity: 'critical' as const,
      },
      {
        pattern: /^(true|false|yes|no)$/i,
        name: 'boolean as string',
        severity: 'low' as const,
      },
    ];

    for (const variable of parsed) {
      // Check for secrets in variable names
      for (const { pattern } of secretPatterns) {
        if (pattern.test(variable.key)) {
          hasSecrets = true;

          // Check if value is exposed or weak
          if (!variable.isEmpty && variable.value.length < 16) {
            issues.push({
              severity: 'high',
              variable: variable.key,
              issue: 'Short secret value (less than 16 characters)',
              recommendation:
                'Use a strong, randomly generated value of at least 32 characters',
              line: variable.line,
            });
            score -= 10;
          }

          // Check for weak values
          for (const weakPattern of weakValuePatterns) {
            if (weakPattern.pattern.test(variable.value)) {
              issues.push({
                severity: 'critical',
                variable: variable.key,
                // The VALUE is exactly what must not be repeated back. Naming the
                // variable and the pattern it matched is enough to act on.
                issue: `Weak or common ${weakPattern.name} in ${variable.key}`,
                recommendation:
                  'Use a strong, unique value. Never use default or test values in production',
                line: variable.line,
              });
              score -= 20;
            }
          }
        }
      }

      // Check for empty secrets
      if (variable.isEmpty && /secret|password|key|token/i.test(variable.key)) {
        issues.push({
          severity: 'high',
          variable: variable.key,
          issue: 'Secret variable is empty',
          recommendation: 'Provide a secure value for this variable',
          line: variable.line,
        });
        score -= 15;
      }

      // Check for hardcoded URLs in production
      if (environment === 'production') {
        if (
          variable.value.includes('localhost') ||
          variable.value.includes('127.0.0.1')
        ) {
          issues.push({
            severity: 'critical',
            variable: variable.key,
            issue: 'Localhost URL in production environment',
            recommendation: 'Use production-ready URLs',
            line: variable.line,
          });
          score -= 25;
        }
      }

      // Check for missing quotes on special characters
      if (!variable.hasQuotes && /[\s$`\\]/.test(variable.value)) {
        issues.push({
          severity: 'medium',
          variable: variable.key,
          issue: 'Value contains special characters without quotes',
          recommendation:
            'Wrap value in quotes to prevent shell interpretation',
          line: variable.line,
        });
        score -= 5;
      }
    }

    // Check for missing security-critical variables in production
    if (environment === 'production') {
      const hasHttps = parsed.some((v) => v.value.startsWith('https://'));
      if (!hasHttps) {
        issues.push({
          severity: 'high',
          variable: 'HTTPS URLs',
          issue: 'No HTTPS URLs detected in production',
          recommendation: 'Use HTTPS for all external services in production',
        });
        score -= 10;
      }
    }

    return {
      score: Math.max(0, score),
      issues: issues.slice(0, 10), // Limit to top 10
      hasSecrets,
    };
  }

  /**
   * Generate helpful suggestions
   */
  private generateSuggestions(
    parsed: EnvVariable[],
    environment: string,
    missing?: MissingVariable[],
    security?: SmartEnvResult['security']
  ): string[] {
    const suggestions: string[] = [];

    // Missing variables
    if (missing && missing.length > 0) {
      const requiredMissing = missing.filter((m) => m.required);
      if (requiredMissing.length > 0) {
        suggestions.push(
          `Add ${requiredMissing.length} required variable(s): ${requiredMissing.map((m) => m.name).join(', ')}`
        );
      }
    }

    // Security suggestions
    if (security && security.score < 70) {
      suggestions.push(
        `Security score is ${security.score}/100. Review and fix ${security.issues.length} security issue(s)`
      );
    }

    // Environment-specific suggestions
    if (environment === 'production') {
      const hasBackup = parsed.some((v) => v.key.includes('BACKUP'));
      if (!hasBackup) {
        suggestions.push('Consider adding backup configuration for production');
      }

      const hasMonitoring = parsed.some(
        (v) => v.key.includes('MONITORING') || v.key.includes('SENTRY')
      );
      if (!hasMonitoring) {
        suggestions.push(
          'Consider adding monitoring/error tracking configuration'
        );
      }
    }

    // Empty variables
    const emptyVars = parsed.filter((v) => v.isEmpty);
    if (emptyVars.length > 0) {
      suggestions.push(
        `${emptyVars.length} variable(s) are empty. Provide values or remove unused variables`
      );
    }

    // Documentation suggestion
    const hasComments = parsed.length > 0;
    if (!hasComments) {
      suggestions.push('Add comments to document the purpose of each variable');
    }

    return suggestions;
  }

  /**
   * Generate cache key
   */
  private generateCacheKey(fileHash: string, options: SmartEnvOptions): string {
    const keyData = {
      responseVersion: RESPONSE_VERSION,
      fileHash,
      checkSecurity: options.checkSecurity,
      suggestMissing: options.suggestMissing,
      environment: options.environment,
      requiredVars: options.requiredVars,
      includeLocations: options.includeLocations,
    };
    const hash = createHash('md5')
      .update('smart_env' + JSON.stringify(keyData))
      .digest('hex');
    return `cache-${hash}`;
  }

  /**
   * Get cached result
   */
  private async getCached(
    key: string,
    ttl: number
  ): Promise<SmartEnvResult | null> {
    const cached = await this.cache.get(key);
    if (!cached) return null;

    try {
      const { timestamp, ...result } = JSON.parse(cached) as SmartEnvResult & {
        timestamp: number;
      };
      const age = Date.now() - timestamp;

      if (age > ttl * 1000) {
        await this.cache.delete(key);
        return null;
      }

      // THE STAMP STAYS IN THE CACHE. It is how this function decides the entry
      // is still fresh, and it is of no use to a caller -- but it was being
      // spread into the response, so a repeat read cost eight tokens MORE than
      // the first one on a tool whose description credits its saving to caching.
      result.metadata.cached = true;
      return result;
    } catch {
      return null;
    }
  }

  /**
   * Cache result
   */
  private async cacheResult(
    key: string,
    result: SmartEnvResult
  ): Promise<void> {
    const cacheData = { ...result, timestamp: Date.now() };
    const serialized = JSON.stringify(cacheData);
    const originalSize = Buffer.byteLength(serialized, 'utf-8');
    await this.cache.set(key, serialized, originalSize, originalSize);
  }
}

// ===========================
// Factory Function
// ===========================

export function getSmartEnv(
  cache: CacheEngine,
  tokenCounter: TokenCounter,
  metrics: MetricsCollector
): SmartEnv {
  return new SmartEnv(cache, tokenCounter, metrics);
}

// ===========================
// CLI Runner Function
// ===========================

export async function runSmartEnv(
  options: SmartEnvOptions
): Promise<SmartEnvResult> {
  const { homedir } = await import('os');
  const { join } = await import('path');
  const { TokenCounter } = await import('../../core/token-counter.js');
  const { MetricsCollector } = await import('../../core/metrics.js');

  const cache = new CacheEngine(
    resolveCacheLocation(join(homedir(), '.token-optimizer-cache', 'cache.db'))
  );
  const tokenCounter = new TokenCounter();
  const metrics = new MetricsCollector();

  const tool = getSmartEnv(cache, tokenCounter, metrics);
  const result = await tool.run(options);

  // THE OBJECT, NOT ITS TEXT. A runner that serialises its own answer puts that
  // answer past the one seam where a reply is edited before it is sent, so the
  // envelope pruning in src/server/restated.ts could never see it: this reply
  // kept a success flag, a file hash and an echo of the caller path -- 28 of its
  // 111 tokens -- while every object-returning tool had them removed. The wire
  // bytes are unchanged otherwise, because toResultText serialises compactly too.
  return result;
}

// ===========================
// MCP Tool Definition
// ===========================

export const SMART_ENV_TOOL_DEFINITION = {
  name: 'smart_env',
  description:
    'Smart environment variable analyzer with security checking and suggestions. Measured token reduction vs reading the file: -27% to 37% first read, -27% to 37% repeated (bench/tools, 4 fixtures) -- it names every variable without returning any value, which is where the saving comes from; the loss is the other mode, because `includeLocations` adds each line and the length of each value back and costs 32-48% more.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      envFile: {
        type: 'string',
        description: 'Path to .env file (default: .env in current directory)',
      },
      envContent: {
        type: 'string',
        description: 'Direct .env file content (alternative to envFile)',
      },
      checkSecurity: {
        type: 'boolean',
        description: 'Analyze security issues (default: false)',
        default: false,
      },
      suggestMissing: {
        type: 'boolean',
        description: 'Suggest missing common variables (default: false)',
        default: false,
      },
      environment: {
        type: 'string',
        enum: ['development', 'staging', 'production'],
        description: 'Environment type (auto-detected if not specified)',
      },
      requiredVars: {
        type: 'array',
        items: { type: 'string' },
        description: 'List of required variable names',
      },
      includeLocations: {
        type: 'boolean',
        description:
          "Report each variable's line number and value length as well as its name. Costs about 45% more on a 48-variable file, so it is off unless you are about to edit the file (default: false)",
        default: false,
      },
      force: {
        type: 'boolean',
        description: 'Force fresh analysis, bypass cache (default: false)',
        default: false,
      },
      ttl: {
        type: 'number',
        description: 'Cache TTL in seconds (default: 3600)',
        default: 3600,
      },
    },
  },
};
