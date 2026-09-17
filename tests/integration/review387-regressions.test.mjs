import { test, expect } from '@jest/globals';
import fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { claudeRoute } from '../../scripts/claude-routing.mjs';
import { replaceProfile } from '../../scripts/profile-file.mjs';
import { recoverProfileLock } from '../../scripts/recover-profile-lock.mjs';
import { auditChatProbe } from '../../bench/live/chat-route-audit.mjs';

test.each([
  ['--setting-sources'],
  ['--setting-sources', '--settings', '{}'],
  ['--settings'],
  ['--settings', '--setting-sources', ''],
])('rejects missing routing values: %j', (...args) => {
  expect(() => claudeRoute(args, {}, tmpdir())).toThrow('needs a value');
});
test('explicit empty setting sources remains valid', () => {
  expect(
    claudeRoute(
      [
        '--setting-sources',
        '',
        '--settings',
        '{"env":{"ANTHROPIC_BASE_URL":"https://example.test"}}',
      ],
      {},
      tmpdir()
    ).upstream
  ).toBe('https://example.test');
});

test('profile lock records its owner and requires explicit dead-owner recovery', () => {
  const dir = fs.mkdtempSync(join(tmpdir(), 'profile-lock-review-'));
  const profile = join(dir, 'profile.ps1'),
    lock = `${profile}.token-optimizer.lock`;
  try {
    fs.writeFileSync(profile, 'old');
    let recorded;
    replaceProfile(profile, Buffer.from('old'), Buffer.from('new'), {
      ...fs,
      renameSync(a, b) {
        recorded = JSON.parse(fs.readFileSync(lock, 'utf8'));
        fs.renameSync(a, b);
      },
    });
    expect(recorded.pid).toBe(process.pid);
    expect(Number.isFinite(Date.parse(recorded.startedAt))).toBe(true);
    fs.writeFileSync(lock, JSON.stringify(recorded));
    expect(() =>
      replaceProfile(profile, Buffer.from('new'), Buffer.from('bad'))
    ).toThrow(lock);
    expect(() => recoverProfileLock(profile)).toThrow('still running');
    expect(() =>
      recoverProfileLock(profile, fs, () => {
        throw Object.assign(Error('permission'), { code: 'EPERM' });
      })
    ).toThrow('permission');
    expect(fs.existsSync(lock)).toBe(true);
    const dead = Number(
      execFileSync(process.execPath, ['-e', 'console.log(process.pid)'], {
        encoding: 'utf8',
        windowsHide: true,
      })
    );
    fs.writeFileSync(lock, JSON.stringify({ ...recorded, pid: dead }));
    expect(recoverProfileLock(profile)).toBe(lock);
    replaceProfile(profile, Buffer.from('new'), Buffer.from('recovered'));
    expect(fs.readFileSync(profile, 'utf8')).toBe('recovered');
    fs.writeFileSync(lock, '{}');
    expect(() => recoverProfileLock(profile)).toThrow('Invalid owner');
    expect(fs.existsSync(lock)).toBe(true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('chat audit checks later payloads and rejects broken references and missing samples', async () => {
  const dir = fs.mkdtempSync(join(tmpdir(), 'chat-audit-review-'));
  const samples = Array.from({ length: 8 }, (_, sample) => {
    const rows = Array.from({ length: 80 + sample }, (_, id) => ({
      id: `case-${sample}-row-${id}`,
      state: id === 17 ? 'failed' : 'ready',
      region: 'east',
      description: 'Shared diagnostic record description',
      value: id * 17 + sample,
    }));
    const messages = [
      { role: 'system', content: 'Inspect diagnostic records.' },
      { role: 'user', content: 'Report the failed record and its value.' },
    ];
    for (let r = 0; r < (sample % 3) + 1; r++)
      messages.push(
        { role: 'assistant' },
        {
          role: 'tool',
          tool_call_id: `call-${r}`,
          content: JSON.stringify(rows),
        }
      );
    return {
      sample,
      arm: 'proxy',
      preserved: true,
      wire: JSON.stringify({ messages }),
    };
  });
  const audit = async () => {
    fs.writeFileSync(join(dir, 'wire.json'), JSON.stringify(samples));
    return auditChatProbe(dir);
  };
  try {
    expect((await audit()).passed).toBe(true);
    const original = samples[2].wire,
      wire = JSON.parse(original);
    wire.messages[5].content = 'corrupted later payload';
    samples[2].wire = JSON.stringify(wire);
    expect((await audit()).passed).toBe(false);
    wire.messages[5].content =
      '[Repeated observation: identical content to messages[3].content.]';
    samples[2].wire = JSON.stringify(wire);
    expect((await audit()).passed).toBe(true);
    wire.messages[5].content =
      '[Repeated observation: identical content to messages[7].content.]';
    samples[2].wire = JSON.stringify(wire);
    expect((await audit()).passed).toBe(false);
    samples[2].wire = original;
    samples[7] = samples[0];
    expect((await audit()).passed).toBe(false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
