/** * Smart Ambiance Tool - 83% Token Reduction for Code Context Analysis * * Advanced code understanding with context caching (inspired by Ambiance MCP): * - Caches AST analysis, symbol tables, and dependency graphs * - Smart chunking with semantic overlap for large files * - Semantic similarity detection for related code discovery * - TTL-based + file hash invalidation (<5s on changes) * - Provides jump targets and related code suggestions * - Hierarchical context: file → module → project level */ import {
  readFileSync,
  existsSync,
  statSync,
  readdirSync,
} from "fs";
import { join, relative, extname, dirname, basename } from "path";
import { hashFile, hashContent, generateCacheKey } from "../shared/hash-utils";
import { compress, decompress } from "../shared/compression-utils";
import { detectFileType, chunkBySyntax } from "../shared/syntax-utils";
import * as ts from "typescript";
