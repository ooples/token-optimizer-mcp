import { statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

const threshold =
  Number(process.env.TOKEN_OPTIMIZER_LARGE_READ_BYTES) || 25_600;
const redirect = process.env.TOKEN_OPTIMIZER_REDIRECT_LARGE_READS === 'true';

const compactionGuidance = `
## Token Optimizer state

Preserve which large files and bulky outputs have already been processed. After
compaction, continue using token-optimizer smart_read for large or repeated
files, smart_glob/smart_grep for noisy searches, optimize_text for bulky output,
and get_optimization_report when savings are requested.
`;

function isPartialRead(args) {
  return ['offset', 'limit', 'lineStart', 'lineEnd'].some(
    (key) => args[key] !== undefined
  );
}

export const TokenOptimizerPlugin = async ({ directory }) => ({
  'tool.execute.before': async (input, output) => {
    if (!redirect || input.tool !== 'read' || isPartialRead(output.args))
      return;

    const requestedPath = output.args.filePath;
    if (typeof requestedPath !== 'string' || requestedPath.length === 0) return;

    const absolutePath = isAbsolute(requestedPath)
      ? requestedPath
      : resolve(directory, requestedPath);

    let stats;
    try {
      stats = statSync(absolutePath);
    } catch {
      return;
    }

    if (!stats.isFile() || stats.size < threshold) return;

    const kb = Math.round(stats.size / 1024);
    throw new Error(
      `${absolutePath} is ${kb} KB. Use token-optimizer smart_read with path="${absolutePath}" for cached, diff-based repeat reads.`
    );
  },
  'experimental.session.compacting': async (_input, output) => {
    output.context.push(compactionGuidance);
  },
});
