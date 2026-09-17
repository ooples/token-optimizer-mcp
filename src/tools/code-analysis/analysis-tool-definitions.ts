// Schemas load without the TypeScript compiler; implementation modules re-export them.
export const SMART_COMPLEXITY_TOOL_DEFINITION = {
  name: 'smart_complexity',
  description:
    'Analyze code complexity metrics including cyclomatic, cognitive, Halstead, and maintainability index (70-80% token reduction)',
  inputSchema: {
    type: 'object',
    properties: {
      filePath: {
        type: 'string',
        description: 'File path to analyze (relative to project root)',
      },
      fileContent: {
        type: 'string',
        description: 'File content to analyze (alternative to filePath)',
      },
      projectRoot: {
        type: 'string',
        description: 'Project root directory',
      },
      includeHalstead: {
        type: 'boolean',
        description: 'Include Halstead complexity metrics',
        default: true,
      },
      includeMaintainability: {
        type: 'boolean',
        description: 'Include maintainability index calculation',
        default: true,
      },
      threshold: {
        type: 'object',
        description: 'Complexity thresholds for warnings',
        properties: {
          cyclomatic: { type: 'number', default: 10 },
          cognitive: { type: 'number', default: 15 },
        },
      },
      force: {
        type: 'boolean',
        description: 'Force re-analysis (ignore cache)',
        default: false,
      },
      maxCacheAge: {
        type: 'number',
        description: 'Maximum cache age in seconds (default: 300)',
        default: 300,
      },
    },
  },
};

export const SMART_EXPORTS_TOOL_DEFINITION = {
  name: 'smart_exports',
  description:
    'Analyze TypeScript/JavaScript export statements with intelligent caching. Tracks exports, detects unused exports, and provides optimization suggestions. Achieves 75-85% token reduction through export analysis summarization.',
  inputSchema: {
    type: 'object',
    properties: {
      filePath: {
        type: 'string',
        description: 'Path to the TypeScript/JavaScript file to analyze',
      },
      fileContent: {
        type: 'string',
        description: 'File content (alternative to filePath)',
      },
      projectRoot: {
        type: 'string',
        description:
          'Project root directory (default: current working directory)',
      },
      force: {
        type: 'boolean',
        description:
          'Force analysis even if cached result exists (default: false)',
        default: false,
      },
      maxCacheAge: {
        type: 'number',
        description: 'Maximum cache age in seconds (default: 300)',
        default: 300,
      },
      checkUsage: {
        type: 'boolean',
        description:
          'Check if exports are used across project (default: false)',
        default: false,
      },
      scanDepth: {
        type: 'number',
        description: 'Directory depth to scan when checking usage (default: 3)',
        default: 3,
      },
      deadlineMs: {
        type: 'number',
        description:
          'Wall-clock budget in ms for the usage scan (default 10000). On expiry the result comes back with summary.searchTruncated set and is NOT cached, instead of walking until the calling tool times out.',
      },
    },
  },
};

export const SMART_IMPORTS_TOOL_DEFINITION = {
  name: 'smart_imports',
  description:
    'Analyze TypeScript/JavaScript import statements with intelligent caching. Detects unused imports, missing imports, and provides optimization suggestions. Achieves 75-85% token reduction through import analysis summarization.',
  inputSchema: {
    type: 'object',
    properties: {
      filePath: {
        type: 'string',
        description: 'Path to the TypeScript/JavaScript file to analyze',
      },
      fileContent: {
        type: 'string',
        description: 'File content (alternative to filePath)',
      },
      projectRoot: {
        type: 'string',
        description:
          'Project root directory (default: current working directory)',
      },
      force: {
        type: 'boolean',
        description:
          'Force analysis even if cached result exists (default: false)',
        default: false,
      },
      maxCacheAge: {
        type: 'number',
        description: 'Maximum cache age in seconds (default: 300)',
        default: 300,
      },
      checkCircular: {
        type: 'boolean',
        description: 'Check for circular dependencies (default: true)',
        default: true,
      },
      suggestMissing: {
        type: 'boolean',
        description: 'Suggest missing imports (default: true)',
        default: true,
      },
    },
  },
};

export const SMART_REFACTOR_TOOL_DEFINITION = {
  name: 'smart_refactor',
  description:
    'Provides intelligent refactoring suggestions with code examples and impact analysis (75-85% token reduction)',
  inputSchema: {
    type: 'object',
    properties: {
      filePath: {
        type: 'string',
        description: 'File path to analyze (relative to project root)',
      },
      fileContent: {
        type: 'string',
        description: 'File content to analyze (alternative to filePath)',
      },
      projectRoot: {
        type: 'string',
        description: 'Project root directory',
      },
      refactorTypes: {
        type: 'array',
        description:
          'Types of refactoring suggestions to generate (default: all)',
        items: {
          type: 'string',
          enum: [
            'extract-method',
            'simplify-conditional',
            'remove-duplication',
            'improve-naming',
            'reduce-complexity',
            'extract-constant',
          ],
        },
      },
      minComplexityForExtraction: {
        type: 'number',
        description:
          'Minimum cyclomatic complexity to suggest extraction (default: 10)',
        default: 10,
      },
      force: {
        type: 'boolean',
        description: 'Force re-analysis (ignore cache)',
        default: false,
      },
      maxCacheAge: {
        type: 'number',
        description: 'Maximum cache age in seconds (default: 300)',
        default: 300,
      },
    },
  },
};

export const SMART_SYMBOLS_TOOL_DEFINITION = {
  name: 'smart_symbols',
  description:
    'Extract and analyze TypeScript/JavaScript symbols with scope, type, and reference information (75-85% token reduction)',
  inputSchema: {
    type: 'object',
    properties: {
      filePath: {
        type: 'string',
        description: 'File path to analyze (relative to project root)',
      },
      symbolTypes: {
        type: 'array',
        description: 'Types of symbols to extract (default: all)',
        items: {
          type: 'string',
          enum: ['variable', 'function', 'class', 'interface', 'type', 'enum'],
        },
      },
      includeExported: {
        type: 'boolean',
        description: 'Include only exported symbols',
        default: false,
      },
      includeImported: {
        type: 'boolean',
        description: 'Include import information',
        default: false,
      },
      projectRoot: {
        type: 'string',
        description: 'Project root directory',
      },
      force: {
        type: 'boolean',
        description: 'Force re-extraction (ignore cache)',
        default: false,
      },
      maxCacheAge: {
        type: 'number',
        description: 'Maximum cache age in seconds (default: 300)',
        default: 300,
      },
    },
    required: ['filePath'],
  },
};

export const SMART_TYPESCRIPT_TOOL_DEFINITION = {
  name: 'smart_typescript',
  description:
    'Incremental TypeScript compilation with dependency tracking and intelligent caching (83% token reduction)',
  inputSchema: {
    type: 'object',
    properties: {
      force: {
        type: 'boolean',
        description: 'Force full compilation (ignore cache)',
        default: false,
      },
      projectRoot: {
        type: 'string',
        description: 'Project root directory',
      },
      tsconfig: {
        type: 'string',
        description: 'TypeScript config file path',
        default: 'tsconfig.json',
      },
      maxCacheAge: {
        type: 'number',
        description: 'Maximum cache age in seconds (default: 300)',
        default: 300,
      },
      files: {
        type: 'array',
        description: 'Specific files to check (enables incremental mode)',
        items: {
          type: 'string',
        },
      },
      includeTypeInfo: {
        type: 'boolean',
        description: 'Include type information for exported symbols',
        default: false,
      },
    },
  },
};
