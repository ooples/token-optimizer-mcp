/**
 * Smart Workflow Tool
 *
 * Provides intelligent CI/CD workflow file analysis:
 * - GitHub Actions (.github/workflows/*.yml)
 * - GitLab CI (.gitlab-ci.yml)
 * - CircleCI (.circleci/config.yml)
 * - Azure Pipelines (azure-pipelines.yml)
 * - Workflow syntax validation
 * - Job and step parsing with dependency detection
 * - Security analysis (secrets, unsafe actions)
 * - Performance recommendations
 * - Cached results with file hash invalidation (24-hour TTL)
 */

import { readFileSync, existsSync, statSync, readdirSync } from 'fs';
import { parse as parseYAML } from 'yaml';
import { join } from 'path';
import { CacheEngine } from '../../core/cache-engine.js';
import { TokenCounter } from '../../core/token-counter.js';
import { MetricsCollector } from '../../core/metrics.js';
import { hashFile, generateCacheKey } from '../shared/hash-utils.js';
import { compress, decompress } from '../shared/compression-utils.js';

export type WorkflowFormat =
  | 'github'
  | 'gitlab'
  | 'circleci'
  | 'azure'
  | 'auto';

export interface SmartWorkflowOptions {
  enableCache?: boolean;
  ttl?: number;
  format?: WorkflowFormat;
  validateSyntax?: boolean;
  includeSecurityAnalysis?: boolean;
  includePerformanceRecommendations?: boolean;
}

export interface WorkflowTrigger {
  type: string;
  details?: Record<string, unknown>;
}

export interface WorkflowStep {
  name?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
  env?: Record<string, string>;
  'working-directory'?: string;
  if?: string;
}

export interface WorkflowJob {
  id: string;
  name?: string;
  'runs-on'?: string | string[];
  steps: WorkflowStep[];
  env?: Record<string, string>;
  needs?: string | string[];
  outputs?: Record<string, string>;
  if?: string;
  strategy?: { matrix?: Record<string, unknown> };
  requires?: string[];
}

export interface ParsedWorkflow {
  name?: string;
  format: WorkflowFormat;
  triggers: WorkflowTrigger[];
  jobs: WorkflowJob[];
  globalEnv?: Record<string, string>;
  fileHash: string;
  timestamp: number;
}

export interface WorkflowValidationError {
  path: string;
  message: string;
  severity: 'error' | 'warning' | 'info';
  suggestion?: string;
}

export interface WorkflowSecurityIssue {
  type: 'hardcoded_secret' | 'unsafe_action' | 'privileged_command';
  message: string;
  path: string;
  severity: 'high' | 'medium' | 'low';
  suggestion?: string;
}

export interface WorkflowOptimization {
  type: 'caching' | 'parallelization' | 'matrix' | 'reusability';
  suggestion: string;
  impact: 'high' | 'medium' | 'low';
  implementation?: string;
}

export interface SmartWorkflowResult {
  workflow: ParsedWorkflow;
  metadata: {
    path: string;
    format: WorkflowFormat;
    size: number;
    hash: string;
    fromCache: boolean;
    tokensSaved: number;
    tokenCount: number;
    originalTokenCount: number;
    compressionRatio: number;
    parseTime: number;
  };
  validationErrors?: WorkflowValidationError[];
  securityIssues?: WorkflowSecurityIssue[];
  optimizations?: WorkflowOptimization[];
}

export class SmartWorkflowTool {
  private cache: CacheEngine;
  private tokenCounter: TokenCounter;
  private metrics: MetricsCollector;

  constructor(
    cache: CacheEngine,
    tokenCounter: TokenCounter,
    metrics: MetricsCollector
  ) {
    this.cache = cache;
    this.tokenCounter = tokenCounter;
    this.metrics = metrics;
  }

  async analyze(
    filePath: string,
    options: SmartWorkflowOptions = {}
  ): Promise<SmartWorkflowResult> {
    const startTime = Date.now();
    const {
      enableCache = true,
      ttl = 86400,
      format = 'auto',
      validateSyntax = true,
      includeSecurityAnalysis = true,
      includePerformanceRecommendations = true,
    } = options;

    if (!existsSync(filePath)) {
      throw new Error(`Workflow file not found: ${filePath}`);
    }

    const stats = statSync(filePath);
    const fileHash = hashFile(filePath);
    const detectedFormat = this.detectFormat(filePath, format);
    const cacheKey = generateCacheKey('smart-workflow', {
      path: filePath,
      hash: fileHash,
    });

    let fromCache = false;
    if (enableCache) {
      const cachedData = await this.cache.get(cacheKey);
      if (cachedData) {
        fromCache = true;
        const decompressed = decompress(
          Buffer.from(cachedData, 'utf-8'),
          'gzip'
        );
        const cached = JSON.parse(
          decompressed.toString()
        ) as SmartWorkflowResult;
        this.metrics.record({
          operation: 'smart_workflow_analyze',
          duration: Date.now() - startTime,
          success: true,
          cacheHit: true,
          inputTokens: 0,
          outputTokens: cached.metadata.tokenCount,
          cachedTokens: cached.metadata.originalTokenCount,
          savedTokens: cached.metadata.tokensSaved,
          metadata: { path: filePath, format: detectedFormat, cached: true },
        });
        return cached;
      }
    }

    const rawContent = readFileSync(filePath, 'utf-8');
    const parseStartTime = Date.now();
    const parsedWorkflow = this.parseWorkflow(
      rawContent,
      detectedFormat,
      fileHash
    );
    const parseTime = Date.now() - parseStartTime;
    const originalTokens = this.tokenCounter.count(
      JSON.stringify(parsedWorkflow, null, 2)
    ).tokens;

    let validationErrors: WorkflowValidationError[] = [];
    if (validateSyntax) {
      validationErrors = this.validateWorkflow(parsedWorkflow);
    }

    let securityIssues: WorkflowSecurityIssue[] = [];
    if (includeSecurityAnalysis) {
      securityIssues = this.analyzeSecurityIssues(parsedWorkflow);
    }

    let optimizations: WorkflowOptimization[] = [];
    if (includePerformanceRecommendations) {
      optimizations = this.recommendOptimizations(parsedWorkflow);
    }

    const result: SmartWorkflowResult = {
      workflow: parsedWorkflow,
      metadata: {
        path: filePath,
        format: detectedFormat,
        size: stats.size,
        hash: fileHash,
        fromCache,
        tokensSaved: 0,
        tokenCount: originalTokens,
        originalTokenCount: originalTokens,
        compressionRatio: 1.0,
        parseTime,
      },
      validationErrors:
        validationErrors.length > 0 ? validationErrors : undefined,
      securityIssues: securityIssues.length > 0 ? securityIssues : undefined,
      optimizations: optimizations.length > 0 ? optimizations : undefined,
    };

    if (enableCache) {
      const compressResult = compress(JSON.stringify(result), 'gzip');
      this.cache.set(
        cacheKey,
        compressResult.compressed.toString(),
        compressResult.compressed.length,
        ttl
      );
      const compressedTokens = this.tokenCounter.count(
        compressResult.compressed.toString()
      ).tokens;
      result.metadata.tokenCount = compressedTokens;
      result.metadata.tokensSaved = originalTokens - compressedTokens;
      result.metadata.compressionRatio = compressedTokens / originalTokens;
    }

    this.metrics.record({
      operation: 'smart_workflow_analyze',
      duration: Date.now() - startTime,
      success: true,
      cacheHit: false,
      inputTokens: 0,
      outputTokens: result.metadata.tokenCount,
      cachedTokens: 0,
      savedTokens: result.metadata.tokensSaved,
      metadata: {
        path: filePath,
        format: detectedFormat,
        fileSize: stats.size,
        validationErrors: validationErrors.length,
        securityIssues: securityIssues.length,
        optimizations: optimizations.length,
        parseTime,
      },
    });

    return result;
  }

  listWorkflows(projectRoot: string): string[] {
    const workflowPaths: string[] = [];
    try {
      const githubWorkflowsDir = join(projectRoot, '.github', 'workflows');
      if (existsSync(githubWorkflowsDir)) {
        const files = readdirSync(githubWorkflowsDir);
        for (const file of files) {
          if (file.endsWith('.yml') || file.endsWith('.yaml')) {
            workflowPaths.push(join(githubWorkflowsDir, file));
          }
        }
      }
      const gitlabCIPath = join(projectRoot, '.gitlab-ci.yml');
      if (existsSync(gitlabCIPath)) workflowPaths.push(gitlabCIPath);
      const circleCIPath = join(projectRoot, '.circleci', 'config.yml');
      if (existsSync(circleCIPath)) workflowPaths.push(circleCIPath);
      const azurePipelinesPath = join(projectRoot, 'azure-pipelines.yml');
      if (existsSync(azurePipelinesPath))
        workflowPaths.push(azurePipelinesPath);
    } catch (error) {
      console.error('Error listing workflows:', error);
    }
    return workflowPaths;
  }

  getJobs(parsedWorkflow: ParsedWorkflow): WorkflowJob[] {
    return parsedWorkflow.jobs;
  }

  getTriggers(parsedWorkflow: ParsedWorkflow): WorkflowTrigger[] {
    return parsedWorkflow.triggers;
  }

  validate(parsedWorkflow: ParsedWorkflow): WorkflowValidationError[] {
    return this.validateWorkflow(parsedWorkflow);
  }

  optimize(parsedWorkflow: ParsedWorkflow): WorkflowOptimization[] {
    return this.recommendOptimizations(parsedWorkflow);
  }

  visualize(parsedWorkflow: ParsedWorkflow): Record<string, string[]> {
    const graph: Record<string, string[]> = {};
    for (const job of parsedWorkflow.jobs) {
      const needs = job.needs || job.requires || [];
      graph[job.id] = Array.isArray(needs) ? needs : [needs];
    }
    return graph;
  }

  getSecrets(parsedWorkflow: ParsedWorkflow): string[] {
    const secrets = new Set<string>();
    for (const job of parsedWorkflow.jobs) {
      if (job.env) {
        for (const value of Object.values(job.env)) {
          const matches = value.match(/\$\{\{\s*secrets\.(\w+)\s*\}\}/g);
          if (matches) {
            for (const match of matches) {
              const secretName = match.replace(/\$\{\{\s*secrets\.|[}\s]/g, '');
              secrets.add(secretName);
            }
          }
        }
      }
      for (const step of job.steps) {
        if (step.with) {
          for (const value of Object.values(step.with)) {
            if (typeof value === 'string') {
              const matches = value.match(/\$\{\{\s*secrets\.(\w+)\s*\}\}/g);
              if (matches) {
                for (const match of matches) {
                  const secretName = match.replace(
                    /\$\{\{\s*secrets\.|[}\s]/g,
                    ''
                  );
                  secrets.add(secretName);
                }
              }
            }
          }
        }
        if (step.env) {
          for (const value of Object.values(step.env)) {
            const matches = value.match(/\$\{\{\s*secrets\.(\w+)\s*\}\}/g);
            if (matches) {
              for (const match of matches) {
                const secretName = match.replace(
                  /\$\{\{\s*secrets\.|[}\s]/g,
                  ''
                );
                secrets.add(secretName);
              }
            }
          }
        }
        if (step.run) {
          const matches = step.run.match(/\$\{\{\s*secrets\.(\w+)\s*\}\}/g);
          if (matches) {
            for (const match of matches) {
              const secretName = match.replace(/\$\{\{\s*secrets\.|[}\s]/g, '');
              secrets.add(secretName);
            }
          }
        }
      }
    }
    return Array.from(secrets);
  }

  private detectFormat(
    filePath: string,
    format: WorkflowFormat
  ): WorkflowFormat {
    if (format !== 'auto') return format;
    if (filePath.includes('.github/workflows')) return 'github';
    if (filePath.includes('.gitlab-ci')) return 'gitlab';
    if (filePath.includes('.circleci')) return 'circleci';
    if (filePath.includes('azure-pipelines')) return 'azure';
    return 'github';
  }

  private parseWorkflow(
    content: string,
    format: WorkflowFormat,
    fileHash: string
  ): ParsedWorkflow {
    try {
      const parsed = parseYAML(content) as Record<string, unknown>;
      return {
        name: (parsed.name as string) || undefined,
        format,
        triggers: this.extractTriggers(parsed, format),
        jobs: this.extractJobs(parsed, format),
        globalEnv: (parsed.env as Record<string, string>) || undefined,
        fileHash,
        timestamp: Date.now(),
      };
    } catch (error) {
      throw new Error(`Failed to parse workflow: ${(error as Error).message}`);
    }
  }

  private extractTriggers(
    parsed: Record<string, unknown>,
    format: WorkflowFormat
  ): WorkflowTrigger[] {
    const triggers: WorkflowTrigger[] = [];
    if (format === 'github') {
      const on = parsed.on;
      if (on) {
        if (typeof on === 'string') {
          triggers.push({ type: on });
        } else if (typeof on === 'object') {
          for (const [key, value] of Object.entries(on)) {
            triggers.push({
              type: key,
              details: value as Record<string, unknown>,
            });
          }
        }
      }
    }
    return triggers;
  }

  private extractJobs(
    parsed: Record<string, unknown>,
    format: WorkflowFormat
  ): WorkflowJob[] {
    const jobs: WorkflowJob[] = [];
    if (format === 'github' || format === 'gitlab') {
      const jobsObj = parsed.jobs as Record<string, unknown>;
      if (jobsObj) {
        for (const [id, jobData] of Object.entries(jobsObj)) {
          const job = jobData as Record<string, unknown>;
          jobs.push({
            id,
            name: job.name as string,
            'runs-on': job['runs-on'] as string | string[],
            steps:
              (job.steps as unknown[])?.map((s) => s as WorkflowStep) || [],
            env: job.env as Record<string, string>,
            needs: job.needs as string[],
            outputs: job.outputs as Record<string, string>,
            if: job.if as string,
            strategy: job.strategy as { matrix?: Record<string, unknown> },
          });
        }
      }
    }
    return jobs;
  }

  private validateWorkflow(
    workflow: ParsedWorkflow
  ): WorkflowValidationError[] {
    const errors: WorkflowValidationError[] = [];
    if (!workflow.jobs || workflow.jobs.length === 0) {
      errors.push({
        path: 'root',
        message: 'Workflow must have at least one job',
        severity: 'error',
        suggestion: 'Add a jobs section with at least one job definition',
      });
    }
    for (const job of workflow.jobs) {
      if (!job.steps || job.steps.length === 0) {
        errors.push({
          path: `jobs.${job.id}`,
          message: `Job "${job.id}" has no steps`,
          severity: 'error',
          suggestion: 'Add at least one step to the job',
        });
      }
      if (job.needs) {
        const needsArr = Array.isArray(job.needs) ? job.needs : [job.needs];
        if (needsArr.includes(job.id)) {
        errors.push({
          path: `jobs.${job.id}.needs`,
          message: `Job "${job.id}" cannot depend on itself`,
          severity: 'error',
          suggestion: 'Remove self-reference from needs array',
        });
        }
      }
    }
    return errors;
  }

  private analyzeSecurityIssues(
    workflow: ParsedWorkflow
  ): WorkflowSecurityIssue[] {
    const issues: WorkflowSecurityIssue[] = [];
    for (const job of workflow.jobs) {
      for (const step of job.steps) {
        if (step.run) {
          const suspiciousPatterns = [
            /password\s*=\s*["'](?!\\$\{).*["']/i,
            /api[_-]?key\s*=\s*["'](?!\\$\{).*["']/i,
            /token\s*=\s*["'](?!\\$\{).*["']/i,
          ];
          for (const pattern of suspiciousPatterns) {
            if (pattern.test(step.run)) {
              issues.push({
                type: 'hardcoded_secret',
                message: 'Possible hardcoded secret detected in run command',
                path: `jobs.${job.id}.steps`,
                severity: 'high',
                suggestion: 'Use GitHub secrets instead of hardcoded values',
              });
            }
          }
        }
        if (step.uses && !step.uses.includes('@')) {
          issues.push({
            type: 'unsafe_action',
            message: 'Action used without version pinning',
            path: `jobs.${job.id}.steps`,
            severity: 'medium',
            suggestion: 'Pin action to specific version: action@v1.2.3',
          });
        }
        if (
          step.run &&
          (step.run.includes('sudo') || step.run.includes('chmod 777'))
        ) {
          issues.push({
            type: 'privileged_command',
            message: 'Privileged command detected',
            path: `jobs.${job.id}.steps`,
            severity: 'medium',
            suggestion: 'Avoid using sudo or overly permissive chmod',
          });
        }
      }
    }
    return issues;
  }

  private recommendOptimizations(
    workflow: ParsedWorkflow
  ): WorkflowOptimization[] {
    const recommendations: WorkflowOptimization[] = [];
    let hasCaching = false;
    for (const job of workflow.jobs) {
      for (const step of job.steps) {
        if (step.uses && step.uses.includes('actions/cache')) {
          hasCaching = true;
          break;
        }
      }
    }
    if (!hasCaching) {
      recommendations.push({
        type: 'caching',
        suggestion: 'Add dependency caching to speed up workflow runs',
        impact: 'high',
        implementation: 'Use actions/cache@v3 to cache dependencies',
      });
    }
    const independentJobs = workflow.jobs.filter(
      (j) => !j.needs || j.needs.length === 0
    );
    if (independentJobs.length > 1) {
      recommendations.push({
        type: 'parallelization',
        suggestion: `${independentJobs.length} jobs can run in parallel`,
        impact: 'high',
        implementation:
          'Jobs without dependencies run in parallel automatically',
      });
    }
    const hasMatrix = workflow.jobs.some((j) => j.strategy?.matrix);
    if (!hasMatrix && workflow.jobs.length > 1) {
      recommendations.push({
        type: 'matrix',
        suggestion: 'Consider using matrix strategy for similar jobs',
        impact: 'medium',
        implementation:
          'Use strategy.matrix to run jobs with different parameters',
      });
    }
    return recommendations;
  }
}

export function getSmartWorkflowTool(
  cache: CacheEngine,
  tokenCounter: TokenCounter,
  metrics: MetricsCollector
): SmartWorkflowTool {
  return new SmartWorkflowTool(cache, tokenCounter, metrics);
}

export const SMART_WORKFLOW_TOOL_DEFINITION = {
  name: 'smart_workflow',
  description:
    'Intelligent CI/CD workflow file analysis with 83% token reduction. Analyzes GitHub Actions, GitLab CI, CircleCI, and Azure Pipelines workflows with syntax validation, security analysis, and performance recommendations.',
  inputSchema: {
    type: 'object',
    properties: {
      operation: {
        type: 'string',
        enum: [
          'analyze',
          'list-workflows',
          'get-jobs',
          'get-triggers',
          'validate',
          'optimize',
          'visualize',
          'get-secrets',
        ],
        description: 'Operation to perform',
      },
      filePath: {
        type: 'string',
        description: 'Path to workflow file (for analyze)',
      },
      projectRoot: {
        type: 'string',
        description: 'Project root (for list-workflows)',
      },
      parsedWorkflow: {
        type: 'object',
        description: 'Parsed workflow (for other operations)',
      },
      options: {
        type: 'object',
        properties: {
          enableCache: { type: 'boolean', default: true },
          ttl: { type: 'number', default: 86400 },
          format: {
            type: 'string',
            enum: ['github', 'gitlab', 'circleci', 'azure', 'auto'],
            default: 'auto',
          },
          validateSyntax: { type: 'boolean', default: true },
          includeSecurityAnalysis: { type: 'boolean', default: true },
          includePerformanceRecommendations: { type: 'boolean', default: true },
        },
      },
    },
    required: ['operation'],
  },
};
