/**
 * The OrcaRouter provider API for the dashboard.
 *
 * SERVER-SIDE BY DESIGN, for the same reason the wiki graph is: the browser must never hold an
 * OrcaRouter key. A key stored here is billed to the user and can be revoked by them, and a key in
 * page memory is a key in a devtools console, a screenshot, and any error reporter that instruments
 * the page. So the dashboard posts a secret in, and reads back a redacted status plus the model list.
 * There is no route that returns a stored key, and that is deliberate rather than an omission.
 *
 * THE LOGIN LOCK IS SERVER-SIDE, and every terminal path releases it: success, denial, exchange
 * error, timeout, an explicit cancel, a switch of authentication method, a closed modal, an unmount,
 * a reload, a window close and `pagehide`. `OrcaConnectManager` holds at most one live attempt and
 * its `cancel` closes the listener and rejects the pending promise; the `pagehide` route is the one
 * a client calls with `keepalive` on the way out, and the browser's own busy flag is cleared in that
 * handler rather than in a `finally` that the generation guard will refuse to run.
 *
 * NOTHING HERE LOGS A SECRET. Errors carry a kind and a status; the key, the code and the verifier
 * never enter a message, and the only place a key is rendered is `redactKey`.
 */

import type { Express, Request, Response } from 'express';
import { resolveOrigins } from '../orcarouter/endpoints.js';
import {
  ApiKeyCredentialAdapter,
  PkceCredentialAdapter,
  apiKeyAdapter,
  pkceAdapter,
  ORCA_KEY_DASHBOARD_URL,
} from '../orcarouter/credentials.js';
import {
  OrcaConnectManager,
  OrcaConnectError,
  type ConnectMode,
} from '../orcarouter/connect.js';
import {
  CATALOG_TIMEOUT_MS,
  type CatalogCapability,
  type InputModality,
} from '../orcarouter/catalog.js';
import { discoverModels, resolveProvider } from '../orcarouter/provider.js';

/**
 * One manager for the life of the server.
 *
 * A per-request manager would lose the attempt the moment the response was written, which is exactly
 * the state a cancel and a `pagehide` need to reach.
 */
const connectManager = new OrcaConnectManager();

export function orcaConnectManager(): OrcaConnectManager {
  return connectManager;
}

const CAPABILITIES: readonly CatalogCapability[] = [
  'chat',
  'embedding',
  'image',
  'video',
  'rerank',
];

const MODALITIES: readonly InputModality[] = [
  'text',
  'image',
  'audio',
  'video',
];

function capabilityFrom(value: unknown): CatalogCapability {
  const text = String(value ?? 'chat');
  return (CAPABILITIES as readonly string[]).includes(text)
    ? (text as CatalogCapability)
    : 'chat';
}

function modalityFrom(value: unknown): InputModality | undefined {
  const text = String(value ?? '');
  return (MODALITIES as readonly string[]).includes(text)
    ? (text as InputModality)
    : undefined;
}

function connectModeFrom(value: unknown): ConnectMode {
  return String(value ?? 'loopback') === 'oob' ? 'oob' : 'loopback';
}

/**
 * The shape the provider card renders.
 *
 * Both adapters are always present with their own status, so the two choices are visibly independent:
 * a user with no key sees Connect available, a user with no browser sees the key field usable, and a
 * user with both sees which one is currently supplying inference.
 */
async function providerStatus(env: NodeJS.ProcessEnv): Promise<{
  ready: boolean;
  activeSource: string | null;
  masked: string;
  accountId: string | null;
  scope: string | null;
  dashboardUrl: string;
  origins: { authBase: string; apiBase: string };
  adapters: Array<{
    id: string;
    label: string;
    source: string;
    configured: boolean;
    active: boolean;
    masked: string;
    accountId: string | null;
  }>;
}> {
  const provider = await resolveProvider(env);
  const adapters = await Promise.all(
    [apiKeyAdapter, pkceAdapter].map(async (adapter) => {
      const status = await adapter.status(env);
      return {
        id: adapter.id,
        label: adapter.label,
        source: adapter.source,
        configured: status.configured,
        active: status.active,
        masked: status.masked,
        accountId: status.accountId,
      };
    })
  );
  return {
    ready: provider.ready,
    activeSource: provider.credential?.source ?? null,
    // Redacted always. The dashboard shows which key is in use, never the key.
    masked: adapters.find((entry) => entry.active)?.masked ?? '',
    accountId: provider.credential?.accountId ?? null,
    scope: provider.credential?.scope ?? null,
    dashboardUrl: ORCA_KEY_DASHBOARD_URL,
    origins: {
      authBase: provider.origins.authBase,
      apiBase: provider.origins.apiBase,
    },
    adapters,
  };
}

export function registerOrcaRouterRoutes(app: Express): void {
  app.get('/api/orcarouter/status', async (_req: Request, res: Response) => {
    res.json(await providerStatus(process.env));
  });

  /**
   * Store a pasted key.
   *
   * The response is the redacted status, never the key that was sent, so a caller cannot echo it back
   * into a log by accident.
   */
  app.post('/api/orcarouter/key', async (req: Request, res: Response) => {
    const key = (req.body as { key?: unknown } | undefined)?.key;
    try {
      await new ApiKeyCredentialAdapter().save(String(key ?? ''));
    } catch (error) {
      return res.status(400).json({
        error: error instanceof Error ? error.message : 'Invalid key.',
      });
    }
    return res.json(await providerStatus(process.env));
  });

  app.delete('/api/orcarouter/key', async (_req: Request, res: Response) => {
    await apiKeyAdapter.clear();
    res.json(await providerStatus(process.env));
  });

  /** The other adapter's clear, so each choice can be removed independently. */
  app.delete(
    '/api/orcarouter/connect',
    async (_req: Request, res: Response) => {
      await new PkceCredentialAdapter().clear();
      res.json(await providerStatus(process.env));
    }
  );

  /**
   * Start a login.
   *
   * Returns the URL to open and the attempt id. Nothing is stored: a credential only appears after a
   * successful exchange, so an abandoned login leaves no half-state behind.
   */
  app.post('/api/orcarouter/connect', async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    try {
      const started = await connectManager.start({
        mode: connectModeFrom(body.mode),
        origins: resolveOrigins(process.env),
        loginHint:
          typeof body.loginHint === 'string' ? body.loginHint : undefined,
      });
      res.json({
        attemptId: started.attemptId,
        mode: started.mode,
        authorizeUrl: started.authorizeUrl,
        redirectUri: started.redirectUri,
        appName: 'Token Optimizer MCP',
        scope: 'api',
      });
    } catch (error) {
      res.status(502).json({
        error:
          error instanceof Error
            ? error.message
            : 'Could not start the OrcaRouter connection.',
      });
    }
  });

  /**
   * Wait for approval and exchange the code.
   *
   * Runs in the request, so the browser's own fetch is the thing that waits. A client that goes away
   * must therefore call the cancel route -- which is what `pagehide` does with `keepalive`, because a
   * request the browser aborts on unload is not reliably delivered without it.
   */
  app.post(
    '/api/orcarouter/connect/:attemptId/complete',
    async (req: Request, res: Response) => {
      const attemptId = String(req.params.attemptId);
      try {
        const outcome = await connectManager.complete(attemptId);
        // The guard runs AFTER the exchange, so it covers both ways an attempt stops being the
        // current one: an explicit cancel, and a newer attempt having started while this one waited.
        // A credential from an attempt the user replaced must not be installed.
        if (!connectManager.mayInstall(attemptId)) {
          return res.status(409).json({
            error: 'That login attempt was superseded or cancelled.',
            kind: 'cancelled',
          });
        }
        const saved = await pkceAdapter.save(outcome.key, {
          accountId: outcome.accountId,
          scope: outcome.scope,
        });
        return res.json({
          status: await providerStatus(process.env),
          scope: saved.scope,
          scopeDowngraded: outcome.scopeDowngraded,
          accountId: saved.accountId,
        });
      } catch (error) {
        const kind =
          error instanceof OrcaConnectError ? error.kind : 'exchange-failed';
        // A user-caused outcome is not a gateway failure: a denial and a state mismatch are 403s, a
        // superseded attempt is a 409, and only a genuine upstream problem is a 502.
        const status =
          error instanceof OrcaConnectError && error.status
            ? error.status
            : kind === 'denied' || kind === 'state-mismatch'
              ? 403
              : kind === 'cancelled'
                ? 409
                : kind === 'timeout'
                  ? 408
                  : 502;
        return res.status(status).json({
          error:
            error instanceof Error
              ? error.message
              : 'The OrcaRouter connection failed.',
          kind,
        });
      }
    }
  );

  /** A code typed by a human, for Flow B or for a consent screen that showed one. */
  app.post(
    '/api/orcarouter/connect/:attemptId/code',
    (req: Request, res: Response) => {
      const attemptId = String(req.params.attemptId);
      const code = (req.body as { code?: unknown } | undefined)?.code;
      try {
        connectManager.submitCode(attemptId, String(code ?? ''));
        res.json({ accepted: true });
      } catch (error) {
        res.status(400).json({
          error:
            error instanceof Error ? error.message : 'No code was submitted.',
        });
      }
    }
  );

  /**
   * Release the login lock.
   *
   * Reached by the Cancel button, by switching authentication method, by closing the modal, by an
   * unmount, by a reload, and by `pagehide`. It is idempotent, so a client that fires it twice --
   * once on unmount and once on unload -- is not an error.
   */
  app.delete(
    '/api/orcarouter/connect/:attemptId',
    (req: Request, res: Response) => {
      const cancelled = connectManager.cancel(String(req.params.attemptId));
      res.json({ cancelled });
    }
  );

  /**
   * Model discovery for a specific entry point.
   *
   * The capability and the required input modality are query parameters rather than client-side
   * filtering, so a model that cannot serve the entry point never reaches the browser at all. That is
   * what makes the dropdown itself correct instead of relying on a pre-send guard.
   */
  app.get('/api/orcarouter/models', async (req: Request, res: Response) => {
    const capability = capabilityFrom(req.query.capability);
    const requiresInputModality = modalityFrom(req.query.inputModality);
    try {
      const result = await discoverModels({
        capability,
        requiresInputModality,
        timeoutMs: CATALOG_TIMEOUT_MS,
      });
      res.json({
        status: result.status,
        degradedReason: result.degradedReason,
        sourceUrl: result.sourceUrl,
        capability,
        requiresInputModality: requiresInputModality ?? null,
        // Only the metadata a selector needs. No key, no pricing, no internal routing fields.
        models: result.models.map((model) => ({
          id: model.id,
          name: model.name,
          contextLength: model.contextLength,
          supportedEndpointTypes: model.supportedEndpointTypes,
          inputModalities: model.inputModalities,
          reasoningEfforts: model.reasoningEfforts,
          fromSeed: model.fromSeed,
        })),
      });
    } catch (error) {
      res.status(502).json({
        error:
          error instanceof Error ? error.message : 'Model discovery failed.',
      });
    }
  });

  /** The adapters, so the card and the tests read the same registry. */
  app.get('/api/orcarouter/adapters', (_req: Request, res: Response) => {
    res.json({
      adapters: [
        {
          id: apiKeyAdapter.id,
          label: apiKeyAdapter.label,
          source: apiKeyAdapter.source,
        },
        {
          id: pkceAdapter.id,
          label: pkceAdapter.label,
          source: pkceAdapter.source,
        },
      ],
    });
  });
}

export function unregisterOrcaRouterRoutes(): void {
  // Nothing to unregister: Express routes are removed with the app. Present so a test that needs a
  // clean process has an explicit call site rather than reaching into the manager directly.
  connectManager.cancelAll();
}
