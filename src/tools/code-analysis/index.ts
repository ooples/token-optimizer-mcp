/**
 * Code Analysis Tools
 *
 * Tools for analyzing TypeScript/JavaScript code with intelligent caching
 */

export {
  SmartTypeScript,
  getSmartTypeScriptTool,
  runSmartTypescript,
  SMART_TYPESCRIPT_TOOL_DEFINITION,
} from './smart-typescript';

export {
  SmartAstGrepTool,
  getSmartAstGrepTool,
  runSmartAstGrep,
  SMART_AST_GREP_TOOL_DEFINITION,
  type SmartAstGrepOptions,
  type SmartAstGrepResult,
  type AstMatch,
} from './smart-ast-grep';

// SmartAmbiance - Implementation pending
// Note: Exports temporarily removed until implementation is complete

export {
  SmartSecurity,
  getSmartSecurityTool,
  runSmartSecurity,
  SMART_SECURITY_TOOL_DEFINITION,
  type SmartSecurityOptions,
  type SmartSecurityOutput,
} from './smart-security';

export {
  SmartDependenciesTool,
  getSmartDependenciesTool,
  runSmartDependencies,
  SMART_DEPENDENCIES_TOOL_DEFINITION,
  type SmartDependenciesOptions,
  type SmartDependenciesResult,
  type DependencyNode as DependencyGraphNode,
  type DependencyImport,
  type DependencyExport,
  type CircularDependency,
  type UnusedDependency,
  type DependencyImpact,
} from './smart-dependencies';

export {
  SmartSymbolsTool,
  getSmartSymbolsTool,
  runSmartSymbols,
  SMART_SYMBOLS_TOOL_DEFINITION,
  type SmartSymbolsOptions,
  type SmartSymbolsResult,
  type SymbolInfo,
} from './smart-symbols';

export {
  SmartComplexityTool,
  getSmartComplexityTool,
  runSmartComplexity,
  SMART_COMPLEXITY_TOOL_DEFINITION,
  type SmartComplexityOptions,
  type SmartComplexityResult,
  type ComplexityMetrics,
  type FunctionComplexity,
} from './smart-complexity';

export {
  SmartRefactorTool,
  getSmartRefactorTool,
  runSmartRefactor,
  SMART_REFACTOR_TOOL_DEFINITION,
  type SmartRefactorOptions,
  type SmartRefactorResult,
  type RefactorSuggestion,
} from './smart-refactor';

export {
  SmartImportsTool,
  getSmartImportsTool,
  runSmartImports,
  SMART_IMPORTS_TOOL_DEFINITION,
  type SmartImportsOptions,
  type SmartImportsResult,
  type ImportInfo,
  type ImportOptimization,
  type CircularDependency as ImportCircularDependency,
} from './smart-imports';

export {
  SmartExportsTool,
  getSmartExportsTool,
  runSmartExports,
  SMART_EXPORTS_TOOL_DEFINITION,
  type SmartExportsOptions,
  type SmartExportsResult,
  type ExportInfo,
  type ExportDependency,
  type ExportOptimization,
} from './smart-exports';
