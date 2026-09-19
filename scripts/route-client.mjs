#!/usr/bin/env node
/**
 * `token-optimizer-route` -- see what is routed, and opt a client in by hand.
 *
 * WHY A COMMAND AND NOT MORE AUTOMATION. Ten clients are routed for you, because each one either has
 * a single provider or already names its endpoint somewhere we can read. Zed is the one client that
 * can be routed and cannot be routed automatically: its assistant is configured inside the editor,
 * an OpenAI-compatible provider there is a named entry the user selects in the UI, and both the
 * endpoint and the model list are things only they know. Guessing either would add a provider that
 * silently returns nothing, or -- worse -- send their credentials somewhere they did not choose.
 *
 * So Zed is opt-in, and opting in means telling us the two things we cannot know.
 *
 * ZED'S SCHEMA HERE IS DOCUMENTED, NOT VERIFIED -- the same distinction the harvest and proxy tables
 * draw, for the same reason. It comes from Zed's published settings documentation and has not been
 * exercised against an installed Zed in this repository. If it is wrong it fails visibly, in a file
 * this command can take back out, rather than by quietly routing nothing.
 */

import {
  existsSync,
  copyFileSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  readRoutingManifest,
  routingManifestFile,
  claudeSettingsFile,
} from '../dist/proxy/default-routing.js';
import {
  controlPort,
  ensureRoute,
  supervisorHealth,
} from '../dist/proxy/supervisor.js';

const PROVIDER = 'token-optimizer';

/**
 * `token-optimizer-route orcarouter` -- the two ways into the OrcaRouter provider, from a terminal.
 *
 * WHY A COMMAND AND NOT ONLY THE DASHBOARD. A user on a machine where the dashboard is not running
 * still needs both choices. `--connect` runs the OAuth 2.0 + PKCE flow (a browser, then a key), and
 * the key can equally be pasted into `ORCAROUTER_API_KEY` or saved from the dashboard. All three end
 * at the same credential store and the same provider, which is the point of the seam.
 *
 * NOTHING HERE PRINTS A KEY. `--status` shows the redacted form, the origins in use, and the two
 * provider ids; the connect flow reports the account and the granted scope, never the credential.
 */
async function routeOrcaRouter(args) {
  const {
    ApiKeyCredentialAdapter,
    PkceCredentialAdapter,
    ORCA_KEY_DASHBOARD_URL,
  } = await import('../dist/orcarouter/credentials.js');
  const { OrcaConnectManager } = await import('../dist/orcarouter/connect.js');
  const { resolveOrigins } = await import('../dist/orcarouter/endpoints.js');
  const { discoverModels } = await import('../dist/orcarouter/provider.js');

  const origins = resolveOrigins();

  if (args.includes('--status') || args.length === 0) {
    const apiAdapter = new ApiKeyCredentialAdapter();
    const pkceAdapter = new PkceCredentialAdapter();
    const api = await apiAdapter.status();
    const pkce = await pkceAdapter.status();
    console.log(`auth origin: ${origins.authBase}`);
    console.log(`api origin:  ${origins.apiBase}`);
    console.log('');
    console.log(`  ${apiAdapter.label} (${apiAdapter.id})`);
    console.log(
      `    ${api.configured ? `configured: ${api.masked}` : 'not configured -- paste a key in the dashboard, or set ORCAROUTER_API_KEY'}`
    );
    console.log(`  ${pkceAdapter.label} (${pkceAdapter.id})`);
    console.log(
      `    ${pkce.configured ? `configured: ${pkce.masked} (account ${pkce.accountId})` : 'not configured -- run: token-optimizer-route orcarouter --connect'}`
    );
    console.log('');
    console.log(`manage or revoke keys: ${ORCA_KEY_DASHBOARD_URL}`);
    return 0;
  }

  if (args.includes('--clear')) {
    const removed = [
      (await new ApiKeyCredentialAdapter().clear()) ? 'api key' : null,
      (await new PkceCredentialAdapter().clear()) ? 'authorization' : null,
    ].filter(Boolean);
    console.log(
      removed.length
        ? `removed the stored OrcaRouter ${removed.join(' and ')}.`
        : 'nothing was stored, so nothing was removed.'
    );
    return 0;
  }

  if (args.includes('--models')) {
    const result = await discoverModels({ capability: 'chat' });
    console.log(`catalog: ${result.status} (${result.sourceUrl})`);
    if (result.degradedReason) console.log(`reason:  ${result.degradedReason}`);
    for (const model of result.models) {
      const meta = [
        model.contextLength
          ? `${Math.round(model.contextLength / 1000)}k`
          : null,
        model.inputModalities.filter((m) => m !== 'text').join('+') || null,
        model.fromSeed ? 'verified fallback' : null,
      ].filter(Boolean);
      console.log(
        `  ${model.id}${meta.length ? `  (${meta.join(', ')})` : ''}`
      );
    }
    return 0;
  }

  if (args.includes('--connect')) {
    const mode = args.includes('--oob') ? 'oob' : 'loopback';
    const manager = new OrcaConnectManager();
    const started = await manager.start({ mode, origins });
    console.log('Open this URL to authorize OrcaRouter:\n');
    console.log(`  ${started.authorizeUrl}\n`);
    if (mode === 'loopback') {
      console.log('Waiting for approval in the browser...');
    } else {
      console.log('Paste the code shown on that page:');
      const { createInterface } = await import('node:readline/promises');
      const rl = createInterface({
        input: process.stdin,
        output: process.stdout,
      });
      const code = await rl.question('Code: ');
      rl.close();
      manager.submitCode(started.attemptId, code);
    }
    try {
      const outcome = await manager.complete(started.attemptId);
      if (!manager.mayInstall(started.attemptId)) {
        console.error(
          'That attempt was cancelled before it finished, so nothing was stored.'
        );
        return 1;
      }
      const saved = await new PkceCredentialAdapter().save(outcome.key, {
        accountId: outcome.accountId,
        scope: outcome.scope,
      });
      console.log(`\nConnected as account ${saved.accountId}.`);
      if (outcome.scopeDowngraded) {
        console.log(
          `Note: the workspace granted "${outcome.scope || 'a narrower scope'}" rather than "api".`
        );
      }
      console.log(
        'Select a model with TOKEN_OPTIMIZER_ORCA_MODEL, or in the dashboard.'
      );
      return 0;
    } catch (error) {
      console.error(`\n${error?.message || error}`);
      return 1;
    } finally {
      manager.cancelAll();
    }
  }

  console.error(
    'usage: token-optimizer-route orcarouter [--status | --connect [--oob] | --clear | --models]'
  );
  return 2;
}

/**
 * Zed's settings file.
 *
 * Windows placement is checked rather than assumed: Zed has shipped both `%APPDATA%\Zed` and
 * `%LOCALAPPDATA%\Zed`, and writing a second settings file next to the real one would look like the
 * command did nothing.
 */
export function zedSettingsFile(env = process.env) {
  if (env.TOKEN_OPTIMIZER_ZED_SETTINGS) return env.TOKEN_OPTIMIZER_ZED_SETTINGS;
  const candidates =
    process.platform === 'win32'
      ? [
          join(
            env.APPDATA || join(homedir(), 'AppData', 'Roaming'),
            'Zed',
            'settings.json'
          ),
          join(
            env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'),
            'Zed',
            'settings.json'
          ),
        ]
      : [join(homedir(), '.config', 'zed', 'settings.json')];
  return candidates.find(existsSync) || candidates[0];
}

function option(args, name) {
  const index = args.indexOf(`--${name}`);
  if (index >= 0) return args[index + 1];
  const inline = args.find((arg) => arg.startsWith(`--${name}=`));
  return inline ? inline.slice(name.length + 3) : undefined;
}

function loadZed(path) {
  if (!existsSync(path)) return {};
  const text = readFileSync(path, 'utf8');
  try {
    return JSON.parse(text);
  } catch (error) {
    // Zed's settings file accepts comments and trailing commas, which JSON.parse does not. Rewriting
    // it through a parser that does not understand them would delete the user's comments, so a file
    // we cannot read exactly is a file we refuse to write.
    throw new Error(
      `${path} is not plain JSON, so it will not be modified (${error.message}). ` +
        'Add the provider block by hand, or remove comments and trailing commas and run this again.'
    );
  }
}

/** The manifest lives under our own home, which may not exist yet on a first run. */
function writeManifest(manifest) {
  const file = routingManifestFile();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
}

function saveZed(path, settings) {
  if (existsSync(path)) {
    try {
      copyFileSync(path, `${path}.before-token-optimizer`);
    } catch {
      /* a failed backup is not a reason to refuse a reversible change */
    }
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`);
}

async function status() {
  const health = await supervisorHealth();
  console.log(`control port: ${controlPort()}`);
  if (!health?.ok) {
    console.log(
      'background proxy: not running (it starts itself at the next client session)'
    );
  } else {
    console.log(`background proxy: running as pid ${health.pid}`);
    for (const route of health.routes || [])
      console.log(`  ${route.upstream} -> ${route.url}`);
    if (!(health.routes || []).length)
      console.log('  (no upstream routed yet)');
  }
  const entries = readRoutingManifest().entries;
  const paths = Object.keys(entries);
  console.log(`\nconfiguration we have written (${routingManifestFile()}):`);
  if (!paths.length)
    console.log('  nothing; no client configuration has been changed');
  for (const path of paths) {
    const entry = entries[path];
    console.log(`  ${path}`);
    console.log(
      `    ${entry.variable || entry.provider} = ${entry.value} (for ${entry.upstream})`
    );
  }
  console.log(`\nClaude Code settings file: ${claudeSettingsFile()}`);
  return 0;
}

async function routeZed(args) {
  const path = zedSettingsFile();
  const remove = args.includes('--remove');
  const settings = loadZed(path);
  const manifest = readRoutingManifest();

  if (remove) {
    const models = settings.language_models?.openai_compatible;
    if (!models || !models[PROVIDER]) {
      console.log(`No ${PROVIDER} provider in ${path}; nothing to remove.`);
      return 0;
    }
    delete models[PROVIDER];
    if (!Object.keys(models).length)
      delete settings.language_models.openai_compatible;
    if (
      settings.language_models &&
      !Object.keys(settings.language_models).length
    )
      delete settings.language_models;
    saveZed(path, settings);
    delete manifest.entries[path];
    writeManifest(manifest);
    console.log(`Removed the ${PROVIDER} provider from ${path}.`);
    return 0;
  }

  const upstream = option(args, 'upstream');
  const model = option(args, 'model');
  if (!upstream || !model) {
    console.error(
      'usage: token-optimizer-route zed --upstream <provider base url> --model <model id>\n' +
        '\n' +
        'Both are required and neither can be guessed: the upstream decides which company\n' +
        'receives your credentials, and Zed shows no models for a provider that does not list\n' +
        'them. Use the endpoint and model you already use in Zed today.'
    );
    return 2;
  }

  const url = await ensureRoute(upstream);
  if (!url) {
    console.error(
      `The compression proxy could not serve ${upstream}, so ${path} was left unchanged. ` +
        'Nothing is written until the route is actually being served.'
    );
    return 1;
  }

  settings.language_models = settings.language_models || {};
  settings.language_models.openai_compatible =
    settings.language_models.openai_compatible || {};
  settings.language_models.openai_compatible[PROVIDER] = {
    api_url: `${url}/v1`,
    available_models: [
      {
        name: model,
        display_name: `${model} (compressed)`,
        max_tokens: 200000,
      },
    ],
  };
  saveZed(path, settings);
  manifest.entries[path] = {
    provider: PROVIDER,
    value: `${url}/v1`,
    upstream,
    writtenAt: new Date().toISOString(),
  };
  writeManifest(manifest);
  console.log(
    `Added the ${PROVIDER} provider to ${path}.\n` +
      `Restart Zed and choose "${PROVIDER}" in its assistant settings.\n` +
      'Remove it again with: token-optimizer-route zed --remove'
  );
  return 0;
}

export async function run(argv = process.argv.slice(2)) {
  const [command, ...rest] = argv;
  try {
    if (!command || command === 'status') return await status();
    if (command === 'zed') return await routeZed(rest);
    if (command === 'orcarouter') return await routeOrcaRouter(rest);
  } catch (error) {
    // A refusal is an outcome, not a crash. loadZed throws to stop a file being rewritten through a
    // parser that cannot read it, and the caller needs the reason and a status, the same as the CLI.
    console.error(`[token-optimizer] ${error?.message || error}`);
    return 1;
  }
  console.error(
    'usage: token-optimizer-route [status | zed --upstream <url> --model <id> | ' +
      'orcarouter [--connect [--oob] | --status | --clear | --models]]'
  );
  return 2;
}

// Only when run as a command, so the pieces above stay importable by tests.
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  run().then((code) => {
    process.exitCode = code;
  });
}
