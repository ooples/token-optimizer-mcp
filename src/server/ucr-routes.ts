import type { Express, Request, Response } from 'express';
import { existsSync, readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.join(here, '..', '..');

async function runtime(): Promise<any> {
  return import(
    pathToFileURL(path.join(here, '..', '..', 'ucr', 'index.mjs')).href
  );
}

function root(): string {
  return process.env.TOKEN_OPTIMIZER_UCR_DIR
    ? path.resolve(process.env.TOKEN_OPTIMIZER_UCR_DIR)
    : path.join(process.cwd(), '.token-optimizer', 'ucr');
}

function releaseEvidence(ucr: any): any {
  const file = path.join(root(), 'release-evidence.json');
  const readOptional = (candidate: string) => {
    try {
      return existsSync(candidate)
        ? JSON.parse(readFileSync(candidate, 'utf8'))
        : null;
    } catch {
      return null;
    }
  };
  const bundled = {
    deterministic: readOptional(
      path.join(
        packageRoot,
        'evals',
        'ucr',
        'results',
        'deterministic-verification-v1.json'
      )
    ),
    liveHandoff: readOptional(
      path.join(
        packageRoot,
        'evals',
        'ucr',
        'results',
        'live-cross-model-handoff-v1.json'
      )
    ),
  };
  if (!existsSync(file))
    return { verdict: ucr.releaseVerdict({}), metrics: null, ...bundled };
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return {
      ...bundled,
      ...parsed,
      verdict: parsed.verdict || ucr.releaseVerdict(parsed.metrics || {}),
    };
  } catch {
    return {
      ...bundled,
      verdict: {
        status: 'insufficient',
        passed: false,
        missing: ['valid release-evidence.json'],
      },
      metrics: null,
    };
  }
}

export function registerUcrRoutes(app: Express): void {
  app.get('/api/ucr/status', async (_req: Request, res: Response) => {
    try {
      const ucr = await runtime();
      const store = new ucr.EventStore(root());
      const replay = store.read();
      const graph = ucr.rebuildGraph(replay.events);
      const evidence = releaseEvidence(ucr);
      return res.json({
        available: true,
        protocolVersion: ucr.UCR_PROTOCOL_VERSION,
        schemaVersion: ucr.UCR_EVENT_SCHEMA,
        events: replay.events.length,
        eventDigest: store.digest(),
        malformed: replay.malformed.length,
        replayDiagnostics: replay.diagnostics.length,
        graph: graph.integrity(),
        cognitiveOperations: ucr.BOOTSTRAP_COGNITIVE_OPERATIONS.map(
          (operation: any) => operation.name
        ),
        certifiedClients: Object.keys(ucr.UCR_CLIENT_REGISTRY).length,
        verdict: evidence.verdict,
        metrics: evidence.metrics,
        deterministicEvidence: evidence.deterministic
          ? {
              checksPassed:
                evidence.deterministic.deterministicProof?.checksPassed,
              checksTotal:
                evidence.deterministic.deterministicProof?.checksTotal,
              reportHash: evidence.deterministic.reportHash,
            }
          : null,
        liveHandoff: evidence.liveHandoff
          ? {
              passed: evidence.liveHandoff.passed,
              producer: evidence.liveHandoff.clients?.producer,
              consumer: evidence.liveHandoff.clients?.consumer,
              events: evidence.liveHandoff.eventEvidence,
              reportHash: evidence.liveHandoff.reportHash,
            }
          : null,
      });
    } catch (error) {
      return res.status(500).json({
        available: false,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  });

  app.get('/api/ucr/evidence', async (_req: Request, res: Response) => {
    try {
      const ucr = await runtime();
      return res.json(releaseEvidence(ucr));
    } catch (error) {
      return res.status(500).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
}
