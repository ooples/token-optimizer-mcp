/**
 * A NEW CONTRACT MUST NOT RE-JUDGE THE ROWS STORED UNDER THE OLD ONE.
 *
 * `classifySavings` used to compare a row's stamp against the current schema
 * version with `===`. That is correct exactly once -- the moment the constant
 * moves, every row already on disk stops matching, and a store full of rows
 * that proved their saving from two materialized payloads silently re-reads as
 * `unverified-reported`. The dashboard's history would not be marked as coming
 * from an older contract; it would simply shrink.
 *
 * So each class names the versions it is admissible under: the transport
 * contract did not change when input displacement was added, so a version 2
 * row that satisfied it still does, while input displacement is refused to
 * every row stamped before the version that defined it.
 */

import {
  SAVINGS_MEASUREMENT_SCHEMA_VERSION,
  classifySavings,
  verifiedTransportDelta,
} from '../../../src/analytics/savings-classification.js';
import type { AnalyticsEntry } from '../../../src/analytics/analytics-types.js';

const ID = 'a4f0c0de-0000-4000-8000-000000000001';
const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);

/** A row that proved a transport reduction under the version 2 contract. */
function transportRow(schemaVersion: number): AnalyticsEntry {
  return {
    timestamp: 1,
    toolName: 'smart_read',
    originalTokens: 1000,
    optimizedTokens: 400,
    tokensSaved: 600,
    savingsMeasured: true,
    measurementId: ID,
    metadata: {
      measurementId: ID,
      measurementSchemaVersion: schemaVersion,
      measurement: 'materialized-transport-before-after',
      measurementClass: 'verified-transport-reduction',
      baselineKind: 'materialized-undisclosed-mcp-result',
      baselineBytes: 4000,
      returnedBytes: 1600,
      bytesSaved: 2400,
      baselineSha256: SHA_A,
      returnedSha256: SHA_B,
      disclosureRef: 'abcdef0123456789',
    },
  } as unknown as AnalyticsEntry;
}

describe('the stored history', () => {
  it('keeps the verdict a version 2 row earned', () => {
    const row = transportRow(2);
    expect(classifySavings(row)).toBe('verified-transport-reduction');
    expect(verifiedTransportDelta(row)).toBe(600);
  });

  it('gives the same verdict to the same row under the current version', () => {
    // THE POSITIVE CONTROL. If the predicate were broken for both versions the
    // test above would pass for the wrong reason, by failing everywhere.
    const row = transportRow(SAVINGS_MEASUREMENT_SCHEMA_VERSION);
    expect(classifySavings(row)).toBe('verified-transport-reduction');
    expect(verifiedTransportDelta(row)).toBe(600);
  });

  it('refuses a version it has never defined', () => {
    expect(classifySavings(transportRow(1))).toBe('unverified-reported');
    expect(
      classifySavings(transportRow(SAVINGS_MEASUREMENT_SCHEMA_VERSION + 1))
    ).toBe('unverified-reported');
  });

  it('refuses input displacement to a row stamped before it existed', () => {
    /*
     * A row cannot acquire a class that did not exist when it was written. The
     * fields are all present and consistent here -- only the stamp is old --
     * so this is the case a per-class version set exists to refuse.
     */
    const row = {
      ...transportRow(2),
      metadata: {
        ...transportRow(2).metadata,
        measurementClass: 'verified-input-displacement',
        baselineKind: 'measured-displaced-input',
        displacedInputSha256: SHA_A,
        displacedInputFiles: 1,
      },
    } as unknown as AnalyticsEntry;
    expect(classifySavings(row)).toBe('observed-return-only');
  });
});
