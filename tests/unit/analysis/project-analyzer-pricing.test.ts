import { afterEach, describe, expect, it } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { analyzeProjectTokens } from '../../../src/analysis/project-analyzer.js';

const projects: string[] = [];

function projectWithTokens(tokens: number): string {
  const project = fs.mkdtempSync(
    path.join(os.tmpdir(), 'token-optimizer-project-pricing-')
  );
  projects.push(project);
  const data = path.join(project, '.claude-global', 'hooks', 'data');
  fs.mkdirSync(data, { recursive: true });
  fs.writeFileSync(
    path.join(data, 'operations-session.csv'),
    `timestamp,toolName,tokens,metadata\n2026-08-12T12:00:00.000Z,Read,${tokens},fixture\n`
  );
  return project;
}

afterEach(() => {
  for (const project of projects.splice(0)) {
    fs.rmSync(project, { recursive: true, force: true });
  }
});

describe('project analysis pricing', () => {
  it('returns Not priced instead of silently selecting a provider model', async () => {
    const result = await analyzeProjectTokens({
      projectPath: projectWithTokens(1_000_000),
    });

    expect(result.costEstimation).toEqual(
      expect.objectContaining({
        totalCost: null,
        averageCostPerSession: null,
        costPerMillionTokens: null,
        model: 'Not priced',
        source: 'unavailable',
      })
    );
  });

  it('labels an explicit caller rate as a cost equivalent', async () => {
    const result = await analyzeProjectTokens({
      projectPath: projectWithTokens(1_000_000),
      costPerMillionTokens: 2.5,
    });

    expect(result.costEstimation).toEqual(
      expect.objectContaining({
        totalCost: 2.5,
        averageCostPerSession: 2.5,
        costPerMillionTokens: 2.5,
        model: 'Configured effective input rate',
        source: 'configured-effective-rate',
      })
    );
  });
});
