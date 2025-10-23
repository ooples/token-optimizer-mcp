#!/usr/bin/env python3
"""Add monitoring tools to master's index.ts"""

with open('src/server/index.ts', 'r', encoding='utf-8') as f:
    content = f.read()

# 1. Add imports after smart-cache
imports_marker = "} from '../tools/advanced-caching/smart-cache.js';\n\n// API & Database tools"
monitoring_imports = """} from '../tools/advanced-caching/smart-cache.js';

// Monitoring Tools (3 tools)
import {
  getAlertManager,
  ALERT_MANAGER_TOOL_DEFINITION,
} from '../tools/dashboard-monitoring/alert-manager.js';
import {
  getMetricCollector,
  METRIC_COLLECTOR_TOOL_DEFINITION,
} from '../tools/dashboard-monitoring/metric-collector.js';
import {
  getMonitoringIntegration,
  MONITORING_INTEGRATION_TOOL_DEFINITION,
} from '../tools/dashboard-monitoring/monitoring-integration.js';

// API & Database tools"""

content = content.replace(imports_marker, monitoring_imports)
print("[OK] Added imports")

# 2. Add initializations after smartWebSocket
init_marker = "const smartWebSocket = getSmartWebSocket(cache, tokenCounter, metrics);\n\n// File operations"
monitoring_inits = """const smartWebSocket = getSmartWebSocket(cache, tokenCounter, metrics);

// Initialize monitoring tools
const alertManager = getAlertManager(cache, tokenCounter, metrics);
const metricCollectorTool = getMetricCollector(cache, tokenCounter, metrics);
const monitoringIntegration = getMonitoringIntegration(cache, tokenCounter, metrics);

// File operations"""

content = content.replace(init_marker, monitoring_inits)
print("[OK] Added initializations")

# 3. Add tool definitions after SMART_WEBSOCKET_TOOL_DEFINITION
def_marker = "      SMART_WEBSOCKET_TOOL_DEFINITION,\n      // File operations"
monitoring_defs = """      SMART_WEBSOCKET_TOOL_DEFINITION,
      // Monitoring tools
      ALERT_MANAGER_TOOL_DEFINITION,
      METRIC_COLLECTOR_TOOL_DEFINITION,
      MONITORING_INTEGRATION_TOOL_DEFINITION,
      // File operations"""

content = content.replace(def_marker, monitoring_defs)
print("[OK] Added tool definitions")

# 4. Add handlers before file operations disabled comment
handler_marker = "      // File operations tools disabled in live-test config"
monitoring_handlers = """
      case 'alert_manager': {
        const options = args as any;
        const result = await alertManager.run(options);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case 'metric_collector': {
        const options = args as any;
        const result = await metricCollectorTool.run(options);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case 'monitoring_integration': {
        const options = args as any;
        const result = await monitoringIntegration.run(options);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      // File operations tools disabled in live-test config"""

content = content.replace(handler_marker, monitoring_handlers)
print("[OK] Added handlers")

with open('src/server/index.ts', 'w', encoding='utf-8') as f:
    f.write(content)

print("\n[SUCCESS] Monitoring tools added - PR #65 (18) + PR #71 (3) = 21 tools")
