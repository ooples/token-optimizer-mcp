// Offline reproduction from the failed Python anchors in the paid transcripts.
// Creates only a new temporary fixture and graph; makes no model/API request.
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const repo = resolve(process.argv[2] || '.');
const reviewRoot = mkdtempSync(join(tmpdir(), 'taskclass-anchor-review-'));
process.env.TOKEN_OPTIMIZER_HOME = join(reviewRoot, 'optimizer');
const workspace = join(reviewRoot, 'workspace');
mkdirSync(workspace);
const path = join(workspace, 'money.py');
const text = 'class Money:\n    @classmethod\n    def from_float(cls, value):\n        return round(value * 100)\n';
writeFileSync(path, text);
const { extractSymbols } = await import(pathToFileURL(join(repo, 'src/hooks-core/symbols.mjs')));
const { writeHarvested } = await import(pathToFileURL(join(repo, 'src/hooks-core/harvest-write.mjs')));
const results = {};
for (const [name, suffix] of [['qualified', '#Money.from_float'], ['method', '#from_float'], ['file', '']]) {
  const graph = join(reviewRoot, `graph-${name}`);
  const findings = [{ type: 'finding', scope: 'project', confidence: .95,
    claim: `Offline anchor review for ${name}: float conversion needs rounding.`,
    evidence: 'A tiny deterministic Python fixture; no model work.',
    applicability: 'Only this offline reproduction.', anchors: [path + suffix] }];
  const stored = writeHarvested(graph, findings, { projectRoot: workspace });
  results[name] = { stored: stored.length, rejected: stored.storeRejected || [] };
}
console.log(JSON.stringify({ fixture: reviewRoot, symbols: extractSymbols(path, text).map(s => s.name), results }, null, 2));
if (results.qualified.stored !== 0 || results.method.stored !== 1 || results.file.stored !== 1)
  process.exitCode = 1;
