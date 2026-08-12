import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  projectIdFor,
  registerProject,
  registeredProjects,
} from '../../hooks-core/projects.mjs';

let workspace;
let priorRegistry;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'project-registry-'));
  priorRegistry = process.env.TOKEN_OPTIMIZER_PROJECT_REGISTRY;
  process.env.TOKEN_OPTIMIZER_PROJECT_REGISTRY = join(workspace, 'projects.jsonl');
});

afterEach(() => {
  if (priorRegistry === undefined)
    delete process.env.TOKEN_OPTIMIZER_PROJECT_REGISTRY;
  else process.env.TOKEN_OPTIMIZER_PROJECT_REGISTRY = priorRegistry;
  rmSync(workspace, { recursive: true, force: true });
});

describe('machine project graph registry', () => {
  it('deduplicates one repository while retaining observed client coverage', () => {
    const root = join(workspace, 'repo');
    const graphDir = join(root, '.token-optimizer', 'wiki');
    mkdirSync(join(root, '.git'), { recursive: true });

    registerProject({ root, graphDir, client: 'codex' });
    registerProject({ root, graphDir, client: 'claude-code' });

    const projects = registeredProjects();
    expect(projects).toHaveLength(1);
    expect(projects[0].id).toBe(projectIdFor(root));
    expect(projects[0].clients).toEqual(['claude-code', 'codex']);
  });

  it('does not turn arbitrary unrooted hook payloads into dashboard sources', () => {
    const root = join(workspace, 'not-a-repository');
    mkdirSync(root, { recursive: true });
    expect(
      registerProject({
        root,
        graphDir: join(root, '.token-optimizer', 'wiki'),
        client: 'codex',
      })
    ).toBeNull();
    expect(registeredProjects()).toEqual([]);
  });
});
