import type { AnalyticsEntry } from './analytics-types.js';

/**
 * Version 2 is the first analytics contract that proves a savings claim from
 * two materialized MCP payloads. Earlier rows are retained for audit, but are
 * not evidence that context was avoided.
 *
 * Version 3 adds the other half of the product's claim: not "this payload got
 * smaller on its way out" but "you did not have to read the file at all". That
 * baseline was never recorded before, because the only party who knew it was
 * the tool, and a tool's own figure is not evidence -- measured across the
 * benched fleet, every tool that stated its own saving stated a number that
 * was not what it sent, by up to 70 points and sometimes with the wrong sign.
 * Under version 3 the recorder reads the named input and counts it itself.
 *
 * Version 4 admits the two cases the recorder provably cannot reach from the
 * caller's arguments: a tool handed code inline, and a tool given only a
 * directory to resolve a file out of. For those the before is DECLARED by the
 * tool and the after is still measured here, so the row is credited under its
 * own class and never merges with a row where both halves were measured. The
 * set of ways a row can earn a credit changed, so the stamp moved with it --
 * a version 3 reader seeing a declared row would otherwise have no way to know
 * that such a row was possible.
 */
export const SAVINGS_MEASUREMENT_SCHEMA_VERSION = 4;

export type SavingsClassification =
  | 'verified-transport-reduction'
  | 'verified-transport-expansion-debit'
  | 'verified-input-displacement'
  | 'declared-input-displacement'
  | 'observed-return-only'
  | 'unverified-reported';

/**
 * What a tool is permitted to name as the baseline it displaced.
 *
 * A UNION RATHER THAN FREE TEXT, and checked on the way in, so a stored row
 * always says what was counted to get its before. `src/tools/shared/savings.ts`
 * holds the producing side of the same set.
 */
export const DECLARED_BASELINE_SOURCES: readonly string[] = [
  'named-input-files',
  'resolved-project-file',
  'resolved-config-chain',
  'inline-input',
  'captured-command-output',
];

/**
 * Which schema versions each class is admissible under.
 *
 * KEEP THE HISTORY, MARK THE BREAK. A single equality against the current
 * version would have silently demoted every row already stored under version 2
 * to `unverified-reported` the moment this constant moved -- rewriting the past
 * rather than extending it. The transport contract did not change in version 3,
 * so a version 2 row that satisfied it still satisfies it; input displacement
 * did not exist before version 3, so no earlier row may claim it.
 */
const TRANSPORT_VERSIONS: readonly number[] = [2, 3, 4];
const INPUT_DISPLACEMENT_VERSIONS: readonly number[] = [3, 4];
const DECLARED_DISPLACEMENT_VERSIONS: readonly number[] = [4];

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

/**
 * Was the displaced input measured here, by the party that also measured the
 * reply, with both numbers agreeing with the row they are stored on?
 *
 * The two digests must differ for the same reason they must differ in the
 * transport case: a row whose "before" and "after" are the same text has
 * measured nothing, however large the arithmetic it carries.
 */
function hasConsistentInputDisplacement(
  entry: AnalyticsEntry,
  metadata: Record<string, unknown>
): boolean {
  const baselineBytes = finite(metadata.baselineBytes);
  const returnedBytes = finite(metadata.returnedBytes);
  const bytesSaved = finite(metadata.bytesSaved);
  const files = finite(metadata.displacedInputFiles);
  return (
    typeof entry.measurementId === 'string' &&
    entry.measurementId.length > 0 &&
    metadata.measurementId === entry.measurementId &&
    sha256(metadata.displacedInputSha256) &&
    sha256(metadata.returnedSha256) &&
    metadata.displacedInputSha256 !== metadata.returnedSha256 &&
    files !== null &&
    Number.isInteger(files) &&
    files >= 1 &&
    baselineBytes !== null &&
    returnedBytes !== null &&
    bytesSaved !== null &&
    baselineBytes > returnedBytes &&
    bytesSaved === baselineBytes - returnedBytes &&
    entry.originalTokens > entry.optimizedTokens &&
    entry.tokensSaved === entry.originalTokens - entry.optimizedTokens
  );
}

/**
 * Was the displaced input DECLARED by the tool, with the reply still measured
 * here, and is the row internally consistent with that being all that happened?
 *
 * THE DECLARATION IS REFUSED WHENEVER THE RECORDER HAD ITS OWN MEASUREMENT.
 * `displacedInputSha256` is written on every row where the named input could be
 * read, so its presence means the measured class was available and this row
 * would be double-counting a before the recorder already held. The fallback
 * only exists for the arguments it cannot reach: code handed in inline, and a
 * directory a tool resolves a file out of by its own rules.
 *
 * NO BYTE FIGURE IS ACCEPTED. A tool declares a token count, so a row under
 * this class must not carry a `baselineBytes` nobody counted -- the one number
 * that would look identical to a measured row while meaning nothing.
 */
function hasConsistentDeclaredDisplacement(
  entry: AnalyticsEntry,
  metadata: Record<string, unknown>
): boolean {
  const declared = finite(metadata.declaredBaselineTokens);
  return (
    typeof entry.measurementId === 'string' &&
    entry.measurementId.length > 0 &&
    metadata.measurementId === entry.measurementId &&
    typeof metadata.declaredBaselineSource === 'string' &&
    DECLARED_BASELINE_SOURCES.includes(metadata.declaredBaselineSource) &&
    declared !== null &&
    Number.isInteger(declared) &&
    declared > 0 &&
    declared === entry.originalTokens &&
    sha256(metadata.returnedSha256) &&
    metadata.displacedInputSha256 == null &&
    metadata.baselineSha256 == null &&
    metadata.baselineBytes == null &&
    finite(metadata.bytesSaved) === 0 &&
    entry.originalTokens > entry.optimizedTokens &&
    entry.tokensSaved === entry.originalTokens - entry.optimizedTokens
  );
}

export function classifySavings(entry: AnalyticsEntry): SavingsClassification {
  const metadata = metadataOf(entry);
  const schemaVersion = Number(metadata.measurementSchemaVersion);
  const measurementClass = String(metadata.measurementClass || '');

  if (
    entry.savingsMeasured === true &&
    TRANSPORT_VERSIONS.includes(schemaVersion) &&
    measurementClass === 'verified-transport-reduction' &&
    metadata.baselineKind === 'materialized-undisclosed-mcp-result' &&
    hasConsistentMaterializedDelta(entry, metadata)
  ) {
    return 'verified-transport-reduction';
  }

  if (
    TRANSPORT_VERSIONS.includes(schemaVersion) &&
    measurementClass === 'verified-transport-expansion-debit' &&
    hasConsistentExpansionDebit(entry, metadata)
  ) {
    return 'verified-transport-expansion-debit';
  }

  if (
    entry.savingsMeasured === true &&
    INPUT_DISPLACEMENT_VERSIONS.includes(schemaVersion) &&
    measurementClass === 'verified-input-displacement' &&
    metadata.baselineKind === 'measured-displaced-input' &&
    hasConsistentInputDisplacement(entry, metadata)
  ) {
    return 'verified-input-displacement';
  }

  if (
    entry.savingsMeasured === true &&
    DECLARED_DISPLACEMENT_VERSIONS.includes(schemaVersion) &&
    measurementClass === 'declared-input-displacement' &&
    metadata.baselineKind === 'declared-displaced-input' &&
    hasConsistentDeclaredDisplacement(entry, metadata)
  ) {
    return 'declared-input-displacement';
  }

  if (
    TRANSPORT_VERSIONS.includes(schemaVersion) ||
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

/**
 * Tokens the caller did not spend because a tool answered instead of handing
 * them the file -- measured on both sides by the recorder.
 *
 * KEPT APART FROM THE TRANSPORT DELTA ON PURPOSE. The two count different
 * avoidances: one is payload a tool would have put on the wire anyway and the
 * disclosure layer trimmed, the other is a file read that never happened. A
 * caller that wants one total adds them deliberately; nothing adds them by
 * accident through a function whose name says "transport".
 */
export function verifiedInputDisplacement(entry: AnalyticsEntry): number {
  if (classifySavings(entry) !== 'verified-input-displacement') return 0;
  return Math.max(0, Number(entry.tokensSaved) || 0);
}

/**
 * Tokens a tool DECLARED it displaced, with only the reply measured here.
 *
 * KEPT APART FROM `verifiedInputDisplacement` ON PURPOSE, and not merely for
 * tidiness: the two have different evidence behind them. One was counted twice
 * by the same counter; the other was counted once here and once by the tool,
 * and across this fleet a tool's own figure was wrong by up to 70 points and
 * sometimes with the wrong sign. The declaration survives because it carries no
 * arithmetic -- it names a before and nothing else -- but it is still a weaker
 * row, and a reader is entitled to see which of the two a total came from.
 */
export function declaredInputDisplacement(entry: AnalyticsEntry): number {
  if (classifySavings(entry) !== 'declared-input-displacement') return 0;
  return entry.tokensSaved;
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
