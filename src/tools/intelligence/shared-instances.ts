/**
 * Shared Singleton Instances for Intelligence Tools
 *
 * This module provides true singleton instances of CacheEngine, TokenCounter,
 * and MetricsCollector that are shared across ALL intelligence tools.
 *
 * This ensures:
 * - Consistent cache state across all tools
 * - Unified metrics collection
 * - Accurate token counting across the system
 * - Memory efficiency (single instances instead of per-tool instances)
 */

import { CacheEngine } from '../../core/cache-engine.js';
import { TokenCounter } from '../../core/token-counter.js';
import { MetricsCollector } from '../../core/metrics.js';

// Singleton instances - created once and shared across all intelligence tools
export const sharedCache = new CacheEngine();
export const sharedTokenCounter = new TokenCounter();
export const sharedMetricsCollector = new MetricsCollector();
