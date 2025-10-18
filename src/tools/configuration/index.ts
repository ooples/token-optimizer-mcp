/**
 * Configuration Tools - Smart Configuration Analysis
 *
 * Tools for analyzing and managing project configuration files
 * with intelligent caching and token reduction.
 */

export {
  SmartPackageJson,
  runSmartPackageJson,
  SMART_PACKAGE_JSON_TOOL_DEFINITION,
} from './smart-package-json';

export {
  SmartConfigReadTool,
  getSmartConfigReadTool,
  runSmartConfigRead,
  SMART_CONFIG_READ_TOOL_DEFINITION,
} from './smart-config-read';

// SmartEnv - Implementation pending
// SmartWorkflow - Implementation pending
// Note: Exports temporarily removed until implementation is complete

export {
  runSmartTsconfig,
  SMART_TSCONFIG_TOOL_DEFINITION,
} from './smart-tsconfig';

export type {
  SmartConfigReadOptions,
  SmartConfigReadResult,
  ConfigFormat,
  ConfigSchema,
  ConfigSchemaProperty,
  ConfigValidationError,
  ConfigDiff,
} from './smart-config-read';

// SmartWorkflow types - Implementation pending
