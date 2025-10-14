/**
 * Global instances for backward compatibility with hypercontext-mcp
 */

import { TokenCounter } from './token-counter.js';
import { MetricsCollector } from './metrics.js';
import { ConfigManager } from './config.js';

// Create global token counter instance
export const globalTokenCounter = new TokenCounter();

// Create global metrics collector instance
export const globalMetricsCollector = new MetricsCollector();

// Create default config manager instance
export const defaultConfigManager = new ConfigManager();
