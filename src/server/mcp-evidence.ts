/** Best-effort MCP-native client and tool telemetry for rules-only clients. */

import path from 'path';
import { dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { recordMcpDiagnostic } from './mcp-diagnostics.js';

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

  constructor(private readonly serviceVersion: string) {
    recordMcpDiagnostic({
      serviceVersion,
      event: 'mcp.process_started',
      outcome: 'success',
      toolProfile: process.env.TOKEN_OPTIMIZER_TOOL_PROFILE || 'core',
      experimentArm: process.env.TOKEN_OPTIMIZER_EXPERIMENT_ARM || 'full',
    });
  }

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
    recordMcpDiagnostic({
      serviceVersion: this.serviceVersion,
      event: 'mcp.client_initialized',
      outcome: 'success',
      client: info?.name || 'unknown-mcp-client',
      clientVersion: info?.version || null,
    });
    void this.record({
      kind: 'mcp-client',
      clientTitle: info?.title || null,
    });
  }

  toolOutcome(toolName: string, durationMs: number, success: boolean): void {
    recordMcpDiagnostic({
      serviceVersion: this.serviceVersion,
      event: 'mcp.tool_completed',
      outcome: success ? 'success' : 'failure',
      client: this.client?.name || 'unknown-mcp-client',
      clientVersion: this.client?.version || null,
      toolName,
      durationMs,
    });
    void this.record({
      kind: 'mcp-tool',
      toolName,
      durationMs,
      success,
    });
  }

  toolsListed(toolCount: number): void {
    recordMcpDiagnostic({
      serviceVersion: this.serviceVersion,
      event: 'mcp.tools_listed',
      outcome: 'success',
      client: this.client?.name || 'unknown-mcp-client',
      clientVersion: this.client?.version || null,
      toolCount,
      toolProfile: process.env.TOKEN_OPTIMIZER_TOOL_PROFILE || 'core',
    });
  }

  transportConnected(): void {
    recordMcpDiagnostic({
      serviceVersion: this.serviceVersion,
      event: 'mcp.transport_connected',
      outcome: 'success',
      client: this.client?.name || null,
      clientVersion: this.client?.version || null,
    });
  }

  startupFailed(error: unknown): void {
    recordMcpDiagnostic({
      serviceVersion: this.serviceVersion,
      event: 'mcp.startup_failed',
      outcome: 'failure',
      client: this.client?.name || null,
      clientVersion: this.client?.version || null,
      error,
    });
  }

  shutdown(): void {
    recordMcpDiagnostic({
      serviceVersion: this.serviceVersion,
      event: 'mcp.shutdown',
      outcome: 'success',
      client: this.client?.name || null,
      clientVersion: this.client?.version || null,
    });
  }
}
