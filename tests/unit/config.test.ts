import { describe, it, expect, afterEach } from '@jest/globals';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ConfigManager } from '../../src/core/config.js';

describe('ConfigManager', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length) {
      const dir = tempDirs.pop();
      if (dir) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  function writeConfig(content: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'token-optimizer-config-'));
    tempDirs.push(dir);
    const file = join(dir, 'config.json');
    writeFileSync(file, content);
    return file;
  }

  it('returns defaults when no config file exists', () => {
    const mgr = new ConfigManager(join(tmpdir(), 'does-not-exist-xyz.json'));
    const opt = mgr.getOptimizationConfig();
    expect(opt.compressionTokenThreshold).toBe(0.7);
    expect(opt.quality).toBe('balanced');
    expect(mgr.getModelTokenLimit('gpt-4')).toBe(128000);
  });

  it('overrides defaults with user config', () => {
    const configPath = writeConfig(
      JSON.stringify({
        optimization: {
          compressionTokenThreshold: 0.9,
          quality: 'max',
          modelTokenLimits: { 'custom-model': 500000 },
        },
      })
    );
    const mgr = new ConfigManager(configPath);
    const opt = mgr.getOptimizationConfig();
    expect(opt.compressionTokenThreshold).toBe(0.9);
    expect(opt.quality).toBe('max');
    expect(mgr.getModelTokenLimit('custom-model')).toBe(500000);
    // Unrelated defaults still filled in
    expect(opt.compressionPreserveThreshold).toBe(0.3);
  });

  it('falls back to defaults on invalid config', () => {
    const configPath = writeConfig(
      JSON.stringify({ optimization: { compressionTokenThreshold: 5 } })
    );
    const mgr = new ConfigManager(configPath);
    // Invalid value (>1) is rejected by schema → defaults applied
    expect(mgr.getOptimizationConfig().compressionTokenThreshold).toBe(0.7);
  });

  it('falls back to defaults on malformed JSON', () => {
    const configPath = writeConfig('not json at all');
    const mgr = new ConfigManager(configPath);
    expect(mgr.getOptimizationConfig().quality).toBe('balanced');
  });
});
