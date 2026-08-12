#!/usr/bin/env node
/**
 * Read-only audit of the durable token ledger.
 *
 * This intentionally reports stored claims and verified savings separately.
 * It never mutates or migrates the database, so it is safe to run while the
 * MCP server and dashboard are active.
 */

import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const requested = process.argv[2];
const dbPath = requested
  ? resolve(requested)
  : process.env.TOKEN_OPTIMIZER_ANALYTICS_DB ||
    join(homedir(), '.token-optimizer-mcp', 'analytics.db');

if (!existsSync(dbPath)) {
  throw new Error(`Analytics database not found: ${dbPath}`);
}

const db = new Database(dbPath, { readonly: true, fileMustExist: true });
const columns = new Set(
  db.prepare('PRAGMA table_info(analytics)').all().map((column) => column.name)
);
const savingsMeasuredSql = columns.has('savings_measured')
  ? 'savings_measured'
  : '0 AS savings_measured';
const measurementIdSql = columns.has('measurement_id')
  ? 'measurement_id'
  : 'NULL AS measurement_id';

const rows = db
  .prepare(
    `SELECT id, tool_name, original_tokens, optimized_tokens, tokens_saved,
            ${savingsMeasuredSql}, ${measurementIdSql},
            timestamp, client, metadata
       FROM analytics
      ORDER BY timestamp DESC`
  )
  .all()
  .map((row) => {
    let metadata = {};
    try {
      metadata = row.metadata ? JSON.parse(row.metadata) : {};
    } catch {
      metadata = {};
    }
    const verified =
      Number(row.savings_measured) === 1 &&
      Number(metadata.measurementSchemaVersion) === 2 &&
      metadata.measurementClass === 'verified-transport-reduction' &&
      metadata.baselineKind === 'materialized-undisclosed-mcp-result' &&
      typeof row.measurement_id === 'string' &&
      metadata.measurementId === row.measurement_id &&
      typeof metadata.measurementId === 'string' &&
      /^[a-f0-9]{16}$/i.test(metadata.disclosureRef || '') &&
      /^[a-f0-9]{64}$/i.test(metadata.baselineSha256 || '') &&
      /^[a-f0-9]{64}$/i.test(metadata.returnedSha256 || '') &&
      metadata.baselineSha256 !== metadata.returnedSha256 &&
      Number(metadata.baselineBytes) > Number(metadata.returnedBytes) &&
      Number(metadata.bytesSaved) ===
        Number(metadata.baselineBytes) - Number(metadata.returnedBytes) &&
      Number(row.original_tokens) > Number(row.optimized_tokens) &&
      Number(row.tokens_saved) ===
        Number(row.original_tokens) - Number(row.optimized_tokens);
    const expansionDebit =
      Number(metadata.measurementSchemaVersion) === 2 &&
      metadata.measurementClass === 'verified-transport-expansion-debit' &&
      typeof row.measurement_id === 'string' &&
      metadata.measurementId === row.measurement_id &&
      /^[a-f0-9]{16}$/i.test(metadata.expansionRef || '') &&
      typeof metadata.creditedMeasurementId === 'string' &&
      /^[a-f0-9]{64}$/i.test(metadata.returnedSha256 || '') &&
      Number(metadata.returnedBytes) > 0 &&
      Number(row.original_tokens) === Number(row.optimized_tokens) &&
      Number(row.optimized_tokens) > 0 &&
      Number(row.tokens_saved) === 0;
    const observed =
      Number(metadata.measurementSchemaVersion) === 2 ||
      ['actual-return-context-only', 'optimizer-before-actual-return'].includes(
        metadata.measurement
      );
    const reported = verified || expansionDebit
      ? 0
      : Number(metadata.reportedToolSavings?.tokensSaved ?? row.tokens_saved) ||
        0;
    return { ...row, metadata, verified, expansionDebit, observed, reported };
  });

const sum = (items, key) =>
  items.reduce((total, item) => total + (Number(item[key]) || 0), 0);
const verified = rows.filter((row) => row.verified);
const expansionDebits = rows.filter((row) => row.expansionDebit);
const observed = rows.filter((row) => row.observed);
const unverified = rows.filter((row) => !row.verified && row.reported > 0);
const byTool = new Map();
for (const row of rows) {
  const bucket = byTool.get(row.tool_name) || {
    tool: row.tool_name,
    operations: 0,
    verifiedOperations: 0,
    verifiedExpansionOperations: 0,
    observedReturnOperations: 0,
    verifiedTokensSaved: 0,
    unverifiedReportedTokensSaved: 0,
    maximumReportedSaving: 0,
    verifiedBytesSaved: 0,
  };
  bucket.operations += 1;
  bucket.verifiedOperations += row.verified ? 1 : 0;
  bucket.verifiedExpansionOperations += row.expansionDebit ? 1 : 0;
  bucket.observedReturnOperations += row.observed ? 1 : 0;
  bucket.verifiedTokensSaved += row.verified ? row.tokens_saved : 0;
  bucket.verifiedTokensSaved -= row.expansionDebit ? row.optimized_tokens : 0;
  bucket.unverifiedReportedTokensSaved += row.reported;
  bucket.maximumReportedSaving = Math.max(
    bucket.maximumReportedSaving,
    row.reported
  );
  bucket.verifiedBytesSaved += row.verified
    ? Number(row.metadata.bytesSaved) || 0
    : 0;
  byTool.set(row.tool_name, bucket);
}

const report = {
  schemaVersion: 2,
  generatedAt: new Date().toISOString(),
  database: dbPath,
  readOnly: true,
  coverage: {
    firstSeen: rows.at(-1)?.timestamp || null,
    lastSeen: rows[0]?.timestamp || null,
    operations: rows.length,
    verifiedSavingsOperations: verified.length,
    verifiedExpansionOperations: expansionDebits.length,
    observedReturnedContextOperations: observed.length,
    unverifiedReportedOperations: unverified.length,
  },
  totals: {
    verifiedTokensSaved:
      sum(verified, 'tokens_saved') - sum(expansionDebits, 'optimized_tokens'),
    grossVerifiedTokensSaved: sum(verified, 'tokens_saved'),
    expansionTokensReturned: sum(expansionDebits, 'optimized_tokens'),
    verifiedBytesSaved: verified.reduce(
      (total, row) => total + (Number(row.metadata.bytesSaved) || 0),
      0
    ),
    observedReturnedTokens: sum(observed, 'optimized_tokens'),
    unverifiedReportedTokensSaved: unverified.reduce(
      (total, row) => total + row.reported,
      0
    ),
  },
  byTool: [...byTool.values()].sort(
    (a, b) =>
      b.verifiedTokensSaved - a.verifiedTokensSaved ||
      b.unverifiedReportedTokensSaved - a.unverifiedReportedTokensSaved
  ),
  largestExcludedClaims: unverified
    .slice()
    .sort((a, b) => b.reported - a.reported)
    .slice(0, 20)
    .map((row) => ({
      id: row.id,
      tool: row.tool_name,
      reportedTokensSaved: row.reported,
      storedOriginalTokens: row.original_tokens,
      storedOptimizedTokens: row.optimized_tokens,
      timestamp: row.timestamp,
      client: row.client || null,
      reason:
        row.metadata.measurementSchemaVersion === 2
          ? 'tool-reported estimate lacks a comparable materialized payload'
          : 'legacy row lacks versioned measurement provenance',
    })),
  interpretation: {
    verified:
      'Net transport avoided: a materialized payload minus its initial return, less every later linked expansion payload.',
    observed:
      'Returned context was measured, but no comparable before payload was reduced.',
    unverified:
      'Retained for audit only; excluded from verified totals and cost equivalents.',
  },
};

db.close();
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
