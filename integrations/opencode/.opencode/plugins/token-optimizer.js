import { statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { isAbsolute, join, resolve } from 'node:path';

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

export const TokenOptimizerPlugin = async ({ directory }) => {
  const hooks = join(directory, '.opencode', 'hooks', 'token-optimizer');
  const pending = new Map();
  const invoke = (entry, payload) => {
    try {
      const result = spawnSync(process.execPath, [join(hooks, `${entry}.mjs`)], {
        input: JSON.stringify(payload),
        encoding: 'utf8',
        timeout: 5_000,
        maxBuffer: 64 * 1024,
      });
      return result.status === 0 && result.stdout.trim()
        ? JSON.parse(result.stdout)
        : null;
    } catch {
      return null;
    }
  };
  const keyFor = (input) => input.callID || `${input.sessionID}:${input.tool}`;
  const payloadFor = (input, args) => ({
    session_id: input.sessionID || 'default', cwd: directory,
    tool_name: input.tool, tool_input: args || {},
  });

  return {
  'experimental.chat.system.transform': async (_input, output) => {
    const result = invoke('session-start', {});
    const policy = result?.hookSpecificOutput?.additionalContext;
    if (policy) output.system.push(policy);
  },
  'tool.execute.before': async (input, output) => {
    const shared = invoke('pre-tool', payloadFor(input, output.args));
    const hook = shared?.hookSpecificOutput;
    if (hook?.permissionDecision === 'deny') {
      throw new Error(hook.permissionDecisionReason);
    }
    pending.set(keyFor(input), { context: hook?.additionalContext || '', args: output.args });

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
  'tool.execute.after': async (input, output) => {
    const parts = [];
    const prior = pending.get(keyFor(input));
    pending.delete(keyFor(input));
    if (prior?.context) parts.push(prior.context);

    if (/^(?:edit|write|apply_patch|replace)$/i.test(input.tool)) {
      const result = invoke('post-tool', payloadFor(input, prior?.args));
      const context = result?.hookSpecificOutput?.additionalContext;
      if (context) parts.push(context);
    }
    if (parts.length) {
      output.output = `${output.output || ''}\n\n[Token Optimizer graph]\n${parts.join('\n\n')}`.trim();
    }
  },
  'experimental.session.compacting': async (_input, output) => {
    output.context.push(compactionGuidance);
  },
  };
};
