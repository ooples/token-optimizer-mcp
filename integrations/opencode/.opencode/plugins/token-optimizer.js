import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const compactionGuidance = `
## Token Optimizer state

Preserve which large files and bulky outputs have already been processed. After
compaction, continue using token-optimizer smart_read for large or repeated
files, smart_glob/smart_grep for noisy searches, optimize_text for bulky output,
and get_optimization_report when savings are requested.
`;

export const TokenOptimizerPlugin = async ({ directory }) => {
  const hooks = join(directory, '.opencode', 'hooks', 'token-optimizer');
  const pending = new Map();
  const invoke = (entry, payload) => {
    try {
      const result = spawnSync(
        process.execPath,
        [join(hooks, `${entry}.mjs`)],
        {
          input: JSON.stringify(payload),
          encoding: 'utf8',
          // Preserve the live enforcement/capability contract for the generated
          // child hook. Making this explicit also keeps test hosts and embedders
          // from spawning with an implementation-defined environment snapshot.
          env: { ...process.env },
          timeout: 5_000,
          maxBuffer: 64 * 1024,
        }
      );
      return result.status === 0 && result.stdout.trim()
        ? JSON.parse(result.stdout)
        : null;
    } catch {
      return null;
    }
  };
  const keyFor = (input) => input.callID || `${input.sessionID}:${input.tool}`;
  const payloadFor = (input, args) => ({
    session_id: input.sessionID || 'default',
    cwd: directory,
    tool_name: input.tool,
    tool_input: args || {},
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
      pending.set(keyFor(input), {
        context: hook?.additionalContext || '',
        args: output.args,
      });
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
        output.output =
          `${output.output || ''}\n\n[Token Optimizer graph]\n${parts.join('\n\n')}`.trim();
      }
    },
    'experimental.session.compacting': async (_input, output) => {
      output.context.push(compactionGuidance);
    },
  };
};
