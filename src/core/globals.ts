/**
 * Global shared instances for token counting and metrics collection
 *
 * These instances are shared across all tools to avoid duplicative instantiation
 * and ensure consistent tracking across the application.
 */

import { TokenCounter } from './token-counter';
import { MetricsCollector } from './metrics';

/**
 * Global token counter instance shared across all tools
 */
export const globalTokenCounter = new TokenCounter();

/**
 * Global metrics collector instance shared across all tools
 */
export const globalMetricsCollector = new MetricsCollector();
