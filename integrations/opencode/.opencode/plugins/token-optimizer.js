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

// LEGACY CUT. scripts/generate-opencode-legacy-plugin.mjs copies everything
// above this line to
// integrations/opencode/legacy/.opencode/plugins/token-optimizer.js.
// OpenCode 1.3.3 and earlier call EVERY export as a plugin function, so the
// default object below makes them fail to load the whole file, while OpenCode
// 2.x accepts nothing but that object. No one module satisfies both loaders.

/**
 * OpenCode V2 entrypoint. V2 loads plugins from a default export with an `id`
 * and a `setup(ctx)` that registers hooks through the V2 hook domains
 * (`session.hook` / `tool.hook`) instead of returning a hook-name
 * map. `server` serves OpenCode 1.3.4 and later 1.x releases, which read a
 * default `{ id, server }` object, so this file serves both plugin APIs from
 * the same hook logic.
 *
 * V1 hook -> V2 hook mapping:
 *   experimental.chat.system.transform -> session.hook('context')
 *   tool.execute.before                -> tool.hook('execute.before')
 *   tool.execute.after                 -> tool.hook('execute.after')
 *   experimental.session.compacting    -> session.hook('compaction')
 */
export default {
  id: 'token-optimizer',
  server: TokenOptimizerPlugin,
  async setup(ctx) {
    const directory = ctx.location.directory;
    const invoke = createInvoke(directory);
    const pending = new Map();
    const payloadFor = (event, toolInput) => ({
      session_id: event.sessionID || 'default',
      cwd: directory,
      tool_name: event.tool,
      tool_input: toolInput || {},
    });

    // V1 experimental.chat.system.transform: inject the session-start policy
    // into every agent-loop model request.
    await ctx.session.hook('context', (event) => {
      const result = invoke('session-start', {});
      const policy = result?.hookSpecificOutput?.additionalContext;
      if (policy) event.system.push({ type: 'text', text: policy });
    });

    // V1 tool.execute.before: deny oversized reads before they run and
    // remember the pre-tool context for the matching execute.after.
    await ctx.tool.hook('execute.before', async (event) => {
      const shared = invoke('pre-tool', payloadFor(event, event.input));
      const hook = shared?.hookSpecificOutput;
      if (hook?.permissionDecision === 'deny') {
        throw new Error(hook.permissionDecisionReason);
      }
      pending.set(event.id, {
        context: hook?.additionalContext || '',
        input: event.input,
      });
    });

    // V1 tool.execute.after: append the captured context and the post-tool
    // graph knowledge to the tool result the model actually receives. V2
    // distinguishes completed from failed calls; a failed call has no result
    // to append to, so the graph context is dropped there instead of crashing.
    await ctx.tool.hook('execute.after', async (event) => {
      const parts = [];
      const prior = pending.get(event.id);
      pending.delete(event.id);
      if (prior?.context) parts.push(prior.context);

      if (/^(?:edit|write|apply_patch|replace)$/i.test(event.tool)) {
        const result = invoke(
          'post-tool',
          payloadFor(event, prior?.input ?? event.input)
        );
        const context = result?.hookSpecificOutput?.additionalContext;
        if (context) parts.push(context);
      }
      if (parts.length && event.status === 'completed') {
        const appended = `[Token Optimizer graph]\n${parts.join('\n\n')}`.trim();
        const content = event.result.content;
        if (typeof content === 'string') {
          event.result.content = `${content}\n\n${appended}`.trim();
        } else if (Array.isArray(content)) {
          event.result.content = [...content, { type: 'text', text: appended }];
        } else {
          event.result.content = appended;
        }
      }
    });

    // V1 experimental.session.compacting: keep the optimizer state guidance
    // in the compaction summary request.
    await ctx.session.hook('compaction', (event) => {
      event.system.push({ type: 'text', text: compactionGuidance });
    });
  },
};
