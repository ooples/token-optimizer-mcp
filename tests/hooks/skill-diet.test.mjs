/**
 * The skill diet (#567): skills described in every session and never invoked
 * are listed by name only -- never over the user's own override, never for a
 * plugin skill (skillOverrides does not reach them), and never on evidence
 * that missed a late invocation.
 */

import { describe, expect, test } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  OVERRIDE,
  applySkillDiet,
  measureSkillDiet,
  recordPath,
  restoreSkillDiet,
  sessionSkills,
  settingsPath,
  skillDietFinding,
  skillDietPlan,
} from '../../src/hooks-core/skill-diet.mjs';

const repo = join(fileURLToPath(import.meta.url), '..', '..', '..');

const LISTING = [
  '- dataviz: Use this skill whenever you are about to create a chart: anything at all.',
  '  It goes on for a second line.',
  '- update-config: Configure the harness via settings.json, with a long description here.',
  '- init',
  '- firecrawl:search: Search the web with Firecrawl, a plugin skill with its own description.',
].join('\n');

const listing = () => JSON.stringify({ type: 'attachment', attachment: { type: 'skill_listing', content: LISTING } });
const skillCall = (skill) =>
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Skill', input: { skill } }] } });
const slash = (name) => JSON.stringify({ type: 'user', message: { content: `<command-name>/${name}</command-name>` } });

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), 'skilldiet-'));
  const env = { CLAUDE_CONFIG_DIR: join(root, 'claude'), TOKEN_OPTIMIZER_HOME: join(root, 'home') };
  const project = join(env.CLAUDE_CONFIG_DIR, 'projects', 'C--work');
  mkdirSync(project, { recursive: true });
  return { root, env, project };
}

function sessions(project, count, extra = () => []) {
  for (let i = 0; i < count; i++) {
    writeFileSync(join(project, `s${i}.jsonl`), [listing(), ...extra(i)].join('\n') + '\n');
  }
}

describe('sessionSkills', () => {
  test('reads the listing, a description over two lines, Skill calls and slash commands', () => {
    const s = sessionSkills([listing(), skillCall('/dataviz'), slash('init')].join('\n'));
    expect([...s.listed.keys()]).toEqual(['dataviz', 'update-config', 'init', 'firecrawl:search']);
    expect(s.listed.get('dataviz')).toBeGreaterThan(LISTING.split('\n')[0].length + 10);
    expect(s.listed.get('init')).toBe('- init\n'.length);
    expect([...s.invoked].sort()).toEqual(['dataviz', 'init']);
  });
});

describe('skillDietPlan', () => {
  test('a skill unused across enough sessions is planned; a plugin skill is only proposed', () => {
    const s = sessionSkills(listing());
    const plan = skillDietPlan(Array.from({ length: 10 }, () => s), { minSessions: 10 });
    // largest saving first: dataviz's description runs over two lines
    expect(plan.skills.map((x) => x.name)).toEqual(['dataviz', 'update-config']);
    expect(plan.plugins.map((p) => p.plugin)).toEqual(['firecrawl']);
    // `- init` has no description to drop
    expect(plan.skills.find((x) => x.name === 'init')).toBeUndefined();
    expect(skillDietPlan(Array.from({ length: 9 }, () => s), { minSessions: 10 }).skills).toEqual([]);
    expect(skillDietPlan(Array.from({ length: 10 }, () => s), { keep: ['dataviz'] }).skills.map((x) => x.name)).toEqual(['update-config']);
  });
});

describe('measureSkillDiet', () => {
  test('an invocation late in a long session still counts', () => {
    const { env, project } = sandbox();
    const filler = JSON.stringify({ type: 'user', message: { content: 'x'.repeat(1000) } });
    sessions(project, 10, (i) => (i === 3 ? [...Array(6000).fill(filler), skillCall('dataviz')] : []));
    const plan = measureSkillDiet({ env });
    expect(plan.sessions).toBe(10);
    expect(plan.skills.map((x) => x.name)).toEqual(['update-config']);
  });

  test('a session too large to read whole is left out, not counted as unused', () => {
    const { env, project } = sandbox();
    sessions(project, 10);
    writeFileSync(join(project, 's3.jsonl'), `${listing()}\n${'y'.repeat(5000)}\n${skillCall('update-config')}\n`);
    const plan = measureSkillDiet({ env, maxBytes: 4000 });
    expect(plan.sessions).toBe(9);
    expect(plan.skills).toEqual([]);
  });

  test('subagent transcripts are not sessions', () => {
    const { env, project } = sandbox();
    sessions(project, 9);
    mkdirSync(join(project, 's0', 'subagents'), { recursive: true });
    writeFileSync(join(project, 's0', 'subagents', 'agent-a.jsonl'), `${listing()}\n`);
    expect(measureSkillDiet({ env }).sessions).toBe(9);
  });
});

describe('apply and restore', () => {
  const plan = () => skillDietPlan(Array.from({ length: 10 }, () => sessionSkills(listing())));

  test('writes name-only beside every other setting, never over the user override, with a backup', () => {
    const { env } = sandbox();
    const original = JSON.stringify({ model: 'opus', skillOverrides: { dataviz: 'on' } }, null, 2);
    writeFileSync(settingsPath(env), original);
    const result = applySkillDiet(plan(), { env });
    expect(result.written).toEqual(['update-config']);
    const settings = JSON.parse(readFileSync(settingsPath(env), 'utf8'));
    expect(settings).toEqual({ model: 'opus', skillOverrides: { dataviz: 'on', 'update-config': OVERRIDE } });
    expect(readFileSync(result.backup, 'utf8')).toBe(original);
    expect(JSON.parse(readFileSync(recordPath(env), 'utf8')).written).toEqual(['update-config']);
  });

  test('never touches a settings file that does not parse', () => {
    const { env } = sandbox();
    writeFileSync(settingsPath(env), '{ not json');
    expect(applySkillDiet(plan(), { env }).written).toEqual([]);
    expect(readFileSync(settingsPath(env), 'utf8')).toBe('{ not json');
  });

  test('restore removes only what it wrote and still holds its value', () => {
    const { env } = sandbox();
    applySkillDiet(plan(), { env });
    const settings = JSON.parse(readFileSync(settingsPath(env), 'utf8'));
    settings.skillOverrides.dataviz = 'off';
    writeFileSync(settingsPath(env), JSON.stringify(settings));
    expect(restoreSkillDiet({ env, names: ['dataviz'] }).restored).toEqual([]);
    expect(JSON.parse(readFileSync(settingsPath(env), 'utf8')).skillOverrides.dataviz).toBe('off');
    expect(restoreSkillDiet({ env }).restored).toEqual(['update-config']);
    const after = JSON.parse(readFileSync(settingsPath(env), 'utf8'));
    expect(after.skillOverrides).toEqual({ dataviz: 'off' });
  });

  test('restore of everything leaves no empty skillOverrides behind', () => {
    const { env } = sandbox();
    writeFileSync(settingsPath(env), '{"model":"opus"}');
    applySkillDiet(plan(), { env });
    restoreSkillDiet({ env });
    expect(JSON.parse(readFileSync(settingsPath(env), 'utf8'))).toEqual({ model: 'opus' });
  });
});

describe('the finding and the CLI', () => {
  test('a small plan is not worth a finding; a large one names the command', () => {
    expect(skillDietFinding({ sessions: 10, skills: [], plugins: [], savedChars: 100 })).toBeNull();
    const finding = skillDietFinding({
      sessions: 12,
      skills: [{ name: 'dataviz', savedChars: 3000 }],
      plugins: [{ plugin: 'firecrawl' }],
      savedChars: 3000,
    });
    expect(finding.id).toBe('skill-diet');
    expect(finding.costPerSession).toBe(750);
    expect(finding.title).toContain('skilldiet apply');
    expect(finding.title).toContain('firecrawl');
  });

  test('skilldiet, apply and restore from the command line', () => {
    const { env, project } = sandbox();
    sessions(project, 10);
    const cli = (...a) =>
      spawnSync(process.execPath, [join(repo, 'src', 'scripts', 'learned.mjs'), 'skilldiet', ...a], {
        encoding: 'utf8',
        env: { ...process.env, ...env },
      });
    const status = cli();
    expect(status.status).toBe(0);
    expect(status.stdout).toContain('update-config');
    expect(existsSync(settingsPath(env))).toBe(false);
    expect(cli('apply').stdout).toContain('listed by name only: dataviz, update-config');
    expect(JSON.parse(readFileSync(settingsPath(env), 'utf8')).skillOverrides).toEqual({
      'update-config': OVERRIDE,
      dataviz: OVERRIDE,
    });
    expect(cli('restore').stdout).toContain('descriptions restored');
    expect(JSON.parse(readFileSync(settingsPath(env), 'utf8')).skillOverrides).toBeUndefined();
  });
});
