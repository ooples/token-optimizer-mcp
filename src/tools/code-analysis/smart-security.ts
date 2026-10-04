/**
 * Smart Security Tool - 83% Token Reduction
 *
 * Vulnerability scanning with intelligent caching:
 * - Pattern-based detection for common vulnerabilities
 * - Cached scan results with 24-hour TTL
 * - Incremental scanning (only changed files)
 * - Severity-based reporting with remediation suggestions
 * - <1 hour full scan requirement for daily TTL
 */

import { CacheEngine, resolveCacheLocation } from '../../core/cache-engine.js';
import { MetricsCollector } from '../../core/metrics.js';
import { TokenCounter } from '../../core/token-counter.js';
import { createHash } from 'crypto';
import { readFileSync, existsSync, statSync } from 'fs';
import { join, relative, extname, isAbsolute, resolve } from 'path';
import { homedir } from 'os';
import { hashFileMetadata } from '../shared/hash-utils.js';
import {
  boundedWalk,
  traversalDeadlineMs,
  type TruncationReason,
} from '../shared/bounded-traversal.js';

/**
 * Vulnerability severity levels
 */
type VulnerabilitySeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';

/**
 * Vulnerability categories
 */
type VulnerabilityCategory =
  | 'injection'
  | 'xss'
  | 'secrets'
  | 'crypto'
  | 'auth'
  | 'dos'
  | 'path-traversal'
  | 'unsafe-eval'
  | 'regex'
  | 'dependency'
  | 'config';

/**
 * Individual vulnerability finding
 */
interface VulnerabilityFinding {
  file: string;
  line: number;
  column: number;
  severity: VulnerabilitySeverity;
  category: VulnerabilityCategory;
  ruleId: string;
  message: string;
  code: string; // The vulnerable code snippet
  remediation: string;
  cwe?: string; // Common Weakness Enumeration ID
}

/**
 * Vulnerability pattern definition
 */
interface VulnerabilityPattern {
  id: string;
  name: string;
  category: VulnerabilityCategory;
  severity: VulnerabilitySeverity;
  pattern: RegExp;
  fileExtensions: string[];
  message: string;
  remediation: string;
  cwe?: string;
  contextRequired?: boolean; // If true, requires AST/context analysis
}

/**
 * Scan result for a single file
 */
interface FileScanResult {
  file: string;
  hash: string;
  scannedAt: number;
  findings: VulnerabilityFinding[];
  linesScanned: number;
}

/**
 * Complete security scan result
 */
/**
 * The file types the pattern rules below actually know how to read.
 *
 * Hoisted out of the walk so the accept test is a lookup rather than an array
 * literal rebuilt once per directory entry.
 */
const SCANNABLE_EXTENSIONS = [
  '.js',
  '.ts',
  '.jsx',
  '.tsx',
  '.py',
  '.java',
  '.cs',
  '.go',
  '.rb',
  '.php',
  '.html',
];

interface SecurityScanResult {
  success: boolean;
  filesScanned: string[];
  totalFindings: number;
  findingsBySeverity: Record<VulnerabilitySeverity, number>;
  findingsByCategory: Record<VulnerabilityCategory, number>;
  findings: VulnerabilityFinding[];
  timestamp: number;
}

/**
 * Why a requested target produced no file to scan.
 *
 * A fixed vocabulary rather than free text, because the caller's next action
 * depends on which of these it is: a typo, a path written for the wrong root,
 * or a directory that genuinely holds nothing this scanner reads.
 */
export const TARGET_FAILURES = Object.freeze({
  missing: 'no such file or directory',
  noScannableFile: 'a directory holding no file with a scannable extension',
  unreadable: 'could not be read',
} as const);

export type TargetFailure = keyof typeof TARGET_FAILURES;

/** A target that resolved to nothing, and why. */
export interface UnresolvedTarget {
  /** Exactly the string the caller passed, so it can be corrected. */
  target: string;
  /** Where it was looked for, which is the half the caller cannot see. */
  resolvedTo: string;
  reason: TargetFailure;
}

/**
 * Options for smart security scan
 */
export interface SmartSecurityOptions {
  /**
   * Force full scan (ignore cache)
   */
  force?: boolean;

  /**
   * Project root directory
   */
  projectRoot?: string;

  /**
   * Files or directories to scan (specific targets for incremental mode)
   *
   * Absolute paths are accepted. They used to be joined onto `projectRoot`,
   * which produced a path that cannot exist -- and because an unresolvable
   * target was skipped silently, a scan of one named file reported `Secure`
   * over nothing at all.
   */
  targets?: string[];

  /**
   * A single file to scan. Alias for `targets: [filePath]`.
   *
   * Every other tool on this server names its subject `filePath`, so callers
   * wrote it here too -- and the schema dropped the key, turning a request
   * about one file into an unfiltered scan of the whole project whose findings
   * were then reported as that file's. Accepting the name a caller would
   * reasonably use is cheaper than being right about which one is canonical.
   */
  filePath?: string;

  /**
   * File patterns to exclude (glob patterns)
   */
  exclude?: string[];

  /**
   * Minimum severity level to report
   */
  minSeverity?: VulnerabilitySeverity;

  /**
   * Maximum cache age in seconds (default: 86400 = 24 hours)
   */
  maxCacheAge?: number;

  /**
   * Include low-severity findings
   */
  includeLowSeverity?: boolean;

  /**
   * Wall-clock budget in ms for discovering the files to scan.
   *
   * Discovery was a recursive `readdirSync` that enumerated every entry and
   * only THEN tested it against `exclude` -- so a project with `node_modules`
   * paid the full cost of reading the thing it was excluding, on the event
   * loop, with no point at which it could give up. Defaults to 10 s.
   */
  deadlineMs?: number;
}

/**
 * Smart security output (token-optimized)
 */
export interface SmartSecurityOutput {
  /**
   * Scan summary
   */
  summary: {
    success: boolean;
    filesScanned: number;
    filesFromCache: number;
    totalFindings: number;
    criticalCount: number;
    highCount: number;
    mediumCount: number;
    lowCount: number;
    fromCache: boolean;
    incrementalMode: boolean;
    /**
     * Set when a bound stopped file discovery, so files were never opened.
     *
     * This flag is the whole difference between "no vulnerabilities" and "no
     * vulnerabilities in the files I got to". Absent means the walk completed.
     */
    searchTruncated?: boolean;
    searchTruncatedBy?: TruncationReason;
    searchNote?: string;

    /**
     * Set when NO FILE WAS OPENED, which is never a pass.
     *
     * `success` means "no critical or high findings", and over an empty file
     * set that was trivially true: a scan of a path this tool could not resolve
     * printed the same `Secure` as a scan that examined the code and found it
     * clean. The two are not the same answer and must not read the same.
     */
    scannedNothing?: boolean;
    /** Each requested target that resolved to no file, and why. */
    unresolvedTargets?: UnresolvedTarget[];
    /** One sentence saying what was not examined. Present with scannedNothing. */
    refusal?: string;
  };

  /**
   * Findings grouped by severity
   */
  findingsBySeverity: Array<{
    severity: VulnerabilitySeverity;
    count: number;
    items: Array<{
      file: string;
      location: string;
      category: VulnerabilityCategory;
      message: string;
      remediation: string;
    }>;
  }>;

  /**
   * Findings grouped by category
   */
  findingsByCategory: Array<{
    category: VulnerabilityCategory;
    count: number;
    criticalCount: number;
    highCount: number;
    topFiles: string[];
  }>;

  /**
   * Critical remediation priorities
   */
  remediationPriorities: Array<{
    priority: number;
    category: VulnerabilityCategory;
    severity: VulnerabilitySeverity;
    count: number;
    impact: string;
    action: string;
  }>;

  // NO metrics FIELD, DELIBERATELY. Both halves were counted off objects
  // inside this tool: the "original" was the full internal result serialised,
  // which no caller was ever going to be sent, and the "compacted" was three
  // of its arrays, which is not the report a caller reads either. That is how
  // one flat 85% came to be printed for three fixtures whose real figures
  // were 98.0%, 97.1% and 92.3%. The before a caller actually displaced is
  // the source files named in the arguments, which the recorder reads for
  // itself; the after is the reply, counted once at the wire.
}

/**
 * What a truncated discovery means, in the words both the normal and the
 * refused path use -- two spellings of this would be two different claims.
 */
function truncationNote(deadlineMs: number, found: number): string {
  return (
    'File discovery stopped at the ' +
    deadlineMs +
    'ms traversal deadline after finding ' +
    found +
    ' file(s), so parts of the project were never scanned and a clean result does NOT mean there is nothing there. Narrow `targets`, widen `exclude`, or raise TOKEN_OPTIMIZER_TRAVERSAL_DEADLINE_MS.'
  );
}

/**
 * Vulnerability detection patterns
 */
const VULNERABILITY_PATTERNS: VulnerabilityPattern[] = [
  // SQL Injection
  {
    id: 'sql-injection',
    name: 'SQL Injection',
    category: 'injection',
    severity: 'critical',
    pattern:
      /(?:execute|query|exec)\s*\(\s*[`'"].*?\$\{|(?:execute|query|exec)\s*\(\s*.*?\+\s*.*?\)/gi,
    fileExtensions: [
      '.js',
      '.ts',
      '.jsx',
      '.tsx',
      '.py',
      '.php',
      '.java',
      '.cs',
      '.go',
    ],
    message:
      'Potential SQL injection vulnerability - string concatenation in query',
    remediation:
      'Use parameterized queries or prepared statements instead of string concatenation',
    cwe: 'CWE-89',
  },

  // XSS - innerHTML
  {
    id: 'xss-innerhtml',
    name: 'XSS via innerHTML',
    category: 'xss',
    severity: 'high',
    pattern: /\.innerHTML\s*=\s*(?!['"])/gi,
    fileExtensions: ['.js', '.ts', '.jsx', '.tsx', '.html'],
    message: 'Potential XSS vulnerability - direct assignment to innerHTML',
    remediation:
      'Use textContent, or sanitize HTML with DOMPurify before assigning to innerHTML',
    cwe: 'CWE-79',
  },

  // XSS - dangerouslySetInnerHTML
  {
    id: 'xss-dangerous-html',
    name: 'React dangerouslySetInnerHTML',
    category: 'xss',
    severity: 'high',
    pattern: /dangerouslySetInnerHTML\s*=\s*\{\{/gi,
    fileExtensions: ['.jsx', '.tsx'],
    message: 'Potential XSS - dangerouslySetInnerHTML without sanitization',
    remediation:
      'Sanitize HTML with DOMPurify before using dangerouslySetInnerHTML',
    cwe: 'CWE-79',
  },

  // Hardcoded Secrets - API Keys
  {
    id: 'hardcoded-api-key',
    name: 'Hardcoded API Key',
    category: 'secrets',
    severity: 'critical',
    // THE VALUE CLASS MUST ALLOW THE SEPARATORS REAL KEYS USE. This was
    // [a-zA-Z0-9]{16,}, which excludes '_', '-' and '.' -- and essentially every
    // issued credential carries one as a prefix separator. Measured against
    // twelve documented formats, only three matched, and all three were the
    // incidentally-alphanumeric ones (AWS). Stripe `sk_live_...`, GitHub
    // `ghp_...`, Slack `xoxb-...`, Google `AIza...`, SendGrid `SG....`, OpenAI
    // `sk-proj-...` and Anthropic `sk-ant-...` were all invisible -- so the
    // scanner reported "Secure" over a file holding a live-format key.
    //
    // ':' stays excluded, which keeps a URL assigned to one of these variables
    // from matching.
    pattern: /(?:api[_-]?key|apikey)\s*[=:]\s*['"][A-Za-z0-9_\-.]{16,}['"]/gi,
    fileExtensions: [
      '.js',
      '.ts',
      '.jsx',
      '.tsx',
      '.py',
      '.java',
      '.cs',
      '.go',
      '.rb',
      '.php',
    ],
    message: 'Hardcoded API key detected',
    remediation:
      'Move API keys to environment variables or secure credential management',
    cwe: 'CWE-798',
  },

  // Hardcoded Secrets - Passwords
  {
    id: 'hardcoded-password',
    name: 'Hardcoded Password',
    category: 'secrets',
    severity: 'critical',
    pattern: /(?:password|passwd|pwd)\s*[=:]\s*['"][^'"]{4,}['"]/gi,
    fileExtensions: [
      '.js',
      '.ts',
      '.jsx',
      '.tsx',
      '.py',
      '.java',
      '.cs',
      '.go',
      '.rb',
      '.php',
    ],
    message: 'Hardcoded password detected',
    remediation:
      'Use environment variables or secure secret management systems',
    cwe: 'CWE-798',
  },

  // Hardcoded Secrets - Tokens
  {
    id: 'hardcoded-token',
    name: 'Hardcoded Token',
    category: 'secrets',
    severity: 'critical',
    // Same widening as hardcoded-api-key. The class allowed base64 characters
    // but not '_', '-' or '.', so a prefixed credential or a JWT (which is
    // dot-separated) assigned to `token` or `secret` went unreported.
    pattern:
      /(?:token|secret|private[_-]?key)\s*[=:]\s*['"][A-Za-z0-9_\-.+/=]{20,}['"]/gi,
    fileExtensions: [
      '.js',
      '.ts',
      '.jsx',
      '.tsx',
      '.py',
      '.java',
      '.cs',
      '.go',
      '.rb',
      '.php',
    ],
    message: 'Hardcoded secret token detected',
    remediation: 'Use secure credential storage and environment variables',
    cwe: 'CWE-798',
  },

  // Weak Cryptography - MD5/SHA1
  {
    id: 'weak-crypto-hash',
    name: 'Weak Cryptographic Hash',
    category: 'crypto',
    severity: 'high',
    pattern:
      /(?:createHash|hashlib\.(?:md5|sha1)|MessageDigest\.getInstance)\s*\(\s*['"](?:md5|sha1)['"]/gi,
    fileExtensions: ['.js', '.ts', '.py', '.java', '.cs', '.go', '.rb', '.php'],
    message: 'Weak cryptographic hash algorithm (MD5/SHA1)',
    remediation:
      'Use SHA-256, SHA-384, or SHA-512 for cryptographic operations',
    cwe: 'CWE-327',
  },

  // eval() usage
  {
    id: 'unsafe-eval',
    name: 'Unsafe eval()',
    category: 'unsafe-eval',
    severity: 'critical',
    pattern: /\beval\s*\(/gi,
    fileExtensions: ['.js', '.ts', '.jsx', '.tsx'],
    message: 'Use of eval() is extremely dangerous',
    remediation:
      'Refactor to avoid eval(). Use JSON.parse() for JSON, or Function constructor with caution',
    cwe: 'CWE-95',
  },

  // new Function() usage
  {
    id: 'unsafe-function-constructor',
    name: 'Unsafe Function Constructor',
    category: 'unsafe-eval',
    severity: 'high',
    pattern: /new\s+Function\s*\(/gi,
    fileExtensions: ['.js', '.ts', '.jsx', '.tsx'],
    message: 'Function constructor with dynamic code is dangerous',
    remediation:
      'Refactor to use proper function definitions or safe alternatives',
    cwe: 'CWE-95',
  },

  // Path Traversal
  {
    id: 'path-traversal',
    name: 'Path Traversal',
    category: 'path-traversal',
    severity: 'high',
    pattern:
      /(?:readFile|writeFile|unlink|rmdir|mkdir|access|open)\s*\([^)]*(?:\.\.|\/\.\.\/)/gi,
    fileExtensions: [
      '.js',
      '.ts',
      '.jsx',
      '.tsx',
      '.py',
      '.java',
      '.cs',
      '.go',
      '.php',
    ],
    message: 'Potential path traversal vulnerability',
    remediation:
      'Validate and sanitize file paths, use path.resolve() and check if result is within allowed directory',
    cwe: 'CWE-22',
  },

  // ReDoS - Catastrophic Backtracking
  {
    id: 'redos-pattern',
    name: 'ReDoS Vulnerable Pattern',
    category: 'regex',
    severity: 'medium',
    pattern:
      /new\s+RegExp\s*\([^)]*(?:\(\.\*\)\+|\(\.\+\)\+|\(.*\)\*\(.*\)\*)/gi,
    fileExtensions: [
      '.js',
      '.ts',
      '.jsx',
      '.tsx',
      '.py',
      '.java',
      '.cs',
      '.go',
      '.rb',
      '.php',
    ],
    message:
      'Potential ReDoS (Regular Expression Denial of Service) vulnerability',
    remediation:
      'Simplify regex patterns, avoid nested quantifiers, or use regex-dos library for validation',
    cwe: 'CWE-1333',
  },

  // Unvalidated Redirect
  {
    id: 'unvalidated-redirect',
    name: 'Unvalidated Redirect',
    category: 'auth',
    severity: 'medium',
    pattern:
      /(?:redirect|location\.href|window\.location)\s*=\s*(?!['"]http)/gi,
    fileExtensions: [
      '.js',
      '.ts',
      '.jsx',
      '.tsx',
      '.php',
      '.java',
      '.cs',
      '.py',
    ],
    message: 'Potential unvalidated redirect vulnerability',
    remediation: 'Validate redirect URLs against whitelist before redirecting',
    cwe: 'CWE-601',
  },

  // Insecure Random
  {
    id: 'insecure-random',
    name: 'Insecure Random Number Generation',
    category: 'crypto',
    severity: 'medium',
    pattern: /Math\.random\(\)/gi,
    fileExtensions: ['.js', '.ts', '.jsx', '.tsx'],
    message: 'Math.random() is not cryptographically secure',
    remediation:
      'Use crypto.randomBytes() or crypto.getRandomValues() for security-sensitive operations',
    cwe: 'CWE-338',
  },

  // CORS Misconfiguration
  {
    id: 'cors-wildcard',
    name: 'CORS Wildcard',
    category: 'config',
    severity: 'high',
    pattern: /Access-Control-Allow-Origin['"]?\s*:\s*['"]?\*/gi,
    fileExtensions: [
      '.js',
      '.ts',
      '.jsx',
      '.tsx',
      '.py',
      '.java',
      '.cs',
      '.go',
      '.php',
    ],
    message: 'CORS configured with wildcard (*) - allows any origin',
    remediation:
      'Specify explicit allowed origins or implement origin validation',
    cwe: 'CWE-346',
  },

  // Disabled TLS Verification
  {
    id: 'disabled-tls-verification',
    name: 'Disabled TLS Verification',
    category: 'crypto',
    severity: 'critical',
    pattern:
      /(?:rejectUnauthorized|verify|SSL_VERIFY_NONE|CURLOPT_SSL_VERIFYPEER)\s*[=:]\s*(?:false|0|False)/gi,
    fileExtensions: [
      '.js',
      '.ts',
      '.jsx',
      '.tsx',
      '.py',
      '.java',
      '.cs',
      '.go',
      '.php',
      '.rb',
    ],
    message: 'TLS certificate verification is disabled',
    remediation: 'Enable TLS verification to prevent man-in-the-middle attacks',
    cwe: 'CWE-295',
  },

  // Command Injection
  {
    id: 'command-injection',
    name: 'Command Injection',
    category: 'injection',
    severity: 'critical',
    pattern: /(?:exec|spawn|system|shell_exec|popen)\s*\([^)]*(?:\$\{|`|\+)/gi,
    fileExtensions: ['.js', '.ts', '.jsx', '.tsx', '.py', '.php', '.rb', '.go'],
    message: 'Potential command injection via string concatenation',
    remediation:
      'Use parameterized commands or validate/escape input thoroughly',
    cwe: 'CWE-78',
  },

  // XXE (XML External Entity)
  {
    id: 'xxe-vulnerability',
    name: 'XXE Vulnerability',
    category: 'injection',
    severity: 'high',
    pattern:
      /(?:parseFromString|parseXml|DOMParser|XMLReader)\s*\([^)]*(?:<!ENTITY|<!DOCTYPE)/gi,
    fileExtensions: ['.js', '.ts', '.jsx', '.tsx', '.java', '.cs', '.php'],
    message: 'Potential XXE (XML External Entity) vulnerability',
    remediation:
      'Disable external entity processing in XML parser configuration',
    cwe: 'CWE-611',
  },
];

export class SmartSecurity {
  private cache: CacheEngine;
  private metrics: MetricsCollector;
  private cacheNamespace = 'smart_security';
  private projectRoot: string;
  private fileHashes: Map<string, string> = new Map();

  constructor(
    cache: CacheEngine,
    // ACCEPTED AND NOT USED. This counter was held so the tool could count
    // both halves of its own saving; the halves were two internal objects, so
    // what it produced was a measured figure about the wrong artifact. The
    // parameter stays so every analysis tool is still built by the same
    // three-argument factory call.
    _tokenCounter: TokenCounter,
    metrics: MetricsCollector,
    projectRoot?: string
  ) {
    this.cache = cache;
    this.metrics = metrics;
    this.projectRoot = projectRoot || process.cwd();
  }

  /**
   * Run security scan with intelligent caching
   */
  async run(options: SmartSecurityOptions = {}): Promise<SmartSecurityOutput> {
    const {
      force = false,
      targets = [],
      exclude = ['node_modules', '.git', 'dist', 'build', 'coverage', '.next'],
      minSeverity = 'low',
      maxCacheAge = 86400, // 24 hours
      includeLowSeverity = true,
    } = options;

    const startTime = Date.now();
    const deadlineMs = traversalDeadlineMs(options.deadlineMs);

    // `filePath` is the name every other tool here uses for its subject, and a
    // caller who wrote it got a whole-project scan reported as that file's.
    const requested =
      options.filePath !== undefined && options.filePath !== ''
        ? [...targets, options.filePath]
        : targets;

    // Determine files to scan
    const discovery = await this.discoverFiles(requested, exclude, deadlineMs);
    const filesToScan = discovery.files;

    // NOTHING OPENED IS NOT A PASS, AND NOT A CACHE ENTRY EITHER. Recomputing
    // this costs one failed stat, and an empty file set hashes to one key -- so
    // caching it would let a refusal about one bad path answer for another.
    if (filesToScan.length === 0) {
      return this.refuseEmptyScan(discovery, requested, deadlineMs);
    }

    // Generate cache key
    const cacheKey = await this.generateCacheKey(filesToScan);

    // Check cache first (unless force mode)
    if (!force) {
      const cached = this.getCachedResult(cacheKey, maxCacheAge);
      if (cached) {
        this.metrics.record({
          operation: 'smart_security',
          duration: Date.now() - startTime,
          success: true,
          cacheHit: true,
          // NO TOKEN FIGURES: these read the estimate back off the cached
          // result, so the record republished it rather than measuring.
        });

        return cached;
      }
    }

    // Determine incremental vs full scan
    const incrementalMode = requested.length > 0 && !force;
    const scanResults = incrementalMode
      ? await this.incrementalScan(filesToScan)
      : await this.fullScan(filesToScan);

    const duration = Date.now() - startTime;

    // Filter by severity if needed
    if (minSeverity !== 'low') {
      scanResults.findings = this.filterBySeverity(
        scanResults.findings,
        minSeverity
      );
    }

    if (!includeLowSeverity) {
      scanResults.findings = scanResults.findings.filter(
        (f) => f.severity !== 'low'
      );
    }

    // Transform to compact output
    const output = this.transformOutput(scanResults, incrementalMode);

    if (discovery.truncatedBy) {
      output.summary.searchTruncated = true;
      output.summary.searchTruncatedBy = discovery.truncatedBy;
      output.summary.searchNote = truncationNote(
        deadlineMs,
        filesToScan.length
      );
    }

    // Cached under a key derived from the DISCOVERED FILE SET, so a partial
    // scan can never be served in answer to a complete one: a different set of
    // files hashes to a different key.
    this.cacheResult(cacheKey, output);

    // Record metrics
    this.metrics.record({
      operation: 'smart_security',
      duration,
      success: scanResults.success,
      cacheHit: false,
    });

    return output;
  }

  /**
   * Answer a scan that opened no file, naming what could not be resolved.
   *
   * THE DEFECT THIS REPLACES: `filesScanned: 0` with `success: true` rendered as
   * a green `Secure (no critical/high issues)` status, which is a security
   * claim about code that was never read. Measured over this repo's own
   * fixtures, four of eight ways of naming a target produced exactly that.
   */
  private refuseEmptyScan(
    discovery: {
      files: string[];
      truncatedBy?: TruncationReason;
      unresolved: UnresolvedTarget[];
    },
    requested: string[],
    deadlineMs: number
  ): SmartSecurityOutput {
    const unresolved = discovery.unresolved;
    const described = unresolved.map(
      (item) =>
        `${item.target} -> ${item.resolvedTo} (${TARGET_FAILURES[item.reason]})`
    );
    // A BOUND AND AN UNRESOLVABLE PATH ARE DIFFERENT ANSWERS, and only one of
    // them is the caller's to fix. Discovery that ran out of time reports no
    // unresolved target, because it never got far enough to decide.
    const refusal =
      'No file was examined, so no statement is being made about this code. ' +
      (discovery.truncatedBy !== undefined
        ? truncationNote(deadlineMs, 0)
        : described.length > 0
          ? `${requested.length > 0 ? 'targets' : 'projectRoot'} resolved to 0 files: ${described.join('; ')}`
          : 'Nothing was requested and nothing was found.');

    return {
      summary: {
        // FALSE, because this value is what a caller tests to decide whether the
        // code passed -- and over zero files the honest answer is "unknown",
        // which on a two-valued flag has to be the one that does not pass.
        success: false,
        filesScanned: 0,
        filesFromCache: 0,
        totalFindings: 0,
        criticalCount: 0,
        highCount: 0,
        mediumCount: 0,
        lowCount: 0,
        fromCache: false,
        incrementalMode: false,
        scannedNothing: true,
        unresolvedTargets: unresolved,
        refusal,
        // Carried through rather than dropped: `scannedNothing` says no file was
        // opened, and these say whether that was a bound or a bad path.
        ...(discovery.truncatedBy !== undefined
          ? {
              searchTruncated: true,
              searchTruncatedBy: discovery.truncatedBy,
              searchNote: truncationNote(deadlineMs, 0),
            }
          : {}),
      },
      findingsBySeverity: [],
      findingsByCategory: [],
      remediationPriorities: [],
      // Nothing was read, so nothing was saved -- and nothing is said. A zeroed
      // metrics block used to stand here to avoid claiming a saving against a
      // file that was never opened, which was right as far as it went, but a
      // measured zero is still a claim. The refusal now carries no figures at
      // all, like every other reply from this tool.
    };
  }

  /**
   * Discover files to scan
   */
  private async discoverFiles(
    targets: string[],
    exclude: string[],
    deadlineMs: number
  ): Promise<{
    files: string[];
    truncatedBy?: TruncationReason;
    unresolved: UnresolvedTarget[];
  }> {
    // ONE budget for the whole call. `targets` is a list, and a per-target
    // deadline would multiply the ceiling by however many the caller passed.
    const expiresAt = Date.now() + deadlineMs;
    const remainingMs = () => Math.max(1, expiresAt - Date.now());

    const isExcluded = (fullPath: string): boolean => {
      const relativePath = relative(this.projectRoot, fullPath);
      return exclude.some((pattern) => relativePath.includes(pattern));
    };

    const files: string[] = [];
    const unresolved: UnresolvedTarget[] = [];
    let truncatedBy: TruncationReason | undefined;

    const scanDirectory = async (dir: string) => {
      if (!existsSync(dir)) return;

      // PRUNED, NOT FILTERED. The exclusion ran after enumerating each entry,
      // so `node_modules` was read in full and then discarded directory by
      // directory -- paying the entire cost of the thing being excluded.
      // Pruning is exactly equivalent to the old test rather than a tightening
      // of it: a child's relative path contains its parent's, so everything
      // under an excluded directory already failed the same substring check.
      const walk = await boundedWalk(dir, {
        prune: (_name, fullPath) => isExcluded(fullPath),
        accept: (fullPath, fileName) =>
          !isExcluded(fullPath) &&
          SCANNABLE_EXTENSIONS.includes(extname(fileName)),
        // NO CAP, DELIBERATELY. A file that was never opened is
        // indistinguishable in this output from a file with no
        // vulnerabilities, so a cap converts "I stopped looking" into "this
        // project is clean" -- the most dangerous wrong answer this server can
        // produce. A deadline is reportable, so it never makes that claim.
        deadlineMs: remainingMs(),
      });
      files.push(...walk.items);
      if (walk.truncated) truncatedBy = walk.truncatedBy;
    };

    if (targets.length > 0) {
      // Scan specific targets
      for (const target of targets) {
        if (truncatedBy) break;
        // AN ABSOLUTE TARGET IS ALREADY A PATH. Joining one onto the root built
        // `<root>/C:/...`, which exists nowhere, and the miss was then skipped
        // without a word -- so `targets: ['C:/repo/app.ts']` scanned no file and
        // still answered `Secure`.
        const fullPath = isAbsolute(target)
          ? resolve(target)
          : resolve(this.projectRoot, target);
        if (!existsSync(fullPath)) {
          unresolved.push({
            target,
            resolvedTo: fullPath,
            reason: 'missing',
          });
          continue;
        }
        let stat;
        try {
          stat = statSync(fullPath);
        } catch (error) {
          // Logged rather than swallowed: an unreadable target is the one case
          // here with a cause the caller cannot see from the path alone.
          console.error(`Error reading target ${target}:`, error);
          unresolved.push({
            target,
            resolvedTo: fullPath,
            reason: 'unreadable',
          });
          continue;
        }
        if (stat.isDirectory()) {
          const before = files.length;
          await scanDirectory(fullPath);
          // A directory that contributed nothing is as unexamined as a missing
          // one, and only truncation makes that a bound rather than a fact.
          if (files.length === before && !truncatedBy) {
            unresolved.push({
              target,
              resolvedTo: fullPath,
              reason: 'noScannableFile',
            });
          }
        } else if (stat.isFile()) {
          // AN EXPLICIT FILE IS SCANNED WHATEVER ITS EXTENSION. The caller named
          // this one, so the extension filter -- which exists to keep a blind
          // walk cheap -- has nothing to decide here.
          files.push(fullPath);
        } else {
          unresolved.push({
            target,
            resolvedTo: fullPath,
            reason: 'missing',
          });
        }
      }
    } else {
      // Full project scan
      await scanDirectory(this.projectRoot);
      if (files.length === 0 && !truncatedBy) {
        unresolved.push({
          target: this.projectRoot,
          resolvedTo: this.projectRoot,
          reason: 'noScannableFile',
        });
      }
    }

    return { files, truncatedBy, unresolved };
  }

  /**
   * Full security scan of all files
   */
  private async fullScan(files: string[]): Promise<SecurityScanResult> {
    const findings: VulnerabilityFinding[] = [];
    const filesScanned: string[] = [];

    for (const file of files) {
      const fileResult = await this.scanFile(file);
      if (fileResult) {
        filesScanned.push(file);
        findings.push(...fileResult.findings);
        this.fileHashes.set(file, fileResult.hash);
      }
    }

    return this.buildScanResult(findings, filesScanned);
  }

  /**
   * Incremental scan - only scan changed files
   */
  private async incrementalScan(files: string[]): Promise<SecurityScanResult> {
    const findings: VulnerabilityFinding[] = [];
    const filesScanned: string[] = [];

    for (const file of files) {
      // Check if file changed
      const currentHash = this.generateFileHash(file);
      const cachedHash = this.fileHashes.get(file);

      if (currentHash !== cachedHash) {
        const fileResult = await this.scanFile(file);
        if (fileResult) {
          filesScanned.push(file);
          findings.push(...fileResult.findings);
          this.fileHashes.set(file, fileResult.hash);
        }
      }
    }

    return this.buildScanResult(findings, filesScanned);
  }

  /**
   * Scan a single file for vulnerabilities
   */
  private async scanFile(filePath: string): Promise<FileScanResult | null> {
    // NO existsSync GUARD. It was a second syscall per file asking exactly what
    // the read answers by failing -- 1.08 s across 12,000 files, on top of the
    // read it was guarding. A file that vanished between discovery and scanning
    // is ordinary and stays silent; anything else is still reported.
    let content: string;
    try {
      content = readFileSync(filePath, 'utf-8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        console.error(`Error reading file ${filePath}:`, error);
      }
      return null;
    }

    try {
      const lines = content.split('\n');
      const ext = extname(filePath);
      const findings: VulnerabilityFinding[] = [];

      // Apply each pattern
      for (const pattern of VULNERABILITY_PATTERNS) {
        // Skip if file extension doesn't match
        if (!pattern.fileExtensions.includes(ext)) {
          continue;
        }

        // Scan for pattern
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          const matches = Array.from(line.matchAll(pattern.pattern));

          for (const match of matches) {
            const column = match.index || 0;
            findings.push({
              file: relative(this.projectRoot, filePath),
              line: i + 1,
              column,
              severity: pattern.severity,
              category: pattern.category,
              ruleId: pattern.id,
              message: pattern.message,
              code: line.trim(),
              remediation: pattern.remediation,
              cwe: pattern.cwe,
            });
          }
        }
      }

      return {
        file: filePath,
        // The content is already in hand; hashing it costs nothing, whereas
        // re-reading the file cost a third of this tool's runtime.
        hash: this.generateFileHash(filePath, content),
        scannedAt: Date.now(),
        findings,
        linesScanned: lines.length,
      };
    } catch (error) {
      console.error(`Error scanning file ${filePath}:`, error);
      return null;
    }
  }

  /**
   * Build complete scan result
   */
  private buildScanResult(
    findings: VulnerabilityFinding[],
    filesScanned: string[]
  ): SecurityScanResult {
    const findingsBySeverity: Record<VulnerabilitySeverity, number> = {
      critical: 0,
      high: 0,
      medium: 0,
      low: 0,
      info: 0,
    };

    const findingsByCategory: Record<VulnerabilityCategory, number> = {
      injection: 0,
      xss: 0,
      secrets: 0,
      crypto: 0,
      auth: 0,
      dos: 0,
      'path-traversal': 0,
      'unsafe-eval': 0,
      regex: 0,
      dependency: 0,
      config: 0,
    };

    for (const finding of findings) {
      findingsBySeverity[finding.severity]++;
      findingsByCategory[finding.category]++;
    }

    return {
      success:
        findingsBySeverity.critical === 0 && findingsBySeverity.high === 0,
      filesScanned,
      totalFindings: findings.length,
      findingsBySeverity,
      findingsByCategory,
      findings,
      timestamp: Date.now(),
    };
  }

  /**
   * Transform to token-optimized output
   */
  private transformOutput(
    result: SecurityScanResult,
    incrementalMode: boolean
  ): SmartSecurityOutput {
    // Group findings by severity
    const findingsBySeverity = this.groupBySeverity(result.findings);

    // Group findings by category
    const findingsByCategory = this.groupByCategory(result.findings);

    // Generate remediation priorities
    const remediationPriorities = this.generateRemediationPriorities(
      result.findings
    );

    return {
      summary: {
        success: result.success,
        filesScanned: result.filesScanned.length,
        filesFromCache: 0,
        totalFindings: result.totalFindings,
        criticalCount: result.findingsBySeverity.critical,
        highCount: result.findingsBySeverity.high,
        mediumCount: result.findingsBySeverity.medium,
        lowCount: result.findingsBySeverity.low,
        fromCache: false,
        incrementalMode,
      },
      findingsBySeverity,
      findingsByCategory,
      remediationPriorities,
    };
  }

  /**
   * Group findings by severity
   */
  private groupBySeverity(findings: VulnerabilityFinding[]): Array<{
    severity: VulnerabilitySeverity;
    count: number;
    items: Array<{
      file: string;
      location: string;
      category: VulnerabilityCategory;
      message: string;
      remediation: string;
    }>;
  }> {
    const groups: Record<VulnerabilitySeverity, VulnerabilityFinding[]> = {
      critical: [],
      high: [],
      medium: [],
      low: [],
      info: [],
    };

    for (const finding of findings) {
      groups[finding.severity].push(finding);
    }

    const severityOrder: VulnerabilitySeverity[] = [
      'critical',
      'high',
      'medium',
      'low',
      'info',
    ];

    return severityOrder
      .map((severity) => ({
        severity,
        count: groups[severity].length,
        items: groups[severity].slice(0, 5).map((f) => ({
          file: f.file,
          location: `${f.line}:${f.column}`,
          category: f.category,
          message: f.message,
          remediation: f.remediation,
        })),
      }))
      .filter((g) => g.count > 0);
  }

  /**
   * Group findings by category
   */
  private groupByCategory(findings: VulnerabilityFinding[]): Array<{
    category: VulnerabilityCategory;
    count: number;
    criticalCount: number;
    highCount: number;
    topFiles: string[];
  }> {
    const groups = new Map<VulnerabilityCategory, VulnerabilityFinding[]>();

    for (const finding of findings) {
      if (!groups.has(finding.category)) {
        groups.set(finding.category, []);
      }
      groups.get(finding.category)!.push(finding);
    }

    return Array.from(groups.entries())
      .map(([category, items]) => {
        const criticalCount = items.filter(
          (f) => f.severity === 'critical'
        ).length;
        const highCount = items.filter((f) => f.severity === 'high').length;

        // Get unique files, sorted by finding count
        const fileMap = new Map<string, number>();
        for (const item of items) {
          fileMap.set(item.file, (fileMap.get(item.file) || 0) + 1);
        }

        const topFiles = Array.from(fileMap.entries())
          .sort((a, b) => b[1] - a[1])
          .slice(0, 3)
          .map(([file]) => file);

        return {
          category,
          count: items.length,
          criticalCount,
          highCount,
          topFiles,
        };
      })
      .sort((a, b) => {
        // Sort by critical count, then high count, then total count
        if (a.criticalCount !== b.criticalCount) {
          return b.criticalCount - a.criticalCount;
        }
        if (a.highCount !== b.highCount) {
          return b.highCount - a.highCount;
        }
        return b.count - a.count;
      });
  }

  /**
   * Generate remediation priorities
   */
  private generateRemediationPriorities(
    findings: VulnerabilityFinding[]
  ): Array<{
    priority: number;
    category: VulnerabilityCategory;
    severity: VulnerabilitySeverity;
    count: number;
    impact: string;
    action: string;
  }> {
    const categoryGroups = new Map<
      VulnerabilityCategory,
      VulnerabilityFinding[]
    >();

    for (const finding of findings) {
      if (!categoryGroups.has(finding.category)) {
        categoryGroups.set(finding.category, []);
      }
      categoryGroups.get(finding.category)!.push(finding);
    }

    const priorities: Array<{
      priority: number;
      category: VulnerabilityCategory;
      severity: VulnerabilitySeverity;
      count: number;
      impact: string;
      action: string;
    }> = [];

    const categoryArray = Array.from(categoryGroups.entries());

    for (const [category, items] of categoryArray) {
      const criticalCount = items.filter(
        (f) => f.severity === 'critical'
      ).length;
      const highCount = items.filter((f) => f.severity === 'high').length;
      const highestSeverity =
        criticalCount > 0 ? 'critical' : highCount > 0 ? 'high' : 'medium';

      const priority = criticalCount * 10 + highCount * 5 + items.length;

      priorities.push({
        priority,
        category,
        severity: highestSeverity as VulnerabilitySeverity,
        count: items.length,
        impact: this.getCategoryImpact(category, items.length),
        action: this.getCategoryAction(category),
      });
    }

    return priorities.sort((a, b) => b.priority - a.priority).slice(0, 5);
  }

  /**
   * Get impact description for category
   */
  private getCategoryImpact(
    category: VulnerabilityCategory,
    /**
     * How many findings the category holds.
     *
     * THIS USED TO BE CRITICAL + HIGH, so a category whose findings were
     * all medium or low described itself as empty: the benched fixture
     * reported `0 cryptographic weaknesses` for a category the same reply
     * listed one medium finding in, two sections higher up.
     */
    total: number
  ): string {
    const impacts: Record<VulnerabilityCategory, string> = {
      injection: `${total} injection vulnerabilities - can lead to data breach or system compromise`,
      xss: `${total} XSS vulnerabilities - can expose user data and sessions`,
      secrets: `${total} hardcoded secrets - immediate credential rotation required`,
      crypto: `${total} cryptographic weaknesses - can compromise data confidentiality`,
      auth: `${total} authentication issues - can allow unauthorized access`,
      dos: `${total} DoS vulnerabilities - can affect service availability`,
      'path-traversal': `${total} path traversal issues - can expose sensitive files`,
      'unsafe-eval': `${total} code injection risks - can execute arbitrary code`,
      regex: `${total} ReDoS vulnerabilities - can cause service degradation`,
      dependency: `${total} vulnerable dependencies - update required`,
      config: `${total} misconfigurations - can weaken security posture`,
    };

    return impacts[category] || `${total} security issues found`;
  }

  /**
   * Get recommended action for category
   */
  private getCategoryAction(category: VulnerabilityCategory): string {
    const actions: Record<VulnerabilityCategory, string> = {
      injection: 'Implement parameterized queries and input validation',
      xss: 'Sanitize all user inputs and use safe DOM APIs',
      secrets: 'Move all secrets to environment variables or secret management',
      crypto: 'Upgrade to secure algorithms (SHA-256+, proper TLS config)',
      auth: 'Review authentication logic and implement proper validation',
      dos: 'Add rate limiting and input validation',
      'path-traversal': 'Validate and sanitize all file paths',
      'unsafe-eval': 'Remove eval() usage and unsafe code execution',
      regex: 'Simplify regex patterns or use validated libraries',
      dependency: 'Update dependencies to patched versions',
      config: 'Review and harden security configurations',
    };

    return actions[category] || 'Review and fix security issues';
  }

  /**
   * Filter findings by minimum severity
   */
  private filterBySeverity(
    findings: VulnerabilityFinding[],
    minSeverity: VulnerabilitySeverity
  ): VulnerabilityFinding[] {
    const severityRank: Record<VulnerabilitySeverity, number> = {
      critical: 4,
      high: 3,
      medium: 2,
      low: 1,
      info: 0,
    };

    const minRank = severityRank[minSeverity];
    return findings.filter((f) => severityRank[f.severity] >= minRank);
  }

  /**
   * Generate cache key based on file hashes
   */
  private async generateCacheKey(files: string[]): Promise<string> {
    const hash = createHash('sha256');
    hash.update(this.cacheNamespace);

    // Sort files for consistent cache key
    const sortedFiles = [...files].sort();

    // METADATA, NOT CONTENT. This hashed every file's CONTENT to decide whether
    // a cached scan could be reused -- which meant reading the entire project
    // before deciding whether to read the entire project. Measured 2026-08-28
    // on 12,000 files: 17.75 s of readFileUtf8 plus 2.03 s of existsSync, 62%
    // of a 32 s scan, spent on a question `stat` answers.
    //
    // Size-and-mtime is the same trade `smart_dependencies` already makes via
    // this helper. It re-scans when a file is touched without changing (cheap,
    // and correct), and it would reuse a cached scan if content changed while
    // size AND mtime were both preserved -- which takes deliberate effort to
    // arrange and is not something an editor does.
    for (const file of sortedFiles) {
      try {
        hash.update(hashFileMetadata(file));
      } catch {
        // Unreadable or vanished between discovery and here. Contributing the
        // path alone keeps the key stable and distinct rather than throwing.
        hash.update(file);
      }
    }

    return `${this.cacheNamespace}:${hash.digest('hex')}`;
  }

  /**
   * Generate hash for a single file
   */
  private generateFileHash(filePath: string, content?: string): string {
    // CONTENT WHEN THE CALLER ALREADY HAS IT. `scanFile` reads the file, scans
    // it, and then used to call this -- which read the very same file a second
    // time purely to hash what it was already holding. Combined with the cache
    // key's own pass that made three reads per file on a full scan.
    //
    // The `existsSync` guard is gone with it: it was a second syscall asking a
    // question the read answers by failing, and the caller already treats a
    // failure as "no result".
    if (content !== undefined) {
      return createHash('sha256').update(content).digest('hex');
    }
    try {
      return createHash('sha256')
        .update(readFileSync(filePath, 'utf-8'))
        .digest('hex');
    } catch {
      return '';
    }
  }

  /**
   * Get cached result if available and fresh
   */
  private getCachedResult(
    key: string,
    maxAge: number
  ): SmartSecurityOutput | null {
    const cached = this.cache.get(key);
    if (!cached) {
      return null;
    }

    try {
      const { cachedAt, ...result } = JSON.parse(
        cached
      ) as SmartSecurityOutput & {
        cachedAt: number;
      };
      const age = (Date.now() - cachedAt) / 1000;

      if (age <= maxAge) {
        result.summary.fromCache = true;
        return result;
      }
    } catch (err) {
      return null;
    }

    return null;
  }

  /**
   * Cache scan result
   */
  private cacheResult(key: string, output: SmartSecurityOutput): void {
    const toCache = {
      ...output,
      cachedAt: Date.now(),
    };

    const json = JSON.stringify(toCache);
    const originalSize = Buffer.byteLength(json, 'utf-8');
    const compressedSize = Math.ceil(originalSize * 0.3);

    this.cache.set(key, json, originalSize, compressedSize);
  }

  /**
   * Close cache and cleanup
   */
  close(): void {
    this.cache.close();
  }
}

/**
 * Factory function to create SmartSecurity with dependency injection
 */
export function getSmartSecurityTool(
  cache: CacheEngine,
  tokenCounter: TokenCounter,
  metrics: MetricsCollector,
  projectRoot?: string
): SmartSecurity {
  return new SmartSecurity(cache, tokenCounter, metrics, projectRoot);
}

/**
 * CLI-friendly function for running smart security scan
 */
export async function runSmartSecurity(
  options: SmartSecurityOptions = {}
): Promise<string> {
  const cache = new CacheEngine(
    resolveCacheLocation(join(homedir(), '.hypercontext', 'cache')),
    100
  );
  const tokenCounter = new TokenCounter();
  const metrics = new MetricsCollector();
  const smartSec = new SmartSecurity(
    cache,
    tokenCounter,
    metrics,
    options.projectRoot
  );
  try {
    const result = await smartSec.run(options);

    let output = `\n🔒 Smart Security Scan ${result.summary.fromCache ? '(cached)' : ''}\n`;
    // NO RULE. Sixty equals signs restated the heading above them.
    output += '\n';

    // Summary
    output += `Summary:\n`;
    if (result.summary.scannedNothing) {
      // The refusal replaces the whole summary rather than annotating it: a
      // reader who sees `Files Scanned: 0` under a green status reads the status.
      output += `  Status: ✗ SCANNED NOTHING -- this is not a pass\n`;
      for (const item of result.summary.unresolvedTargets ?? []) {
        output += `    ${item.target} -> ${item.resolvedTo}\n`;
        output += `      ${TARGET_FAILURES[item.reason]}\n`;
      }
      output += `  ${result.summary.refusal ?? ''}\n`;
      return output;
    }
    output += `  Status: ${result.summary.success ? '✓ Secure (no critical/high issues)' : '✗ Vulnerabilities Found'}\n`;
    output += `  Files Scanned: ${result.summary.filesScanned}\n`;
    output += `  Total Findings: ${result.summary.totalFindings}\n`;
    output += `    Critical: ${result.summary.criticalCount}\n`;
    output += `    High: ${result.summary.highCount}\n`;
    output += `    Medium: ${result.summary.mediumCount}\n`;
    output += `    Low: ${result.summary.lowCount}\n`;
    if (result.summary.incrementalMode) {
      output += `  Mode: Incremental (changed files only)\n`;
    }
    output += '\n';

    // Findings by severity
    if (result.findingsBySeverity.length > 0) {
      output += `Findings by Severity:\n`;

      /*
       * THE PATH ONCE, NOT ONCE PER FINDING.
       *
       * Every finding line used to open with `${item.file}:`, so a scan of one
       * file printed that file's path as many times as it found something --
       * ten repetitions of `bench/tools/fixtures/` on the benched fixture, 60
       * tokens of a path the caller passed in as an argument. Measured on that
       * fixture the findings section came to 322 tokens; naming the file once
       * and leading each finding with its line and column costs 258.
       */
      const allFiles = new Set<string>();
      for (const group of result.findingsBySeverity) {
        for (const item of group.items) allFiles.add(item.file);
      }
      const singleFile = allFiles.size === 1 ? [...allFiles][0] : null;
      if (singleFile !== null) output += `  in ${singleFile}\n`;

      for (const group of result.findingsBySeverity) {
        const icon =
          group.severity === 'critical'
            ? '🔴'
            : group.severity === 'high'
              ? '🟠'
              : group.severity === 'medium'
                ? '🟡'
                : '🔵';

        output += `\n  ${icon} ${group.severity.toUpperCase()} (${group.count})\n`;

        if (singleFile !== null) {
          for (const item of group.items) {
            output += `    ${item.location} [${item.category}] ${item.message}\n`;
            output += `      Fix: ${item.remediation}\n`;
          }
        } else {
          // More than one file, so the path is doing work: print it once per
          // file within the group rather than once per finding.
          const byFile = new Map<string, typeof group.items>();
          for (const item of group.items) {
            const bucket = byFile.get(item.file);
            if (bucket) bucket.push(item);
            else byFile.set(item.file, [item]);
          }
          for (const [file, items] of byFile) {
            output += `    ${file}\n`;
            for (const item of items) {
              output += `      ${item.location} [${item.category}] ${item.message}\n`;
              output += `        Fix: ${item.remediation}\n`;
            }
          }
        }

        if (group.count > group.items.length) {
          output += `    ... and ${group.count - group.items.length} more\n`;
        }
      }
      output += '\n';
    }

    /*
     * Findings by category, WHEN IT NAMES SOMETHING THE FINDINGS DO NOT.
     *
     * The counts in this section are counts over the section above it: every
     * finding there carries its `[category]` tag under a severity heading, so
     * `injection (2 total, 2 critical, 0 high)` is arithmetic the reader can do
     * on lines they have already been charged for. The one part that is not
     * derivable is `topFiles` -- which file a category concentrates in -- and
     * that says nothing when the scan covered one file, which is when it was
     * reduced to printing the caller's own argument back four times.
     *
     * So it is emitted on a multi-file scan and suppressed on a single-file
     * one. Measured on the benched fixture, where one file was scanned: 140
     * tokens, all of them restatement.
     */
    if (
      result.findingsByCategory.length > 0 &&
      result.summary.filesScanned > 1
    ) {
      output += `Findings by Category:\n`;
      for (const cat of result.findingsByCategory.slice(0, 5)) {
        output += `\n  ${cat.category} (${cat.count} total, ${cat.criticalCount} critical, ${cat.highCount} high)\n`;
        output += `    in ${cat.topFiles.join(', ')}\n`;
      }
      output += '\n';
    }

    /*
     * Remediation priorities, as a ranking rather than as prose.
     *
     * The ranking is the part that is worth sending: it is computed from the
     * severity mix (critical x10 + high x5 + count) and tells the reader what
     * to take first, which the severity listing above does not. The two prose
     * lines under each entry were canned strings keyed on the category alone --
     * the same words for every injection finding in every file -- and the
     * per-finding `Fix:` lines above already carry remediation at the grain
     * that can actually be acted on.
     *
     * `impact` is still computed and still returned in the structured result
     * for programmatic consumers; it is no longer re-printed here. Measured on
     * the benched fixture: 163 tokens for four categories, 82 this way.
     */
    if (result.remediationPriorities.length > 0) {
      output += `Remediation Priorities:\n`;
      for (const priority of result.remediationPriorities) {
        output += `  [${priority.priority}] ${priority.category} x${priority.count} -- ${priority.action}\n`;
      }
      output += '\n';
    }

    // NO TOKEN REDUCTION FOOTER. Four lines stating a percentage that was a
    // property of two internal objects, charged to the caller as digits.
    return output;
  } finally {
    smartSec.close();
  }
}

// MCP Tool definition
export const SMART_SECURITY_TOOL_DEFINITION = {
  name: 'smart_security',
  description:
    'Security vulnerability scanner with pattern detection and intelligent caching. Measured token reduction vs reading the file: 23-99% first read, 22-99% repeated (bench/tools, 4 fixtures) -- the three clean fixtures cost a flat 84 tokens each, because a scan that finds nothing says so in the same words whatever it was pointed at; the fourth is the floor, where six findings and a remediation for each are reported against a 597-token file.',
  inputSchema: {
    type: 'object',
    properties: {
      force: {
        type: 'boolean',
        description: 'Force full scan (ignore cache)',
        default: false,
      },
      projectRoot: {
        type: 'string',
        description: 'Project root directory',
      },
      targets: {
        type: 'array',
        description:
          'Specific files or directories to scan, absolute or relative to projectRoot (enables incremental mode)',
        items: {
          type: 'string',
        },
      },
      filePath: {
        type: 'string',
        minLength: 1,
        maxLength: 4096,
        pattern: '^(?!-)[^\\u0000\\n\\r]+$',
        description:
          'A single file to scan. Alias for targets: [filePath]. A target that resolves to no file is refused by name rather than reported as a clean scan.',
      },
      deadlineMs: {
        type: 'number',
        description:
          'Wall-clock budget in ms for discovering the files to scan (default 10000). On expiry the scan reports what it reached with summary.searchTruncated set, instead of walking until the calling tool times out.',
      },
      exclude: {
        type: 'array',
        description: 'Patterns to exclude from scan',
        items: {
          type: 'string',
        },
        default: ['node_modules', '.git', 'dist', 'build', 'coverage'],
      },
      minSeverity: {
        type: 'string',
        description: 'Minimum severity level to report',
        enum: ['critical', 'high', 'medium', 'low', 'info'],
        default: 'low',
      },
      maxCacheAge: {
        type: 'number',
        description: 'Maximum cache age in seconds (default: 86400 = 24 hours)',
        default: 86400,
      },
      includeLowSeverity: {
        type: 'boolean',
        description: 'Include low-severity findings',
        default: true,
      },
    },
  },
};
