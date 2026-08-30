/**
 * Standing context: skills, instructions and memory.
 *
 * The properties under test are the ones that separate this from a size
 * heuristic with a panel of auditors: non-use is a COUNT from the transcript,
 * staleness is CHECKED against the code rather than suspected, nothing is
 * called unused before there is enough evidence to say so, and the remedy is
 * trim-then-demote rather than delete -- because "delete it" is the advice
 * everyone ignores.
 */

import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  standingFiles, usageFrom, distinctiveTerms, staleClaims, verdictFor,
  auditStanding, renderStanding, MIN_SESSIONS, BLOAT_TOKENS,
} from '../../hooks-core/standing.mjs';

let cwd;

beforeEach(() => { cwd = mkdtempSync(join(tmpdir(), 'standing-')); });
afterEach(() => rmSync(cwd, { recursive: true, force: true }));

const write = (rel, body) => {
  const path = join(cwd, rel);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, body);
  return path;
};

/** A transcript with skill invocations, prose, and a session count. */
function transcript({ skills = [], prose = '', sessions = 10 } = {}) {
  const rows = [];
  for (let i = 0; i < sessions; i++) {
    rows.push({ type: 'user', sessionId: `s${i}`, message: { role: 'user', content: prose } });
  }
  for (const skill of skills) {
    rows.push({
      type: 'assistant', sessionId: 's0',
      message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Skill', input: { skill } }] },
    });
  }
  const path = join(cwd, 'transcript.jsonl');
  writeFileSync(path, `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`);
  return path;
}

describe('everything loaded every session is one object', () => {
  test('instructions, memory, skills and agents are all found', () => {
    write('CLAUDE.md', '# rules\n');
    write('MEMORY.md', '# memory\n');
    write('.claude/skills/pdf-export/SKILL.md', '# pdf export\n');
    write('.claude/agents/reviewer.md', '# reviewer\n');

    const kinds = standingFiles(cwd).map((f) => f.kind).sort();
    expect(kinds).toEqual(['agent', 'instructions', 'instructions', 'skill']);
  });

  test('a project with none of them audits to nothing rather than failing', () => {
    expect(auditStanding(cwd, null)).toEqual([]);
    expect(renderStanding([])).toMatch(/No standing context files found/);
  });
});

describe('non-use is a count, not a judgement', () => {
  test('an invoked skill is not reported as unused', () => {
    write('.claude/skills/pdf-export/SKILL.md', '# pdf export\nexports pdfs\n');
    const usage = usageFrom(transcript({ skills: ['pdf-export'] }));
    const [entry] = standingFiles(cwd);

    const verdict = verdictFor(entry, usage, cwd);
    expect(verdict.invocations).toBe(1);
    expect(verdict.neverUsed).toBe(false);
  });

  test('a skill never invoked across enough sessions is reported with the count', () => {
    write('.claude/skills/pdf-export/SKILL.md', '# pdf export\nexports pdfs\n');
    const usage = usageFrom(transcript({ skills: ['other-thing'], sessions: MIN_SESSIONS + 2 }));
    const verdict = verdictFor(standingFiles(cwd)[0], usage, cwd);

    expect(verdict.neverUsed).toBe(true);
    expect(verdict.actions.find((a) => a.action === 'demote').why).toMatch(/invoked 0 times across \d+ sessions/);
  });

  test('too few sessions means nothing is called unused', () => {
    // Evidence is a count or it is nothing.
    write('.claude/skills/pdf-export/SKILL.md', '# pdf export\n');
    const usage = usageFrom(transcript({ sessions: MIN_SESSIONS - 2 }));
    const verdict = verdictFor(standingFiles(cwd)[0], usage, cwd);

    expect(verdict.neverUsed).toBe(false);
    expect(verdict.evidence).toMatch(/not enough sessions/);
  });

  test('instructions are judged by whether their terms ever appeared in the work', () => {
    write('CLAUDE.md', 'Always prefer the quixotic serialization pattern for zephyr modules.\n');
    const applied = verdictFor(standingFiles(cwd)[0],
      usageFrom(transcript({ prose: 'we used the quixotic serialization pattern today', sessions: MIN_SESSIONS + 1 })), cwd);
    const ignored = verdictFor(standingFiles(cwd)[0],
      usageFrom(transcript({ prose: 'unrelated work entirely', sessions: MIN_SESSIONS + 1 })), cwd);

    expect(applied.termsApplied).toBeGreaterThan(0);
    expect(ignored.neverUsed).toBe(true);
  });

  test('common words are not treated as distinctive', () => {
    const terms = distinctiveTerms('You should always make sure that this file is used when needed');
    // The whole list, not two absences. `not.toContain` alone also passes when
    // distinctiveTerms returns [] for every input -- which would make every
    // standing instruction look unused and every verdict wrong in the same
    // direction. 'needed' is the one word here that is both long enough and not
    // a stopword, so it must be the only survivor.
    expect(terms).toEqual(['needed']);
  });

  test('a missing transcript yields no usage rather than fabricated counts', () => {
    expect(usageFrom(join(cwd, 'nope.jsonl'))).toBeNull();
  });
});

describe('staleness is checked against the code, not suspected', () => {
  test('a claim naming a function the file no longer has is provably stale', () => {
    write('src/db.ts', 'export function connect() { return 1; }\n');
    write('MEMORY.md', 'Use runMigration() in src/db.ts before deploying.\n');

    const [stale] = staleClaims(standingFiles(cwd).find((f) => f.rel === 'MEMORY.md'), cwd);
    expect(stale.why).toMatch(/no longer contains runMigration/);
    expect(stale.provable).toBe(true);
  });

  test('a claim that still holds is left alone', () => {
    write('src/db.ts', 'export function runMigration() { return 1; }\n');
    write('MEMORY.md', 'Use runMigration() in src/db.ts before deploying.\n');
    expect(staleClaims(standingFiles(cwd).find((f) => f.rel === 'MEMORY.md'), cwd)).toHaveLength(0);
  });

  test('a path that no longer exists is reported', () => {
    write('MEMORY.md', 'The parser lives in src/legacy/parser.ts.\n');
    expect(staleClaims(standingFiles(cwd)[0], cwd)[0].why).toMatch(/does not exist/);
  });

  test('prose naming nothing checkable is not flagged', () => {
    // An audit that flags what it cannot verify is generating work, not finding
    // it -- which is the failure mode of a panel of heuristic auditors.
    write('MEMORY.md', 'Prefer small pull requests and write tests first.\n');
    expect(staleClaims(standingFiles(cwd)[0], cwd)).toHaveLength(0);
  });

  test('a bare filename with no directory is treated as illustrative', () => {
    write('MEMORY.md', 'Configuration goes in config.json somewhere.\n');
    expect(staleClaims(standingFiles(cwd)[0], cwd)).toHaveLength(0);
  });
});

describe('the remedy is trim then demote, never delete', () => {
  test('used but oversized gets a trim, proposed as a diff', () => {
    write('CLAUDE.md', `Prefer the quixotic pattern. ${'padding words here '.repeat(200)}`);
    const verdict = verdictFor(standingFiles(cwd)[0],
      usageFrom(transcript({ prose: 'quixotic pattern in use', sessions: MIN_SESSIONS + 1 })), cwd);

    const trim = verdict.actions.find((a) => a.action === 'trim');
    expect(verdict.tokens).toBeGreaterThan(BLOAT_TOKENS);
    expect(trim.kind).toBe('yours');
    expect(trim.diff).toMatch(/we do not edit your files/);
  });

  test('never used gets a demotion, which is ours and reversible', () => {
    // Deleting is the advice everyone ignores, because losing the thing to save
    // tokens is a trade a reasonable person refuses.
    write('.claude/skills/pdf-export/SKILL.md', '# pdf export\n');
    const verdict = verdictFor(standingFiles(cwd)[0],
      usageFrom(transcript({ sessions: MIN_SESSIONS + 1 })), cwd);

    const demote = verdict.actions.find((a) => a.action === 'demote');
    expect(demote.kind).toBe('ours');
    expect(demote.reversible).toBe(true);
    expect(verdict.actions.some((a) => a.action === 'delete')).toBe(false);
  });

  test('both bloated and unused gets trimmed first, then demoted', () => {
    // So what lands in the graph is the substance rather than the padding.
    write('.claude/skills/pdf-export/SKILL.md', `# pdf export\n${'lots of unused guidance '.repeat(200)}`);
    const verdict = verdictFor(standingFiles(cwd)[0],
      usageFrom(transcript({ sessions: MIN_SESSIONS + 1 })), cwd);

    expect(verdict.actions.map((a) => a.action)).toEqual(['trim', 'demote']);
  });

  test('used, current and compact earns no action at all', () => {
    write('CLAUDE.md', 'Prefer the quixotic pattern.\n');
    const verdict = verdictFor(standingFiles(cwd)[0],
      usageFrom(transcript({ prose: 'quixotic pattern', sessions: MIN_SESSIONS + 1 })), cwd);
    expect(verdict.actions).toHaveLength(0);
  });

  test('a stale claim is fixed as a diff against the user\'s file', () => {
    write('src/db.ts', 'export function connect() {}\n');
    write('MEMORY.md', 'Use runMigration() in src/db.ts first.\n');
    const fix = verdictFor(standingFiles(cwd).find((f) => f.rel === 'MEMORY.md'), null, cwd)
      .actions.find((a) => a.action === 'fix');

    expect(fix.kind).toBe('yours');
    expect(fix.diff).toMatch(/MEMORY\.md:1/);
  });
});

describe('ranking and reporting', () => {
  test('provably wrong outranks merely expensive', () => {
    // A stale instruction actively misleads; a large one only costs money.
    write('src/db.ts', 'export function connect() {}\n');
    write('MEMORY.md', 'Use runMigration() in src/db.ts first.\n');
    write('CLAUDE.md', 'x '.repeat(5000));

    expect(auditStanding(cwd, null)[0].entry).toBe('MEMORY.md');
  });

  test('the report names the count and the evidence', () => {
    write('.claude/skills/pdf-export/SKILL.md', '# pdf export\n');
    const text = renderStanding(auditStanding(cwd, transcript({ sessions: MIN_SESSIONS + 1 })));

    expect(text).toMatch(/in every session's prefix/);
    expect(text).toMatch(/invoked 0x/);
    expect(text).toMatch(/-> demote/);
  });

  test('without a transcript it reports cost and declines to call anything unused', () => {
    write('.claude/skills/pdf-export/SKILL.md', '# pdf export\n');
    const text = renderStanding(auditStanding(cwd, null));
    expect(text).toMatch(/not enough sessions yet; reporting cost only/);
    expect(text).not.toMatch(/demote/);
  });
});
