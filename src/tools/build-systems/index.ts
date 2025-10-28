/**
 * Build Systems Tools
 *
 * Smart wrappers for common build/test tools that dramatically reduce token usage
 * while maintaining actionable information.
 */

export {
  SmartTest,
  getSmartTestTool,
  runSmartTest,
  SMART_TEST_TOOL_DEFINITION,
} from './smart-test.js';
export {
  SmartBuild,
  getSmartBuildTool,
  runSmartBuild,
  SMART_BUILD_TOOL_DEFINITION,
} from './smart-build.js';
export {
  SmartLint,
  getSmartLintTool,
  runSmartLint,
  SMART_LINT_TOOL_DEFINITION,
} from './smart-lint.js';
export {
  SmartTypeCheck,
  getSmartTypeCheckTool,
  runSmartTypeCheck,
  SMART_TYPECHECK_TOOL_DEFINITION,
} from './smart-typecheck.js';
export {
  SmartProcesses,
  getSmartProcessesTool,
  runSmartProcesses,
  SMART_PROCESSES_TOOL_DEFINITION,
} from './smart-processes.js';
