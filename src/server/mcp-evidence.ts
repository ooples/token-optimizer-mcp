/** Best-effort MCP-native client and tool telemetry for rules-only clients. */

import path from 'path';
import { dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const here = dirname(fileURLToPath(import.meta.url));
const processEpisodeId =
  process.env.TOKEN_OPTIMIZER_EPISODE_ID ??
  `mcp-${process.pid}-${Date.now().toString(36)}`;

interface EvidenceModules {
  wiki: {
    projectRootFor(filePath: string, fallback: string): string;
    wikiDir(cwd: string): string;
  };
  metrics: {
    record(dir: string, event: Record<string, unknown>): unknown;
  };
  projects: {
    registerProject(options: Record<string, unknown>): unknown;
  };
}

export interface McpClientInfo {
  name?: string;
  version?: string;
  title?: string;
}

let cached: Promise<EvidenceModules> | null = null;

function coreUrl(name: string): string {
  return pathToFileURL(path.join(here, '..', '..', 'hooks-core', name)).href;
}

async function modules(): Promise<EvidenceModules> {
  if (!cached) {
    cached = Promise.all([
      import(coreUrl('wiki.mjs')),
      import(coreUrl('metrics.mjs')),
      import(coreUrl('projects.mjs')),
    ]).then(
      ([wiki, metrics, projects]) =>
        ({ wiki, metrics, projects }) as EvidenceModules
    );
  }
  return cached;
}

export class McpEvidenceRecorder {
  private client: McpClientInfo | null = null;

  private async record(event: Record<string, unknown>): Promise<void> {
    try {
      const loaded = await modules();
      const cwd = process.cwd();
      const root = loaded.wiki.projectRootFor(path.join(cwd, '__mcp__'), cwd);
      const dir = loaded.wiki.wikiDir(root);
      loaded.projects.registerProject({
        root,
        graphDir: dir,
        client: this.client?.name || 'unknown-mcp-client',
      });
      loaded.metrics.record(dir, {
        schemaVersion: 2,
        episodeId: processEpisodeId,
        sessionId: processEpisodeId,
        arm: process.env.TOKEN_OPTIMIZER_EXPERIMENT_ARM || 'full',
        client: this.client?.name || 'unknown-mcp-client',
        clientVersion: this.client?.version || null,
        ...event,
      });
    } catch {
      // Telemetry must never make an MCP client fail to initialize or call a tool.
    }
  }

  clientInitialized(info?: McpClientInfo): void {
    this.client = info || null;
    void this.record({
      kind: 'mcp-client',
      clientTitle: info?.title || null,
    });
  }

  toolOutcome(toolName: string, durationMs: number, success: boolean): void {
    void this.record({
      kind: 'mcp-tool',
      toolName,
      durationMs,
      success,
    });
  }
}
