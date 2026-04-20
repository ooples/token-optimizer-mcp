import { describe, it, expect, afterEach } from '@jest/globals';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'fs';
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

  function tempConfigPath(): string {
    const dir = mkdtempSync(join(tmpdir(), 'token-optimizer-config-'));
    tempDirs.push(dir);
    return join(dir, 'config.json');
  }

  function writeConfig(content: string): string {
    const file = tempConfigPath();
    writeFileSync(file, content);
    return file;
  }

  it('returns defaults when no config file exists and writeDefaults is false', () => {
    const mgr = new ConfigManager(tempConfigPath(), { writeDefaults: false });
    const opt = mgr.getOptimizationConfig();
    expect(opt.compressionTokenThreshold).toBe(0.7);
    expect(opt.quality).toBe('balanced');
    expect(opt.cacheSettings.maxSize).toBe(1000);
    expect(opt.cacheSettings.ttlSeconds).toBe(3600);
    expect(opt.chatCompression.enabled).toBe(true);
    expect(opt.chatCompression.strategy).toBe('summarize');
    expect(mgr.getModelTokenLimit('gpt-4')).toBe(128000);
  });

  it('writes a default config file on first run', () => {
    const file = tempConfigPath();
    expect(existsSync(file)).toBe(false);
    new ConfigManager(file);
    expect(existsSync(file)).toBe(true);

    // A second instance reads what the first wrote.
    const second = new ConfigManager(file);
    expect(second.getOptimizationConfig().quality).toBe('balanced');
  });

  it('overrides defaults with user config — nested sub-objects deep-merge', () => {
    const configPath = writeConfig(
      JSON.stringify({
        optimization: {
          compressionTokenThreshold: 0.9,
          quality: 'max',
          cacheSettings: { maxSize: 42 },
          chatCompression: { strategy: 'truncate' },
          modelTokenLimits: { 'custom-model': 500000 },
        },
      })
    );
    const mgr = new ConfigManager(configPath, { writeDefaults: false });
    const opt = mgr.getOptimizationConfig();
    expect(opt.compressionTokenThreshold).toBe(0.9);
    expect(opt.quality).toBe('max');
    expect(opt.cacheSettings.maxSize).toBe(42);
    // Unprovided sub-field retains default.
    expect(opt.cacheSettings.ttlSeconds).toBe(3600);
    expect(opt.chatCompression.enabled).toBe(true);
    expect(opt.chatCompression.strategy).toBe('truncate');
    expect(mgr.getModelTokenLimit('custom-model')).toBe(500000);
    // Built-in model limits must survive a partial override.
    expect(mgr.getModelTokenLimit('gpt-4')).toBe(128000);
    expect(opt.compressionPreserveThreshold).toBe(0.3);
  });

  it('falls back to defaults on invalid config', () => {
    const configPath = writeConfig(
      JSON.stringify({ optimization: { compressionTokenThreshold: 5 } })
    );
    const mgr = new ConfigManager(configPath, { writeDefaults: false });
    expect(mgr.getOptimizationConfig().compressionTokenThreshold).toBe(0.7);
  });

  it('falls back to defaults on malformed JSON', () => {
    const configPath = writeConfig('not json at all');
    const mgr = new ConfigManager(configPath, { writeDefaults: false });
    expect(mgr.getOptimizationConfig().quality).toBe('balanced');
  });
});
