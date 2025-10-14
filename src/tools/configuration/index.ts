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
} from "./smart-package-json";

export {
  SmartConfigReadTool,
  getSmartConfigReadTool,
  runSmartConfigRead,
  SMART_CONFIG_READ_TOOL_DEFINITION,
} from "./smart-config-read";

export { SmartEnv, runSmartEnv, SMART_ENV_TOOL_DEFINITION } from "./smart-env";

export {
  SmartWorkflow,
  runSmartWorkflow,
  SMART_WORKFLOW_TOOL_DEFINITION,
} from "./smart-workflow";

export {
  runSmartTsconfig,
  SMART_TSCONFIG_TOOL_DEFINITION,
} from "./smart-tsconfig";

export type {
  SmartConfigReadOptions,
  SmartConfigReadResult,
  ConfigFormat,
  ConfigSchema,
  ConfigSchemaProperty,
  ConfigValidationError,
  ConfigDiff,
} from "./smart-config-read";

export type {
  SmartWorkflowOptions,
  SmartWorkflowOutput,
  WorkflowFile,
  WorkflowDefinition,
  WorkflowJob,
  WorkflowStep,
  WorkflowError,
  WorkflowWarning,
  SecurityIssue,
  OptimizationSuggestion,
} from "./smart-workflow";
