/**
 * Saying what the pass found, and putting it where the next session will read it.
 *
 * TWO RULES GOVERN THE WRITING. A block this tool owns is delimited, so running
 * again replaces its own advice instead of appending a fourth copy of it -- an
 * instructions file that grows every time a tool runs is one a user deletes. And
 * nothing outside those markers is ever touched: the file belongs to the user, and
 * this is a guest in it.
 */

import { renameSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { AnalysisResult, Confidence, Recommendation } from './models.js';

export const BLOCK_START = '<!-- token-optimizer:learn:start -->';
export const BLOCK_END = '<!-- token-optimizer:learn:end -->';

const HEADING = '## What past sessions kept getting wrong';

function badge(recommendation: Recommendation): string {
  const evidence =
    recommendation.sessions > 1
      ? `${recommendation.occurrences} times across ${recommendation.sessions} sessions`
      : `${recommendation.occurrences} times in one session`;
  return recommendation.confidence === Confidence.Thin
    ? `${evidence}, thin evidence`
    : evidence;
}

/** The lines a human reads in a terminal. */
export function describeAnalysis(result: AnalysisResult): string[] {
  const lines = [
    `${result.agent}: ${result.project.name}`,
    `  ${result.sessions} session(s), ${result.calls} tool call(s), ${result.failures} failed`,
  ];
  if (result.calls > 0) {
    const rate = ((result.failures / result.calls) * 100).toFixed(1);
    lines.push(`  failure rate ${rate}%`);
  }
  if (result.uncategorised > 0) {
    // Said out loud, because it is the number that bounds how much of this to
    // believe. A pass that could not read most of its failures found less than it
    // appears to have found.
    lines.push(
      `  ${result.uncategorised} failure(s) could not be categorised, so no rule was written for them`
    );
  }
  if (result.unattributable > 0) {
    lines.push(
      `  ${result.unattributable} failure(s) ran in a chained command line, where nothing ` +
        `records which command failed`
    );
  }
  for (const path of result.unreadable) {
    lines.push(`  UNREADABLE: ${path}`);
  }
  if (result.recommendations.length === 0) {
    lines.push('  nothing repeated often enough to be worth a rule');
    return lines;
  }
  // Grouped, because the headings repeat: eight findings under three headings read
  // as three things to fix, and as eight when each carries its own title again.
  for (const [heading, bucket] of byHeading(result.recommendations)) {
    lines.push(`  ${heading}`);
    for (const recommendation of bucket) {
      lines.push(`    ${recommendation.body} (${badge(recommendation)})`);
    }
  }
  return lines;
}

/** Recommendations under their shared headings, in the order they arrived. */
function byHeading(
  recommendations: readonly Recommendation[]
): ReadonlyMap<string, Recommendation[]> {
  const grouped = new Map<string, Recommendation[]>();
  for (const recommendation of recommendations) {
    const bucket = grouped.get(recommendation.heading) ?? [];
    bucket.push(recommendation);
    grouped.set(recommendation.heading, bucket);
  }
  return grouped;
}

/** The markdown block, contents only, without the markers. */
export function renderRecommendations(result: AnalysisResult): string {
  const grouped = byHeading(result.recommendations);
  const parts = [
    HEADING,
    '',
    `Written by token-optimizer from ${result.sessions} past ${result.agent} session(s) in this` +
      ` project. Everything below is edited by that tool; anything outside the markers is not.`,
    '',
  ];
  for (const [heading, bucket] of grouped) {
    parts.push(`### ${heading}`, '');
    for (const recommendation of bucket) {
      parts.push(`- ${recommendation.body} _(${badge(recommendation)})_`);
    }
    parts.push('');
  }
  return parts.join('\n').trimEnd();
}

export interface WriteOutcome {
  readonly path: string;
  /** What the file would become. Returned whether or not it was written. */
  readonly content: string;
  readonly written: boolean;
  /** True when the file already said exactly this. */
  readonly unchanged: boolean;
  /** True when the tool's own block was replaced rather than added. */
  readonly replaced: boolean;
}

/**
 * Put the block in a context file.
 *
 * `dryRun` is the default at every call site above this one. A tool that edits a
 * user's instructions file the first time they ask it to look at something has
 * misunderstood what it was asked.
 */
export function writeRecommendations(
  projectDir: string,
  contextFile: string,
  result: AnalysisResult,
  options: { readonly dryRun?: boolean } = {}
): WriteOutcome {
  const path = join(projectDir, contextFile);
  const block = `${BLOCK_START}\n${renderRecommendations(result)}\n${BLOCK_END}`;
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const start = existing.indexOf(BLOCK_START);
  const end = existing.indexOf(BLOCK_END);
  let content: string;
  let replaced = false;
  if (start !== -1 && end > start) {
    content = existing.slice(0, start) + block + existing.slice(end + BLOCK_END.length);
    replaced = true;
  } else if (existing.trim().length === 0) {
    content = `${block}\n`;
  } else {
    const separator = existing.endsWith('\n') ? '\n' : '\n\n';
    content = `${existing}${separator}${block}\n`;
  }
  const unchanged = content === existing;
  if (options.dryRun === true || unchanged) {
    return { path, content, written: false, unchanged, replaced };
  }
  // Written through a temporary file in the same directory and renamed, so a
  // failure halfway cannot leave a user's instructions file half-written.
  const temporary = `${path}.token-optimizer.tmp`;
  writeFileSync(temporary, content, 'utf8');
  renameSync(temporary, path);
  return { path, content, written: true, unchanged, replaced };
}