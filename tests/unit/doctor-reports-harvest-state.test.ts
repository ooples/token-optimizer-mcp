import { describe, it, expect, afterEach } from '@jest/globals';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// @ts-expect-error -- hooks-core ships as plain ESM with no type declarations.
import { probeHarvest, diagnose } from '../../hooks-core/doctor.mjs';

/**
 * The doctor reported a clean bill while the half that learns captured nothing.
 *
 * Measured on a real machine running 5.4.0: the project graph held 484 symbol,
 * 286 file and 122 task nodes and ZERO findings, lessons or corrections, because
 * harvestMode() was 'off:not-opted-in'. Fifteen doctor checks passed and not one
 * of them mentioned harvest -- `grep -c harvest hooks-core/doctor.mjs` returned 0.
 *
 * stop-harvest.mjs names this exact gap in its own header: "nothing in doctor,
 * audit or waste mentions harvest, so a user sees a graph filling with structural
 * nodes and no findings and has no way to learn why." It then fixed its own half,
 * the once-per-session Stop notice, and the doctor half never landed. A Stop-time
 * systemMessage is easy to miss; the doctor is where someone goes to ask.
 *
 * This is deliberately NOT a judgement about whether opting in is correct. The
 * default is well-reasoned -- extraction costs a model call and sends a digest
 * off the machine, and "an ambient credential is not consent". The defect is that
 * the state is invisible, so a user believes findings are accumulating when they
 * cannot.
 */

const ENV_KEYS = [
  'TOKEN_OPTIMIZER_MODE',
  'TOKEN_OPTIMIZER_HARVEST',
  'TOKEN_OPTIMIZER_HARVEST_ENDPOINT',
  'TOKEN_OPTIMIZER_API_KEY',
  'ANTHROPIC_API_KEY',
];
const saved = new Map(ENV_KEYS.map((k) => [k, process.env[k]]));

function envOnly(vars: Record<string, string>) {
  for (const k of ENV_KEYS) delete process.env[k];
  for (const [k, v] of Object.entries(vars)) process.env[k] = v;
}

afterEach(() => {
  for (const [k, v] of saved) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('probeHarvest', () => {
  it('passes without a second-model credential because the active model writes findings', () => {
    envOnly({});
    const [check] = probeHarvest();

    expect(check.pass).toBe(true);
    expect(check.name).toMatch(/harvest|finding/i);
    expect(check.detail).toMatch(/active model|wiki_write/i);
  });

  it('reports the external transcript harvester as an optional fallback', () => {
    envOnly({});
    const [check] = probeHarvest();

    expect(check.pass).toBe(true);
    expect(check.detail).toMatch(/fallback/i);
    expect(check.detail).toMatch(/credential/i);
  });

  it('reports a deliberate opt-out as a choice, not a fault', () => {
    // Nagging about a setting somebody chose is how a diagnostic gets ignored, and the point of
    // this check is that it stays worth reading.
    envOnly({ TOKEN_OPTIMIZER_HARVEST: '0', TOKEN_OPTIMIZER_API_KEY: 'sk-x' });
    const [check] = probeHarvest();

    expect(check.pass).toBe(true);
    expect(check.detail).toMatch(/your choice/i);
  });

  it('does not fail when fallback extraction is requested without a credential', () => {
    envOnly({ TOKEN_OPTIMIZER_HARVEST: '1' });
    const [check] = probeHarvest();

    expect(check.pass).toBe(true);
    expect(check.detail).toMatch(/credential|key/i);
  });

  it('passes on a local endpoint, which is free and private', () => {
    envOnly({
      TOKEN_OPTIMIZER_HARVEST_ENDPOINT:
        'http://127.0.0.1:11434/v1/chat/completions',
    });
    const [check] = probeHarvest();

    expect(check.pass).toBe(true);
    expect(check.detail).toMatch(/local/i);
  });

  it('passes when opted in with a credential', () => {
    envOnly({
      TOKEN_OPTIMIZER_HARVEST: 'true',
      TOKEN_OPTIMIZER_API_KEY: 'sk-test',
    });
    const [check] = probeHarvest();

    expect(check.pass).toBe(true);
  });

  it('says nothing when the whole optimizer is off', () => {
    // TOKEN_OPTIMIZER_MODE=off is the documented escape hatch. Reporting a
    // harvest failure on top of it would be noise, which is why stop-harvest maps
    // that mode to a null notice.
    envOnly({ TOKEN_OPTIMIZER_MODE: 'off' });

    expect(probeHarvest()).toEqual([]);
  });
});

describe('the diagnosis as a whole', () => {
  it('includes the harvest state, so a clean bill cannot hide an inert graph', () => {
    envOnly({});
    // workspace and graphDir are required by the enforcement and graph probes;
    // skipServer because the MCP probe spawns a server, which is not what this
    // test is about.
    const scratch = mkdtempSync(join(tmpdir(), 'doctor-harvest-'));
    try {
      const result = diagnose({
        root: process.cwd(),
        workspace: join(scratch, 'workspace'),
        graphDir: join(scratch, 'graph'),
        skipServer: true,
      });
      const names = result.checks.map((c: { name: string }) => c.name);

      expect(names.some((n: string) => /harvest|finding/i.test(n))).toBe(true);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});
