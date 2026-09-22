import {
  startProxy,
  proxyEnabled,
  upstreamIsSafe,
} from '../dist/proxy/server.js';
import { sessionRouting } from './session-routing.mjs';
import { projectRootFor } from '../hooks-core/wiki.mjs';
import { join } from 'node:path';
import { originalUpstream } from '../dist/proxy/default-routing.js';
const configured = new WeakSet();

/** OpenCode owns resolved configuration and project scope. Do not monkey-patch
 * global fetch, read account secrets, or rewrite the user's provider files.
 */
export default async function tokenOptimizer({ directory }) {
  const proxies = new Map();
  const localBases = new Set();
  const supported = new Set([
    '@ai-sdk/openai',
    '@ai-sdk/openai-compatible',
    '@ai-sdk/anthropic',
  ]);
  const close = async () => {
    for (const { proxy, routing } of proxies.values()) {
      proxy.server.closeAllConnections?.();
      await new Promise((resolve) => proxy.server.close(resolve));
      routing.finish();
    }
    proxies.clear();
  };
  return {
    async config(config) {
      if (!proxyEnabled() || configured.has(config)) return;
      for (const provider of Object.values(config.provider || {})) {
        if (!supported.has(provider.npm)) continue;
        const targets = [
          provider.options,
          ...Object.values(provider.models || {}).map((model) => model.options),
        ];
        for (const options of targets) {
          if (
            !options ||
            typeof options.baseURL !== 'string' ||
            localBases.has(options.baseURL)
          )
            continue;
          let url;
          try {
            url = new URL(originalUpstream(options.baseURL));
          } catch {
            continue;
          }
          if (
            !upstreamIsSafe(url.origin) ||
            url.username ||
            url.password ||
            url.search ||
            url.hash
          )
            continue;
          let entry = proxies.get(url.origin);
          if (!entry) {
            const routing = sessionRouting('opencode');
            const proxy = await startProxy({
              upstream: url.origin,
              projectRoot: projectRootFor(
                join(directory, '__session__'),
                directory
              ),
              onSummary: routing.observe,
            });
            proxy.server.unref();
            entry = { proxy, routing };
            proxies.set(url.origin, entry);
          }
          options.baseURL = `http://127.0.0.1:${entry.proxy.port}${url.pathname.replace(/\/$/, '')}`;
          localBases.add(options.baseURL);
        }
      }
      configured.add(config);
      process.stderr.write(
        proxies.size
          ? '[token-optimizer] opencode: configured provider proxies listening; awaiting model traffic.\n'
          : '[token-optimizer] opencode: no supported explicit provider endpoints; model routing remains native.\n'
      );
    },
    dispose: close,
  };
}
