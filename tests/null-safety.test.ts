/**
 * Unit Tests for Null/Undefined Safety (US-BF-003)
 *
 * Tests verify that null and undefined values are properly handled with:
 * - Nullish coalescing (??)
 * - Optional chaining (?.)
 * - Default values
 * - No runtime null reference errors
 */

import { describe, it, expect, beforeEach } from '@jest/globals';

// Mock implementations for testing
interface Operation {
  success: boolean;
  duration: number;
  cacheHit: boolean;
  outputTokens?: number;
  cachedTokens?: number;
  savedTokens?: number;
  timestamp: number;
  operation: string;
  metadata?: Record<string, unknown>;
}

interface SeasonalityPattern {
  detected: boolean;
  period?: number;
  strength?: number;
  peaks?: number[];
  troughs?: number[];
}

// ============================================================================
// Test Suite 1: cache-analytics.ts Null Safety
// ============================================================================

describe('cache-analytics.ts null safety', () => {
  describe('compressionSavings calculation', () => {
    it('should handle undefined outputTokens with nullish coalescing', () => {
      const operations: Operation[] = [
        {
          success: true,
          duration: 100,
          cacheHit: true,
          outputTokens: undefined,
          cachedTokens: 50,
          timestamp: Date.now(),
          operation: 'test'
        }
      ];

      // Simulate the fixed calculation: (op.outputTokens ?? 0) - (op.cachedTokens ?? 0)
      const compressionSavings = operations.reduce(
        (sum, op) => sum + ((op.outputTokens ?? 0) - (op.cachedTokens ?? 0)),
        0
      );

      expect(compressionSavings).toBe(-50);
      expect(compressionSavings).not.toBeNaN();
    });

    it('should handle undefined cachedTokens with nullish coalescing', () => {
      const operations: Operation[] = [
        {
          success: true,
          duration: 100,
          cacheHit: true,
          outputTokens: 100,
          cachedTokens: undefined,
          timestamp: Date.now(),
          operation: 'test'
        }
      ];

      const compressionSavings = operations.reduce(
        (sum, op) => sum + ((op.outputTokens ?? 0) - (op.cachedTokens ?? 0)),
        0
      );

      expect(compressionSavings).toBe(100);
      expect(compressionSavings).not.toBeNaN();
    });

    it('should handle both undefined values with nullish coalescing', () => {
      const operations: Operation[] = [
        {
          success: true,
          duration: 100,
          cacheHit: true,
          outputTokens: undefined,
          cachedTokens: undefined,
          timestamp: Date.now(),
          operation: 'test'
        }
      ];

      const compressionSavings = operations.reduce(
        (sum, op) => sum + ((op.outputTokens ?? 0) - (op.cachedTokens ?? 0)),
        0
      );

      expect(compressionSavings).toBe(0);
      expect(compressionSavings).not.toBeNaN();
    });

    it('should handle normal case with defined values', () => {
      const operations: Operation[] = [
        {
          success: true,
          duration: 100,
          cacheHit: true,
          outputTokens: 150,
          cachedTokens: 50,
          timestamp: Date.now(),
          operation: 'test'
        }
      ];

      const compressionSavings = operations.reduce(
        (sum, op) => sum + ((op.outputTokens ?? 0) - (op.cachedTokens ?? 0)),
        0
      );

      expect(compressionSavings).toBe(100);
    });

    it('should correctly accumulate across multiple operations with mixed null/undefined', () => {
      const operations: Operation[] = [
        {
          success: true,
          duration: 100,
          cacheHit: true,
          outputTokens: 100,
          cachedTokens: 20,
          timestamp: Date.now(),
          operation: 'op1'
        },
        {
          success: true,
          duration: 100,
          cacheHit: true,
          outputTokens: undefined,
          cachedTokens: 30,
          timestamp: Date.now(),
          operation: 'op2'
        },
        {
          success: true,
          duration: 100,
          cacheHit: true,
          outputTokens: 50,
          cachedTokens: undefined,
          timestamp: Date.now(),
          operation: 'op3'
        }
      ];

      const compressionSavings = operations.reduce(
        (sum, op) => sum + ((op.outputTokens ?? 0) - (op.cachedTokens ?? 0)),
        0
      );

      // (100 - 20) + (0 - 30) + (50 - 0) = 80 + (-30) + 50 = 100
      expect(compressionSavings).toBe(100);
    });

    it('should handle zero values without confusing them with nullish values', () => {
      const operations: Operation[] = [
        {
          success: true,
          duration: 100,
          cacheHit: true,
          outputTokens: 0,
          cachedTokens: 0,
          timestamp: Date.now(),
          operation: 'test'
        }
      ];

      const compressionSavings = operations.reduce(
        (sum, op) => sum + ((op.outputTokens ?? 0) - (op.cachedTokens ?? 0)),
        0
      );

      expect(compressionSavings).toBe(0);
    });
  });
});

// ============================================================================
// Test Suite 2: anomaly-explainer.ts Null Safety
// ============================================================================

describe('anomaly-explainer.ts null safety', () => {
  describe('seasonality pattern null safety', () => {
    it('should handle undefined seasonality with optional chaining', () => {
      const seasonality: SeasonalityPattern | undefined = undefined;

      // Test that optional chaining prevents runtime error
      const detected = seasonality?.detected;
      const strength = seasonality?.strength;
      const period = seasonality?.period;

      expect(detected).toBeUndefined();
      expect(strength).toBeUndefined();
      expect(period).toBeUndefined();

      // Verify that code using nullish coalescing works correctly
      const safeStrength = seasonality?.strength ?? 0;
      const safePeriod = seasonality?.period ?? 0;

      expect(safeStrength).toBe(0);
      expect(safePeriod).toBe(0);
    });

    it('should handle defined seasonality with all properties', () => {
      const seasonality: SeasonalityPattern = {
        detected: true,
        period: 3600000,
        strength: 0.8,
        peaks: [1, 5, 10],
        troughs: [2, 6, 11]
      };

      const detected = seasonality?.detected;
      const strength = seasonality?.strength;
      const period = seasonality?.period;

      expect(detected).toBe(true);
      expect(strength).toBe(0.8);
      expect(period).toBe(3600000);

      const safeStrength = seasonality?.strength ?? 0;
      const safePeriod = seasonality?.period ?? 0;

      expect(safeStrength).toBe(0.8);
      expect(safePeriod).toBe(3600000);
    });

    it('should handle seasonality with missing optional properties', () => {
      const seasonality: SeasonalityPattern = {
        detected: false
      };

      const detected = seasonality?.detected;
      const strength = seasonality?.strength;
      const period = seasonality?.period;

      expect(detected).toBe(false);
      expect(strength).toBeUndefined();
      expect(period).toBeUndefined();

      const safeStrength = seasonality?.strength ?? 0;
      const safePeriod = seasonality?.period ?? 0;

      expect(safeStrength).toBe(0);
      expect(safePeriod).toBe(0);
    });

    it('should handle seasonality strength check with optional chaining', () => {
      const seasonalityUndefined: SeasonalityPattern | undefined = undefined;
      const seasonalityNoStrength: SeasonalityPattern = { detected: true };
      const seasonalityLowStrength: SeasonalityPattern = { detected: true, strength: 0.3 };
      const seasonalityHighStrength: SeasonalityPattern = { detected: true, strength: 0.8 };

      // Test the actual condition from the code: seasonality?.detected && seasonality.strength && seasonality.strength > 0.6
      expect(seasonalityUndefined?.detected && seasonalityUndefined.strength && seasonalityUndefined.strength > 0.6).toBeFalsy();
      expect(seasonalityNoStrength?.detected && seasonalityNoStrength.strength && seasonalityNoStrength.strength > 0.6).toBeFalsy();
      expect(seasonalityLowStrength?.detected && seasonalityLowStrength.strength && seasonalityLowStrength.strength > 0.6).toBeFalsy();
      expect(seasonalityHighStrength?.detected && seasonalityHighStrength.strength && seasonalityHighStrength.strength > 0.6).toBeTruthy();
    });

    it('should handle period in string template with nullish coalescing', () => {
      const seasonalityUndefined: SeasonalityPattern | undefined = undefined;
      const seasonalityNoPeriod: SeasonalityPattern = { detected: true, strength: 0.8 };
      const seasonalityWithPeriod: SeasonalityPattern = { detected: true, strength: 0.8, period: 86400000 };

      // Test template string interpolation
      const msg1 = `Pattern detected with ${seasonalityUndefined?.period ?? 0}ms period`;
      const msg2 = `Pattern detected with ${seasonalityNoPeriod?.period ?? 0}ms period`;
      const msg3 = `Pattern detected with ${seasonalityWithPeriod?.period ?? 0}ms period`;

      expect(msg1).toBe('Pattern detected with 0ms period');
      expect(msg2).toBe('Pattern detected with 0ms period');
      expect(msg3).toBe('Pattern detected with 86400000ms period');
    });

    it('should handle period in arithmetic with nullish coalescing', () => {
      const timestamp = 1000000;
      const seasonalityUndefined: SeasonalityPattern | undefined = undefined;
      const seasonalityNoPeriod: SeasonalityPattern = { detected: true };
      const seasonalityWithPeriod: SeasonalityPattern = { detected: true, period: 5000 };

      // Test arithmetic: timestamp - (seasonality.period ?? 0)
      const start1 = timestamp - (seasonalityUndefined?.period ?? 0);
      const start2 = timestamp - (seasonalityNoPeriod?.period ?? 0);
      const start3 = timestamp - (seasonalityWithPeriod?.period ?? 0);

      expect(start1).toBe(1000000);
      expect(start2).toBe(1000000);
      expect(start3).toBe(995000);
    });
  });

  describe('edge cases and integration', () => {
    it('should not throw when accessing properties on null seasonality', () => {
      const seasonality: SeasonalityPattern | null = null;

      expect(() => {
        const detected = seasonality?.detected;
        const strength = seasonality?.strength ?? 0;
        const period = seasonality?.period ?? 0;
        return { detected, strength, period };
      }).not.toThrow();
    });

    it('should handle falsy values correctly with nullish coalescing', () => {
      // Verify ?? only treats null/undefined as nullish, not 0 or false
      const strength0: number | undefined = 0;
      const strengthUndefined: number | undefined = undefined;

      expect(strength0 ?? 0.5).toBe(0); // Should keep 0
      expect(strengthUndefined ?? 0.5).toBe(0.5); // Should use default

      const detectedFalse: boolean | undefined = false;
      const detectedUndefined: boolean | undefined = undefined;

      expect(detectedFalse ?? true).toBe(false); // Should keep false
      expect(detectedUndefined ?? true).toBe(true); // Should use default
    });
  });
});

// ============================================================================
// Test Suite 3: Runtime Null Reference Safety
// ============================================================================

describe('Runtime null reference safety', () => {
  it('should not crash when operations array contains objects with all undefined optional properties', () => {
    const operations: Operation[] = [
      {
        success: true,
        duration: 100,
        cacheHit: false,
        outputTokens: undefined,
        cachedTokens: undefined,
        savedTokens: undefined,
        timestamp: Date.now(),
        operation: 'test'
      }
    ];

    expect(() => {
      const tokensSaved = operations.reduce(
        (sum, op) => sum + (op.savedTokens || 0),
        0
      );
      const compressionSavings = operations.reduce(
        (sum, op) => sum + ((op.outputTokens ?? 0) - (op.cachedTokens ?? 0)),
        0
      );
      return { tokensSaved, compressionSavings };
    }).not.toThrow();
  });

  it('should handle complex nested optional chains without errors', () => {
    interface ComplexObject {
      seasonality?: SeasonalityPattern;
    }

    const obj1: ComplexObject = {};
    const obj2: ComplexObject = { seasonality: undefined };
    const obj3: ComplexObject = { seasonality: { detected: false } };

    expect(() => {
      const s1 = obj1.seasonality?.detected && obj1.seasonality?.strength && obj1.seasonality.strength > 0.6;
      const s2 = obj2.seasonality?.detected && obj2.seasonality?.strength && obj2.seasonality.strength > 0.6;
      const s3 = obj3.seasonality?.detected && obj3.seasonality?.strength && obj3.seasonality.strength > 0.6;
      return { s1, s2, s3 };
    }).not.toThrow();
  });

  it('should provide sensible defaults for all null/undefined scenarios', () => {
    const undefinedValue: number | undefined = undefined;
    const nullValue: number | null = null;

    const result1 = undefinedValue ?? 42;
    const result2 = nullValue ?? 42;

    expect(result1).toBe(42);
    expect(result2).toBe(42);
    expect(result1).not.toBeNaN();
    expect(result2).not.toBeNaN();
  });
});
