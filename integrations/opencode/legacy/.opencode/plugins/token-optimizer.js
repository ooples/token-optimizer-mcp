// GENERATED from integrations/opencode/.opencode/plugins/token-optimizer.js by
// scripts/generate-opencode-legacy-plugin.mjs -- edit that file, then run
// `npm run sync:hooks`. For OpenCode 1.3.3 and earlier only: it exports the
// V1 plugin function and nothing else, because those releases call every
// export as a plugin. Install this file OR the current one, never both.
import { spawnSync } from 'node:child_process';
import { basename, join } from 'node:path';

/**
 * Runtime used to execute the generated hook entries. The hooks target Node,
 * and OpenCode 1.x ran plugins inside a Node server, so process.execPath used
 * to be node. OpenCode 2.x is a compiled binary: spawning it with a .mjs path
 * makes the CLI treat the script as a project directory (ENOTDIR) instead of
 * executing it, and enforcement silently no-ops. Keep process.execPath when it
 * is Node and fall back to node on PATH otherwise.
 */
const HOOK_RUNTIME = /^node/i.test(basename(process.execPath))
  ? process.execPath
  : 'node';

const compactionGuidance = `
## Token Optimizer state

Preserve which large files and bulky outputs have already been processed. After
compaction, continue using token-optimizer smart_read for large or repeated
files, smart_glob/smart_grep for noisy searches, optimize_text for bulky output,
and get_optimization_report when savings are requested.
`;

/**
 * Spawn one generated shared hook entry over the stdin/stdout JSON contract.
 * Shared by both plugin APIs below so V1 and V2 hosts enforce identically.
 */
const createInvoke = (directory) => {
  const hooks = join(directory, '.opencode', 'hooks', 'token-optimizer');
  return (entry, payload) => {
    try {
      const result = spawnSync(
        HOOK_RUNTIME,
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
};

/**
 * OpenCode V1 entrypoint: the V1 hook-name map. OpenCode 2.x rejects this shape
 * outright ("Plugin must export a default definition with an id and an effect
 * or setup function"), so 2.x is served by a separate `setup` instead.
 */
export const TokenOptimizerPlugin = async ({ directory }) => {
  const invoke = createInvoke(directory);
  const pending = new Map();
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
