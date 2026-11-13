// GENERATED FILE -- do not edit.
// Source of truth: src/hooks-core/skill-diet.mjs. Regenerate with `npm run sync:hooks`.
/**
 * The skill diet: stop describing skills the model never invokes (#567).
 *
 * WHY. Every session -- and every subagent that has the Skill tool -- starts
 * with a listing of every skill and its description: 18,415 characters
 * (~4.6k tokens) on the machine this was measured on, written to cache at the
 * start of every session and re-read on every turn. Most of it describes
 * skills the model has never once invoked there.
 *
 * WHAT CLAUDE CODE OFFERS, verified on 2.1.323: the `skillOverrides` setting,
 * keyed by skill name. "name-only" keeps a skill in the listing by name and
 * drops its description; the model can still invoke it, and /name still works.
 * It applies to bundled, user and project skills -- NOT to plugin skills (a
 * "plugin:skill" override was measured to change nothing). A plugin's skills
 * go only with the plugin, and a plugin also brings hooks and MCP tools that
 * are invisible here, so a plugin is only ever proposed, never disabled.
 *
 * THE RULE. A skill listed in at least `minSessions` main sessions and invoked
 * in none of them -- by the model (a Skill call) or by the user (/name) --
 * becomes "name-only". Nothing is written over an override the user set,
 * everything written is recorded, and restore removes exactly that.
 *
 * Bounded: at most `maxFiles` recent transcripts, each read up to `maxBytes`.
 */

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const OVERRIDE = 'name-only';
const RECORD = 'skill-diet.json';

function configDir(env) {
  return env.CLAUDE_CONFIG_DIR || join(env.USERPROFILE || env.HOME || homedir(), '.claude');
}

function homeDir(env) {
  return env.TOKEN_OPTIMIZER_HOME || join(env.USERPROFILE || env.HOME || homedir(), '.token-optimizer');
}

export const recordPath = (env = process.env) => join(homeDir(env), RECORD);
export const settingsPath = (env = process.env) => join(configDir(env), 'settings.json');

/** Lines that can matter here; every other line is skipped before it is parsed. */
const RELEVANT = (line) => line.includes('skill_listing') || line.includes('"Skill"') || line.includes('command-name');

/**
 * The relevant lines of a WHOLE transcript, read in chunks, or null when it is
 * larger than `maxBytes`. Never a head: a skill invoked late in a long session
 * would be missed, and a missed invocation is a skill wrongly reduced -- so a
 * session too large to read whole is left out of the evidence instead.
 */
function relevantLines(path, maxBytes) {
  const size = statSync(path).size;
  if (size > maxBytes) return null;
  const handle = openSync(path, 'r');
  const out = [];
  try {
    const buffer = Buffer.allocUnsafe(Math.min(size, 8 * 1024 * 1024) || 1);
    let carry = '';
    let at = 0;
    while (at < size) {
      const got = readSync(handle, buffer, 0, buffer.length, at);
      if (got <= 0) break;
      at += got;
      const text = carry + buffer.toString('utf8', 0, got);
      const lines = text.split('\n');
      carry = lines.pop() ?? '';
      for (const line of lines) if (RELEVANT(line)) out.push(line);
    }
    if (carry && RELEVANT(carry)) out.push(carry);
  } finally {
    closeSync(handle);
  }
  return out.join('\n');
}

/** The skills one session listed (name -> listing characters) and invoked. */
export function sessionSkills(text) {
  const listed = new Map();
  const invoked = new Set();
  for (const line of String(text).split('\n')) {
    if (!line.startsWith('{')) continue;
    if (!line.includes('skill_listing') && !line.includes('"Skill"') && !line.includes('command-name')) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const attachment = entry.attachment;
    if (attachment?.type === 'skill_listing' && typeof attachment.content === 'string') {
      // A description can run over several lines; they belong to the entry above.
      const sizes = new Map();
      let current = null;
      for (const row of attachment.content.split('\n')) {
        const m = /^- ([^\s:][^:]*(?::[^\s:][^:]*)?)(?::\s|$)/.exec(row);
        if (m) current = m[1];
        if (current) sizes.set(current, (sizes.get(current) || 0) + row.length + 1);
      }
      for (const [name, chars] of sizes) listed.set(name, Math.max(listed.get(name) || 0, chars));
    }
    const content = Array.isArray(entry.message?.content) ? entry.message.content : [];
    for (const block of content) {
      if (block?.type === 'tool_use' && block.name === 'Skill' && typeof block.input?.skill === 'string') {
        invoked.add(block.input.skill.replace(/^\//, ''));
      }
    }
    const said = typeof entry.message?.content === 'string' ? entry.message.content : content.map((b) => b?.text || '').join('\n');
    for (const m of said.matchAll(/<command-name>\/?([^<\s]+)<\/command-name>/g)) invoked.add(m[1]);
  }
  return { listed, invoked };
}

/** Recent main-session transcripts (not subagents), newest first. */
export function recentTranscripts({ env = process.env, since = Date.now() - 30 * 86_400_000, maxFiles = 200 } = {}) {
  const projects = join(configDir(env), 'projects');
  const files = [];
  let dirs = [];
  try {
    dirs = readdirSync(projects, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    return [];
  }
  for (const d of dirs) {
    let names = [];
    try {
      names = readdirSync(join(projects, d.name));
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue;
      const path = join(projects, d.name, name);
      try {
        const mtime = statSync(path).mtimeMs;
        if (mtime >= since) files.push({ path, mtime });
      } catch {
        /* gone */
      }
    }
  }
  return files.sort((a, b) => b.mtime - a.mtime).slice(0, maxFiles).map((f) => f.path);
}

const isPluginSkill = (name) => name.includes(':');

/**
 * The plan from a set of sessions: skills to make name-only, and plugins whose
 * skills were never invoked (a proposal only).
 */
export function skillDietPlan(sessions, { minSessions = 10, keep = [] } = {}) {
  const stats = new Map();
  for (const s of sessions) {
    for (const [name, chars] of s.listed) {
      const st = stats.get(name) || { name, sessions: 0, invoked: 0, chars: 0 };
      st.sessions += 1;
      st.chars = Math.max(st.chars, chars);
      stats.set(name, st);
    }
    for (const name of s.invoked) {
      const st = stats.get(name) || { name, sessions: 0, invoked: 0, chars: 0 };
      st.invoked += 1;
      stats.set(name, st);
    }
  }
  const keepSet = new Set(keep);
  const unused = [...stats.values()].filter((s) => s.sessions >= minSessions && s.invoked === 0 && !keepSet.has(s.name));
  const skills = unused
    .filter((s) => !isPluginSkill(s.name))
    .map((s) => ({ ...s, savedChars: Math.max(0, s.chars - `- ${s.name}\n`.length) }))
    .filter((s) => s.savedChars > 0)
    .sort((a, b) => b.savedChars - a.savedChars);
  const plugins = new Map();
  for (const s of stats.values()) {
    if (!isPluginSkill(s.name)) continue;
    const plugin = s.name.split(':')[0];
    const p = plugins.get(plugin) || { plugin, skills: 0, invoked: 0, sessions: 0, chars: 0 };
    p.skills += 1;
    p.invoked += s.invoked;
    p.sessions = Math.max(p.sessions, s.sessions);
    p.chars += s.chars;
    plugins.set(plugin, p);
  }
  const idlePlugins = [...plugins.values()]
    .filter((p) => p.invoked === 0 && p.sessions >= minSessions && !keepSet.has(p.plugin))
    .sort((a, b) => b.chars - a.chars);
  return {
    sessions: sessions.length,
    skills,
    plugins: idlePlugins,
    savedChars: skills.reduce((n, s) => n + s.savedChars, 0),
  };
}

/** Measure this machine's recent sessions and plan the diet. */
export function measureSkillDiet({ env = process.env, maxFiles = 200, maxBytes = 512 * 1024 * 1024, minSessions = 10 } = {}) {
  const sessions = [];
  for (const path of recentTranscripts({ env, maxFiles })) {
    try {
      const text = relevantLines(path, maxBytes);
      if (text === null) continue;
      const s = sessionSkills(text);
      if (s.listed.size) sessions.push(s);
    } catch {
      /* unreadable: not evidence either way */
    }
  }
  const keep = String(env.TOKEN_OPTIMIZER_SKILL_DIET_KEEP || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return skillDietPlan(sessions, { minSessions, keep });
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
}

function writeJsonAtomic(path, value, now) {
  const tmp = `${path}.token-optimizer-tmp-${now}`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmp, path);
}

/**
 * Write "name-only" for each planned skill the user has no override for.
 * Never on a settings file that does not parse; a byte-exact backup first.
 */
export function applySkillDiet(plan, { env = process.env, now = Date.now() } = {}) {
  const path = settingsPath(env);
  let raw = null;
  let settings = {};
  if (existsSync(path)) {
    raw = readFileSync(path, 'utf8');
    try {
      settings = JSON.parse(raw);
    } catch {
      return { written: [], reason: 'settings not parseable; never rewritten' };
    }
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
      return { written: [], reason: 'settings not an object' };
    }
  }
  const overrides = settings.skillOverrides && typeof settings.skillOverrides === 'object' ? settings.skillOverrides : {};
  const written = plan.skills.map((s) => s.name).filter((name) => !Object.prototype.hasOwnProperty.call(overrides, name));
  if (!written.length) return { written, reason: 'nothing to write' };
  mkdirSync(configDir(env), { recursive: true });
  let backup = null;
  if (raw !== null) {
    backup = `${path}.token-optimizer-backup-${now}`;
    writeFileSync(backup, raw);
  }
  const next = { ...settings, skillOverrides: { ...overrides } };
  for (const name of written) next.skillOverrides[name] = OVERRIDE;
  writeJsonAtomic(path, next, now);
  const record = readJson(recordPath(env)) || { written: [] };
  record.written = [...new Set([...(record.written || []), ...written])];
  record.at = now;
  record.backup = backup;
  mkdirSync(homeDir(env), { recursive: true });
  writeFileSync(recordPath(env), `${JSON.stringify(record, null, 2)}\n`);
  return { written, reason: 'written', backup };
}

/** Remove the overrides this package wrote that still hold its value; the user's own are left alone. */
export function restoreSkillDiet({ env = process.env, now = Date.now(), names = null } = {}) {
  const record = readJson(recordPath(env));
  if (!record?.written?.length) return { restored: [], reason: 'nothing was written by token-optimizer' };
  const path = settingsPath(env);
  const settings = readJson(path);
  if (!settings || typeof settings !== 'object') return { restored: [], reason: 'settings not parseable; never rewritten' };
  const overrides = { ...(settings.skillOverrides || {}) };
  const wanted = names && names.length ? record.written.filter((n) => names.includes(n)) : record.written;
  const restored = wanted.filter((n) => overrides[n] === OVERRIDE);
  for (const n of restored) delete overrides[n];
  const next = { ...settings };
  if (Object.keys(overrides).length) next.skillOverrides = overrides;
  else delete next.skillOverrides;
  if (restored.length) writeJsonAtomic(path, next, now);
  // Whatever was asked for leaves the record: restored, or since changed by the user and theirs now.
  record.written = record.written.filter((n) => !wanted.includes(n));
  writeFileSync(recordPath(env), `${JSON.stringify(record, null, 2)}\n`);
  return { restored, reason: restored.length ? 'restored' : 'already changed by the user' };
}

/** The audit finding for the plan, or null when it is too small to mention. */
export function skillDietFinding(plan, { minChars = 2_000 } = {}) {
  if (!plan || plan.savedChars < minChars) return null;
  const tokens = Math.round(plan.savedChars / 4);
  const names = plan.skills.slice(0, 6).map((s) => s.name).join(', ');
  return {
    id: 'skill-diet',
    title:
      `${plan.skills.length} skills were described in every session's skill listing and never invoked across ` +
      `${plan.sessions} recent sessions (${names}${plan.skills.length > 6 ? ', ...' : ''}): ~${tokens.toLocaleString()} tokens ` +
      'written at the start of each session and re-read on every turn. `token-optimizer-learned skilldiet apply` lists them ' +
      'by name only (still invocable; /name still works); `skilldiet restore` undoes it.' +
      (plan.plugins.length
        ? ` Plugins whose skills were never invoked either: ${plan.plugins.map((p) => p.plugin).join(', ')} -- disable them in /plugin if their hooks and tools are unused too.`
        : ''),
    costPerSession: tokens,
    file: 'skills',
    remedy: { setting: 'skillOverrides', value: OVERRIDE },
  };
}
