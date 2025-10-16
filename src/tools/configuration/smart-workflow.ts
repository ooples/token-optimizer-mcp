/** * Smart Workflow Tool - 83% Token Reduction for GitHub Actions Workflow Analysis * * Features: * - Parse and validate GitHub Actions workflow files (.github/workflows/*.yml) * - Detect syntax errors, security issues, and misconfigurations * - Provide optimization suggestions (caching, parallelization, etc.) * - Cache parsed workflows with 7-day TTL * - File hash-based invalidation on workflow changes * - Re-parse only changed files on subsequent reads */ import {
  readFileSync,
  existsSync,
  readdirSync,
  statSync,
} from "fs";
import { join, relative, basename } from "path";
import { parse as parseYAML } from "yaml";
import { hashFile, generateCacheKey } from "../shared/hash-utils";
