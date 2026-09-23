import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { WIRING } from '../hooks-core/wire.mjs';

const json = (path) => JSON.parse(readFileSync(path, 'utf8'));

/** Remove exact installer registrations only when an enabled installed plugin
 * demonstrably provides the same event and matcher. Unknown/custom hooks stay. */
export function dedupeClaudePluginHooks(settings, settingsPath) {
  const covered = new Set();
  try {
    const installed = json(
      join(dirname(settingsPath), 'plugins', 'installed_plugins.json')
    );
    for (const [id, enabled] of Object.entries(settings.enabledPlugins || {})) {
      if (enabled !== true || !id.startsWith('token-optimizer@')) continue;
      for (const entry of installed.plugins?.[id] || []) {
        if (entry.scope !== 'user' || typeof entry.installPath !== 'string')
          continue;
        const root = entry.installPath;
        if (
          json(join(root, '.claude-plugin', 'plugin.json')).name !==
          'token-optimizer'
        )
          continue;
        const manifest = json(join(root, 'hooks', 'hooks.json'));
        for (const { event, file, matcher } of WIRING) {
          if (!existsSync(join(root, 'hooks', file))) continue;
          if (
            (manifest.hooks?.[event] || []).some(
              (group) =>
                (group.matcher ?? null) === matcher &&
                group.hooks?.some(
                  (hook) =>
                    hook.type === 'command' &&
                    hook.command ===
                      `node "\${CLAUDE_PLUGIN_ROOT}/hooks/${file}"`
                )
            )
          )
            covered.add(event);
        }
      }
    }
  } catch {
    // Incomplete plugin metadata is not permission to remove a working hook.
    return { settings, removed: 0 };
  }
  let removed = 0;
  const hooks = { ...settings.hooks };
  for (const { event, file, matcher } of WIRING) {
    if (!covered.has(event) || !Array.isArray(hooks[event])) continue;
    hooks[event] = hooks[event].flatMap((group) => {
      if (
        !group ||
        (group.matcher ?? null) !== matcher ||
        !Array.isArray(group.hooks) ||
        Object.keys(group).some((key) => !['matcher', 'hooks'].includes(key))
      )
        return [group];
      const kept = group.hooks.filter((hook) => {
        if (
          !hook ||
          hook.type !== 'command' ||
          Object.keys(hook).some((key) => !['type', 'command'].includes(key))
        )
          return true;
        const match = String(hook.command).match(
          /^node "(.+[/\\]plugin[/\\]hooks[/\\]([^/\\]+))" --token-optimizer-hook$/
        );
        if (!match || match[2] !== file) return true;
        removed++;
        return false;
      });
      return kept.length ? [{ ...group, hooks: kept }] : [];
    });
    if (!hooks[event].length) delete hooks[event];
  }
  return { settings: removed ? { ...settings, hooks } : settings, removed };
}
