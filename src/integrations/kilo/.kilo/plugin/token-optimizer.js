import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

/**
 * Kilo's plugin API is in-process while the other clients execute command
 * hooks. This bridge still runs the generated entry scripts, so policy,
 * graph delivery, structural capture, and metrics stay in the shared engine.
 */
export const TokenOptimizerPlugin = async ({ directory }) => {
  const hooks = join(directory, '.kilo', 'hooks', 'token-optimizer');
  const pending = new Map();

  const invoke = (entry, payload) => {
    try {
      const result = spawnSync(
        process.execPath,
        [join(hooks, `${entry}.mjs`)],
        {
          input: JSON.stringify(payload),
          encoding: 'utf8',
          // Carry explicit advise/off and capability overrides into the shared
          // command hook rather than relying on an embedder's spawn defaults.
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
      const result = invoke('pre-tool', payloadFor(input, output.args));
      const hook = result?.hookSpecificOutput;
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
  };
};

export default { id: 'token-optimizer', server: TokenOptimizerPlugin };
