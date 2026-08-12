import type { AnalyticsEntry } from './analytics-types.js';

/**
 * Version 2 is the first analytics contract that proves a savings claim from
 * two materialized MCP payloads. Earlier rows are retained for audit, but are
 * not evidence that context was avoided.
 */
export const SAVINGS_MEASUREMENT_SCHEMA_VERSION = 2;

export type SavingsClassification =
  | 'verified-transport-reduction'
  | 'verified-transport-expansion-debit'
  | 'observed-return-only'
  | 'unverified-reported';

function metadataOf(entry: AnalyticsEntry): Record<string, unknown> {
  return entry.metadata || {};
}

function finite(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function sha256(value: unknown): boolean {
  return typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value);
}

function hasConsistentMaterializedDelta(
  entry: AnalyticsEntry,
  metadata: Record<string, unknown>
): boolean {
  const baselineBytes = finite(metadata.baselineBytes);
  const returnedBytes = finite(metadata.returnedBytes);
  const bytesSaved = finite(metadata.bytesSaved);
  return (
    typeof entry.measurementId === 'string' &&
    entry.measurementId.length > 0 &&
    metadata.measurementId === entry.measurementId &&
    sha256(metadata.baselineSha256) &&
    sha256(metadata.returnedSha256) &&
    metadata.baselineSha256 !== metadata.returnedSha256 &&
    typeof metadata.disclosureRef === 'string' &&
    /^[a-f0-9]{16}$/i.test(metadata.disclosureRef) &&
    baselineBytes !== null &&
    returnedBytes !== null &&
    bytesSaved !== null &&
    baselineBytes > returnedBytes &&
    bytesSaved === baselineBytes - returnedBytes &&
    entry.originalTokens > entry.optimizedTokens &&
    entry.tokensSaved === entry.originalTokens - entry.optimizedTokens
  );
}

function hasConsistentExpansionDebit(
  entry: AnalyticsEntry,
  metadata: Record<string, unknown>
): boolean {
  const returnedBytes = finite(metadata.returnedBytes);
  return (
    typeof entry.measurementId === 'string' &&
    entry.measurementId.length > 0 &&
    metadata.measurementId === entry.measurementId &&
    typeof metadata.expansionRef === 'string' &&
    /^[a-f0-9]{16}$/i.test(metadata.expansionRef) &&
    typeof metadata.creditedMeasurementId === 'string' &&
    metadata.creditedMeasurementId.length > 0 &&
    sha256(metadata.returnedSha256) &&
    returnedBytes !== null &&
    returnedBytes > 0 &&
    entry.originalTokens === entry.optimizedTokens &&
    entry.optimizedTokens > 0 &&
    entry.tokensSaved === 0
  );
}

export function classifySavings(entry: AnalyticsEntry): SavingsClassification {
  const metadata = metadataOf(entry);
  const schemaVersion = Number(metadata.measurementSchemaVersion);
  const measurementClass = String(metadata.measurementClass || '');

  if (
    entry.savingsMeasured === true &&
    schemaVersion === SAVINGS_MEASUREMENT_SCHEMA_VERSION &&
    measurementClass === 'verified-transport-reduction' &&
    metadata.baselineKind === 'materialized-undisclosed-mcp-result' &&
    hasConsistentMaterializedDelta(entry, metadata)
  ) {
    return 'verified-transport-reduction';
  }

  if (
    schemaVersion === SAVINGS_MEASUREMENT_SCHEMA_VERSION &&
    measurementClass === 'verified-transport-expansion-debit' &&
    hasConsistentExpansionDebit(entry, metadata)
  ) {
    return 'verified-transport-expansion-debit';
  }

  if (
    schemaVersion === SAVINGS_MEASUREMENT_SCHEMA_VERSION ||
    ['actual-return-context-only', 'optimizer-before-actual-return'].includes(
      String(metadata.measurement || '')
    )
  ) {
    return 'observed-return-only';
  }

  return 'unverified-reported';
}

export function isVerifiedSavingsEntry(entry: AnalyticsEntry): boolean {
  return classifySavings(entry) === 'verified-transport-reduction';
}

export function isVerifiedExpansionDebit(entry: AnalyticsEntry): boolean {
  return classifySavings(entry) === 'verified-transport-expansion-debit';
}

/** Signed contribution to net MCP transport avoided. */
export function verifiedTransportDelta(entry: AnalyticsEntry): number {
  const classification = classifySavings(entry);
  if (classification === 'verified-transport-reduction') {
    return Math.max(0, Number(entry.tokensSaved) || 0);
  }
  if (classification === 'verified-transport-expansion-debit') {
    return -Math.max(0, Number(entry.optimizedTokens) || 0);
  }
  return 0;
}

export function hasObservedReturnedContext(entry: AnalyticsEntry): boolean {
  return classifySavings(entry) !== 'unverified-reported';
}

export function reportedSavings(entry: AnalyticsEntry): number {
  const metadataReported = (entry.metadata || {}).reportedToolSavings;
  if (metadataReported && typeof metadataReported === 'object') {
    const value = Number(
      (metadataReported as Record<string, unknown>).tokensSaved
    );
    if (Number.isFinite(value)) return Math.max(0, value);
  }
  const value = Number(entry.tokensSaved);
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}
