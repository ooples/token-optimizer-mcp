#!/usr/bin/env node
/** One proxy per CLI session: routing is configured before the client starts. */
import { spawn } from 'node:child_process';
import {
  readFileSync,
  existsSync,
  mkdtempSync,
  writeFileSync,
  unlinkSync,
  rmdirSync,
  chmodSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve, delimiter, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import TOML from '@iarna/toml';
import { startProxy, proxyEnabled } from '../dist/proxy/server.js';
import { captureDir, captureNotice } from '../dist/proxy/capture.js';
import { claudeRoute } from './claude-routing.mjs';
import { sessionRouting } from './session-routing.mjs';
import { claudeManagedRouting } from './managed-policy.mjs';
import { projectRootFor } from '../hooks-core/wiki.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const off = (value) => /^(0|false|no|off)$/i.test(value?.trim() || '');
const literal = (value) => JSON.stringify(value); // TOML basic strings accept JSON string escapes.
function option(args, names) {
  let value;
  for (let i = 0; i < args.length && args[i] !== '--'; i++) {
    if (names.includes(args[i])) value = args[++i];
    else
      for (const name of names)
        if (args[i]?.startsWith(`${name}=`))
          value = args[i].slice(name.length + 1);
  }
  return value;
}

export function executable(command, env) {
  if (process.platform !== 'win32') return { command, prefix: [] };
  const candidates = isAbsolute(command)
    ? [command]
    : (env.PATH || env.Path || '')
        .split(delimiter)
        .flatMap((dir) => [
          join(dir, `${command}.exe`),
          join(dir, `${command}.cmd`),
        ]);
  const path = candidates.find(existsSync);
  if (!path) throw new Error(`Cannot find ${command} on PATH.`);
  if (!path.endsWith('.cmd')) return { command: path, prefix: [] };
  // npm's standard shim is a known Node entrypoint. Do not pass user prompts
  // through cmd.exe; arbitrary batch wrappers are not safe to reconstruct.
  const shim = readFileSync(path, 'utf8');
  const native = shim.match(/"%dp0%\\([^"\r\n%]+\.exe)"\s+%\*/i);
  if (native) {
    const target = resolve(dirname(path), native[1]);
    if (!existsSync(target))
      throw new Error('The npm native launcher target is missing.');
    return { command: target, prefix: [] };
  }
  const match = shim.match(/"%dp0%\\([^"\r\n]+\.(?:js|mjs|cjs))"\s+%\*/i);
  if (!match)
    throw new Error(
      `Unsupported batch launcher ${path}; use a native executable or npm Node shim.`
    );
  return {
    command: process.execPath,
    prefix: [resolve(dirname(path), match[1])],
  };
}

function readConfig(path, parse) {
  try {
    return parse(readFileSync(path, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }
}

function merge(a, b) {
  for (const [key, value] of Object.entries(b)) {
    if (['__proto__', 'constructor', 'prototype'].includes(key))
      throw new Error('Unsafe configuration key.');
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      if (!a[key] || typeof a[key] !== 'object' || Array.isArray(a[key]))
        a[key] = {};
      merge(a[key], value);
    } else a[key] = value;
  }
  return a;
}

export function codexRoute(args, env) {
  const home = env.CODEX_HOME || join(homedir(), '.codex');
  args = args.slice(
    0,
    args.indexOf('--') < 0 ? args.length : args.indexOf('--')
  );
  let config = args.includes('--ignore-user-config')
    ? {}
    : readConfig(join(home, 'config.toml'), TOML.parse);
  const overrides = {};
  // Honor invocation overrides before deriving routing; never silently switch a
  // custom provider or auth method to OpenAI. Credentials remain in the client.
  for (let i = 0; i < args.length && args[i] !== '--'; i++) {
    const raw =
      args[i] === '-c' || args[i] === '--config'
        ? args[++i]
        : args[i].startsWith('--config=')
          ? args[i].slice(9)
          : args[i].startsWith('-c') && args[i].length > 2
            ? args[i].slice(2)
            : undefined;
    if (!raw) continue;
    let parsed;
    try {
      parsed = TOML.parse(raw);
    } catch {
      // Codex accepts unquoted values as strings when TOML parsing fails.
      const equals = raw.indexOf('=');
      if (equals <= 0) throw new Error('Invalid Codex configuration override.');
      parsed = TOML.parse(
        `${raw.slice(0, equals)}=${literal(raw.slice(equals + 1))}`
      );
    }
    merge(overrides, parsed);
  }
  const profile =
    option(args, ['-p', '--profile']) || overrides.profile || config.profile;
  if (profile) {
    if (typeof profile !== 'string' || !/^[A-Za-z0-9_.-]+$/.test(profile))
      throw new Error('Invalid Codex profile name.');
    const file = join(home, `${profile}.config.toml`);
    const layer = existsSync(file)
      ? readConfig(file, TOML.parse)
      : config.profiles?.[profile];
    if (!layer)
      throw new Error(
        `Cannot resolve Codex profile ${profile}; provider settings were left unchanged.`
      );
    config = merge(config, layer);
  }
  merge(config, overrides);
  const id = config.model_provider || 'openai';
  const provider = { ...config.model_providers?.[id] };
  let upstream = provider.base_url;
  if (id === 'openai') {
    // Inspect only the login mode; no key is copied into configuration or logs.
    const auth = readConfig(join(home, 'auth.json'), JSON.parse);
    upstream ||= config.openai_base_url || env.OPENAI_BASE_URL;
    if (!upstream) {
      const chatgpt = auth.auth_mode === 'chatgpt' || !!auth.tokens;
      const api =
        !!env.OPENAI_API_KEY ||
        !!env.CODEX_API_KEY ||
        !!auth.OPENAI_API_KEY ||
        ['apikey', 'api_key'].includes(auth.auth_mode);
      // Credentials can live exclusively in a keyring, or login may occur after
      // launch. Guessing the account type can send traffic to the wrong API.
      if (!chatgpt && !api) return { native: true };
      upstream = chatgpt
        ? 'https://chatgpt.com/backend-api/codex'
        : 'https://api.openai.com/v1';
    }
    provider.requires_openai_auth ??= true;
  }
  if (!upstream)
    throw new Error(
      `Cannot determine upstream for Codex provider ${id}; configure its base_url.`
    );
  provider.name ||= id;
  provider.wire_api ||= 'responses';
  if (provider.wire_api !== 'responses')
    throw new Error('The managed Codex proxy requires the Responses API.');
  return { upstream, provider, id };
}

export async function runClient(
  client,
  args,
  { env = process.env, command = client } = {}
) {
  if (!['claude', 'codex', 'opencode'].includes(client))
    throw new Error(
      'Managed launch currently supports claude, codex and opencode.'
    );
  const childEnv = { ...env };
  childEnv.TOKEN_OPTIMIZER_CLIENT =
    client === 'claude' ? 'claude-code' : client;
  let proxy;
  let routing;
  let settingsDirectory;
  let settingsPath;
  let child;
  let forwarded = [...args];
  const switches = args.slice(
    0,
    args.indexOf('--') < 0 ? args.length : args.indexOf('--')
  );
  const management =
    [
      'login',
      'logout',
      'mcp',
      'plugin',
      'plugins',
      'features',
      'completion',
      'update',
      'install',
      'uninstall',
      'help',
      'doctor',
      'app',
      'app-server',
      'remote-control',
      'agents',
      'queue',
      'archive',
      'delete',
      'unarchive',
      'migrate-rollouts',
      'sandbox',
      'debug',
      'auth',
      'models',
      'upgrade',
      'attach',
      'apply',
      'a',
      'cloud',
      'exec-server',
    ].includes(args[0]) ||
    switches.some((arg) => ['--help', '-h', '--version', '-V'].includes(arg));
  const claude =
    client === 'claude' && !management && proxyEnabled(env)
      ? claudeRoute(args, env, process.cwd())
      : undefined;
  const externalRouting =
    (client === 'codex' &&
      (switches.includes('--oss') ||
        option(args, ['--local-provider', '--remote']))) ||
    claude?.external ||
    (claude && (await claudeManagedRouting()));
  const enabled =
    client !== 'opencode' &&
    !management &&
    !externalRouting &&
    proxyEnabled(env);
  if (!management && externalRouting && proxyEnabled(env))
    process.stderr.write(
      '[token-optimizer] Provider mode or locally managed routing policy retains native routing; session proxy routing is unavailable.\n'
    );
  // -C/--cd changes Codex's project independently of the shell working directory.
  const directory =
    client === 'codex' ? option(args, ['-C', '--cd']) : undefined;
  const projectRoot = directory ? resolve(directory) : process.cwd();
  try {
    if (
      client === 'opencode' &&
      !management &&
      env.TOKEN_OPTIMIZER_MODE?.trim().toLowerCase() !== 'off'
    ) {
      const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT || '{}');
      if (!config || typeof config !== 'object' || Array.isArray(config))
        throw new Error('OpenCode inline configuration must be an object.');
      if (!off(env.TOKEN_OPTIMIZER_MANAGED_MCP)) {
        config.mcp = {
          ...config.mcp,
          'token-optimizer': {
            type: 'local',
            command: [process.execPath, join(root, 'dist/server/index.js')],
            enabled: true,
          },
        };
      }
      if (proxyEnabled(env)) {
        const plugin = pathToFileURL(
          join(root, 'scripts/opencode-plugin.mjs')
        ).href;
        config.plugin = [
          ...(config.plugin || []).filter((value) => value !== plugin),
          plugin,
        ];
      }
      childEnv.OPENCODE_CONFIG_CONTENT = JSON.stringify(config);
    }
    if (enabled) {
      const route = client === 'codex' ? codexRoute(args, env) : claude;
      if (route.native) {
        process.stderr.write(
          '[token-optimizer] Account routing cannot be determined before launch (login/keyring); preserving native routing. MCP remains available.\n'
        );
      } else {
        const upstream = new URL(route.upstream);
        if (
          upstream.username ||
          upstream.password ||
          upstream.search ||
          upstream.hash
        )
          throw new Error(
            'Provider base URLs with credentials, query parameters, or fragments cannot be routed without changing their semantics.'
          );
        const selectsWorktree = switches.some(
          (arg) =>
            arg === '--worktree' ||
            arg.startsWith('--worktree=') ||
            (client === 'claude' && arg.startsWith('-w'))
        );
        routing = sessionRouting(client);
        proxy = await startProxy({
          upstream: upstream.origin,
          projectRoot: projectRootFor(
            join(projectRoot, '__session__'),
            projectRoot
          ),
          knowledge: !selectsWorktree,
          onSummary: routing.observe,
        });
        if (selectsWorktree)
          process.stderr.write(
            '[token-optimizer] Graph injection is disabled for this session because the client selects its worktree after launch.\n'
          );
        if (captureDir(env))
          process.stderr.write(`${captureNotice(captureDir(env))}\n`);
        const base = `http://127.0.0.1:${proxy.port}${upstream.pathname.replace(/\/$/, '')}${upstream.search}`;
        if (client === 'claude') {
          childEnv.ANTHROPIC_BASE_URL = base;
          if (claude.preserveToolSearch) childEnv.ENABLE_TOOL_SEARCH = 'true';
          // File-based env entries override shell exports in Claude. A private,
          // per-invocation overlay preserves explicit CLI settings and changes
          // only the transport URL. Never put settings/credentials in argv.
          settingsDirectory = mkdtempSync(
            join(tmpdir(), 'token-optimizer-client-')
          );
          chmodSync(settingsDirectory, 0o700);
          settingsPath = join(settingsDirectory, 'settings.json');
          writeFileSync(
            settingsPath,
            JSON.stringify({
              ...claude.explicit,
              env: { ...claude.explicit.env, ANTHROPIC_BASE_URL: base },
            }),
            { mode: 0o600 }
          );
          if (claude.settings)
            forwarded[claude.settings.index] = claude.settings.inline
              ? `--settings=${settingsPath}`
              : settingsPath;
          else forwarded.push('--settings', settingsPath);
        } else {
          childEnv.OPENAI_BASE_URL = base;
          // Override only transport properties. Keep credentials and custom
          // headers in their original config, never in the process argument list.
          if (!/^[A-Za-z0-9_-]+$/.test(route.id))
            throw new Error(
              'Codex provider IDs containing dots or quotes cannot be overridden safely.'
            );
          const sessionProvider = `token_optimizer_session_${proxy.port}`;
          const section = `model_providers.${route.id === 'openai' ? sessionProvider : route.id}`;
          const overrides = [
            '-c',
            `${section}.base_url=${literal(base)}`,
            '-c',
            `${section}.supports_websockets=false`,
          ];
          if (route.id === 'openai')
            overrides.push(
              '-c',
              `model_provider=${literal(sessionProvider)}`,
              '-c',
              `${section}.name=${literal(route.provider.name)}`,
              '-c',
              `${section}.wire_api="responses"`,
              '-c',
              `${section}.requires_openai_auth=${route.provider.requires_openai_auth}`
            );
          forwarded = [...forwarded, ...overrides];
        }
        process.stderr.write(
          `[token-optimizer] ${client}: session proxy listening; awaiting model traffic; project ${projectRoot}\n`
        );
      }
    }
    if (
      client !== 'opencode' &&
      !management &&
      env.TOKEN_OPTIMIZER_MODE?.trim().toLowerCase() !== 'off' &&
      !off(env.TOKEN_OPTIMIZER_MANAGED_MCP)
    ) {
      if (client === 'codex') {
        forwarded.push(
          '-c',
          `mcp_servers.token-optimizer.command=${literal(process.execPath)}`,
          '-c',
          `mcp_servers.token-optimizer.args=[${literal(join(root, 'dist/server/index.js'))}]`,
          '-c',
          'mcp_servers.token-optimizer.startup_timeout_sec=60'
        );
      } else {
        forwarded.push(
          '--mcp-config',
          JSON.stringify({
            mcpServers: {
              'token-optimizer': {
                command: process.execPath,
                args: [join(root, 'dist/server/index.js')],
              },
            },
          })
        );
      }
    }
    // No shell string: user prompts, quotes and metacharacters stay argv data.
    // CLI flags must precede an explicit end-of-options delimiter.
    const delimiterIndex = args.indexOf('--');
    if (delimiterIndex >= 0) {
      const additions = forwarded.slice(args.length);
      forwarded = [
        ...forwarded.slice(0, delimiterIndex),
        ...additions,
        ...forwarded.slice(delimiterIndex, args.length),
      ];
    }
    const target = executable(command, env);
    child = spawn(target.command, [...target.prefix, ...forwarded], {
      env: childEnv,
      stdio: 'inherit',
      windowsHide: true,
    });
    const stop = (signal) => {
      child.kill(signal);
    };
    const interrupt = () => stop('SIGINT');
    const terminate = () => stop('SIGTERM');
    process.on('SIGINT', interrupt);
    process.on('SIGTERM', terminate);
    try {
      return await new Promise((resolveExit, reject) => {
        child.once('error', reject);
        child.once('exit', (code, signal) =>
          resolveExit(code ?? (signal === 'SIGINT' ? 130 : 1))
        );
      });
    } finally {
      process.off('SIGINT', interrupt);
      process.off('SIGTERM', terminate);
    }
  } finally {
    if (proxy) {
      const closed = new Promise((resolveClose) =>
        proxy.server.close(resolveClose)
      );
      proxy.server.closeAllConnections?.();
      await closed;
      routing.finish();
    }
    if (settingsPath && existsSync(settingsPath)) unlinkSync(settingsPath);
    if (settingsDirectory) rmdirSync(settingsDirectory);
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const [client, ...args] = process.argv.slice(2);
  runClient(client, args).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      process.stderr.write(`[token-optimizer] ${error.message}\n`);
      process.exitCode = 1;
    }
  );
}
