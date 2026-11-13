// GENERATED FILE -- do not edit.
// Source of truth: src/hooks-core/agent-brief.mjs. Regenerate with `npm run sync:hooks`.
/**
 * The agent brief: the rules a delegated agent needs, compiled from the user's
 * instruction files and approved by the user (#567).
 *
 * WHY. A general-purpose agent starts from the user's whole CLAUDE.md and
 * auto-memory, the skill list and the system prompt: 34,578 tokens measured on
 * Claude Code 2.1.323 for an agent asked to reply with one word, re-read on
 * every one of its turns and re-written whenever its 5-minute cache lapses. The
 * plugin's `token-optimizer:worker` agent starts from 9,724 (omitClaudeMd, no
 * skill list) -- but without the user's rules, and "never commit to
 * master" is not optional for a delegated agent.
 *
 * So the instruction files are compiled ONCE into a brief: the rules, without
 * the rationale, history and examples around them. The user reviews and
 * approves it; only then does the spawn hook route general-purpose agents to the
 * worker with the brief in front of their task. Sections can be scoped -- a
 * `<!-- when: word, word -->` line under a heading sends that section only to
 * agents whose task mentions one of the words.
 *
 * Nothing here is automatic: an unapproved draft is never sent, and a brief is
 * only ever used as the user left it.
 */

import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, parse } from 'node:path';

/** The marker that says a prompt already carries the brief. */
export const BRIEF_MARKER = '[token-optimizer agent brief]';
/** The agent general-purpose spawns are routed to. */
export const WORKER_AGENT = 'token-optimizer:worker';
/** A rule line longer than this is cut: a brief carries the rule, not the essay. */
const MAX_RULE_CHARS = 400;

/** A long rule cut at its last full sentence inside the cap, never mid-word. */
function clip(text) {
  if (text.length <= MAX_RULE_CHARS) return text;
  const head = text.slice(0, MAX_RULE_CHARS);
  const sentence = Math.max(head.lastIndexOf('. '), head.lastIndexOf('; '), head.lastIndexOf(': '));
  if (sentence >= MAX_RULE_CHARS / 3) return head.slice(0, sentence + 1);
  return `${head.slice(0, Math.max(head.lastIndexOf(' '), 1))}…`;
}

const RULE_WORDS = /\b(never|always|must|do not|don't|dont|only|required?|mandatory|forbidden|prefer|avoid|use)\b/i;
const ALWAYS_HEADING = /\b(critical|never|must|always|important|mandatory|safety)\b/i;
const STOP = new Set([
  'with', 'from', 'that', 'this', 'what', 'when', 'into', 'your', 'have', 'only', 'never', 'always',
  'must', 'critical', 'important', 'mandatory', 'follow', 'exactly', 'rules', 'rule', 'guidelines',
  'core', 'principles', 'best', 'practices', 'pattern', 'patterns', 'specific', 'general', 'using',
  'each', 'then', 'once', 'time', 'still', 'added', 'issue', 'process', 'matters', 'learned', 'hard',
  'acceptable', 'there', 'their', 'these', 'those', 'which', 'about', 'after', 'before', 'where',
  'implementation', 'checklist', 'details', 'notes', 'example', 'examples', 'related', 'learnings',
]);

function homeDir(env) {
  return env.TOKEN_OPTIMIZER_HOME || join(env.USERPROFILE || env.HOME || homedir(), '.token-optimizer');
}

/** Where the approved briefs live: the user's, then the project's. */
export function briefPaths({ cwd = process.cwd(), env = process.env } = {}) {
  return {
    global: join(homeDir(env), 'agent-brief.md'),
    project: cwd ? join(cwd, '.token-optimizer', 'agent-brief.md') : null,
  };
}

/**
 * SHORT AGENT PROMPTS (#567): the session-start line, or null without an
 * approved brief. With one, every agent the session starts already gets the
 * user's rules and the paths the session has read (agent-spawn.mjs), yet the
 * parent restated both in each prompt -- measured on the bench, ~40% of every
 * agent prompt was rules, written as output at 5x. The spawn hook runs after
 * the prompt is written, so session start is the only point that can change it.
 */
export function agentBriefNotice({ cwd = process.cwd(), env = process.env } = {}) {
  if (/^(off|0|false|no)$/i.test(String(env.TOKEN_OPTIMIZER_AGENT_BRIEF_NOTICE || '').trim())) return null;
  try {
    const { global, project } = briefPaths({ cwd, env });
    if (![global, project].some((path) => path && existsSync(path))) return null;
  } catch {
    return null;
  }
  return (
    "Agents you start receive the user's approved rules and the paths of files you have read. " +
    'Give each agent only its task and what you know about it; do not restate rules or instructions.'
  );
}

/** The instruction files Claude Code loads for `cwd`, global first, nearest last. */
export function instructionFiles({ cwd = process.cwd(), env = process.env, ceiling = null } = {}) {
  const config = env.CLAUDE_CONFIG_DIR || join(env.USERPROFILE || env.HOME || homedir(), '.claude');
  const global = [join(config, 'CLAUDE.md')];
  const project = [];
  if (cwd) {
    let dir = cwd;
    const { root } = parse(cwd);
    for (let depth = 0; depth < 32; depth++) {
      for (const name of ['CLAUDE.local.md', join('.claude', 'CLAUDE.md'), 'CLAUDE.md']) project.unshift(join(dir, name));
      if (dir === root || (ceiling && dir === ceiling)) break;
      const up = dirname(dir);
      if (up === dir) break;
      dir = up;
    }
  }
  const seen = new Set();
  return {
    global: global.filter((p) => existsSync(p)),
    project: project.filter((p) => existsSync(p) && !global.includes(p) && !seen.has(p) && seen.add(p)),
  };
}

/** Markdown split at headings: [{ heading, level, body: string[] }]. Code fences stay whole. */
function sections(markdown) {
  const out = [{ heading: '', level: 0, body: [] }];
  let fence = false;
  for (const raw of String(markdown).split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(raw)) fence = !fence;
    const h = !fence && /^(#{1,6})\s+(.*)$/.exec(raw);
    if (h) out.push({ heading: h[2].trim(), level: h[1].length, body: [] });
    else out[out.length - 1].body.push(raw);
  }
  return out;
}

const plainHeading = (h) => h.replace(/[^\p{L}\p{N}\s/:'-]/gu, ' ').replace(/\s+/g, ' ').trim();

function keywordsOf(heading) {
  const words = plainHeading(heading)
    .toLowerCase()
    .split(/[\s/:'-]+/)
    .filter((w) => w.length >= 4 && !STOP.has(w) && !/^\d+$/.test(w));
  return [...new Set(words)].slice(0, 6);
}

/**
 * The rule lines of one section body: list items and sentences that state a
 * rule, without code blocks, examples or rationale. Deterministic.
 */
function ruleLines(body) {
  // Logical lines first: a wrapped paragraph or list item is one rule, not a
  // rule cut at the first line break.
  const logical = [];
  let fence = false;
  let open = false;
  for (const raw of body) {
    if (/^\s*(```|~~~)/.test(raw)) {
      fence = !fence;
      open = false;
      continue;
    }
    if (fence) continue;
    const line = raw.trim();
    const starts = !line || /^([-*+]|\d+[.)])\s+/.test(line) || /^(\||<!--|>)/.test(line);
    if (open && !starts) logical[logical.length - 1] += ` ${line}`;
    else if (line) logical.push(line);
    open = Boolean(line) && !/^(\||<!--)/.test(line);
  }
  const rules = [];
  for (const line of logical) {
    if (!line || /^<!--/.test(line) || /^\|/.test(line)) continue;
    const text = line.replace(/^([-*+]|\d+[.)])\s+/, '');
    const isItem = text !== line;
    if (/^\*\*?(why|example|examples|note)\b/i.test(text)) continue;
    if (!RULE_WORDS.test(text) && !(isItem && /\*\*/.test(text))) continue;
    const plain = text.replace(/\s+/g, ' ');
    rules.push(`- ${clip(plain)}`);
  }
  return [...new Set(rules)];
}

/**
 * The draft brief for a set of instruction files, for the user to review.
 *
 * @param {{path: string, text: string}[]} files
 * @returns {string}
 */
export function draftBrief(files) {
  const parts = [
    '<!--',
    `${BRIEF_MARKER} DRAFT, compiled from: ${files.map((f) => f.path).join(', ') || '(no instruction files)'}`,
    'This is sent in front of the task of every general-purpose agent once approved, in place of those files.',
    'Review it: delete what a delegated agent does not need, add what it does. A section with a',
    '"when:" line is sent only to agents whose task mentions one of its words; delete that line to',
    'send the section always. Then run: token-optimizer-agent-brief approve',
    '-->',
    '',
  ];
  // A rule repeated in another section, or another file, is sent once.
  const emitted = new Set();
  for (const file of files) {
    // A subsection belongs to the headings above it: under a CRITICAL heading it
    // is sent always, and its scope words include its parents'.
    const stack = [];
    for (const section of sections(file.text)) {
      while (stack.length && stack[stack.length - 1].level >= section.level) stack.pop();
      // A level-1 heading is the document's title: it scopes nothing, and its
      // words ("development", "guidelines") would match almost any task.
      const ancestors = stack.filter((s) => s.level > 1);
      if (section.level > 0) stack.push(section);
      if (/^\W*why\b/i.test(plainHeading(section.heading))) continue;
      const rules = ruleLines(section.body).filter((r) => {
        const key = r.toLowerCase();
        if (emitted.has(key)) return false;
        emitted.add(key);
        return true;
      });
      if (!rules.length) continue;
      const path = [...ancestors, section].map((s) => plainHeading(s.heading)).filter(Boolean);
      parts.push(`## ${path.join(' > ') || 'General'}`);
      const always = [...ancestors, section].some((s) => ALWAYS_HEADING.test(s.heading));
      const words = [...new Set([...ancestors, section].flatMap((s) => keywordsOf(s.heading)))].slice(0, 8);
      if (!always && words.length) parts.push(`<!-- when: ${words.join(', ')} -->`);
      parts.push(...rules, '');
    }
  }
  return `${parts.join('\n').trimEnd()}\n`;
}

/**
 * The text with every HTML comment removed. One pass is not enough: removing
 * the inner comment of `<!-<!-- x -->- note -->` joins its halves into a new
 * one, so it repeats until nothing changes. An unterminated `<!--` drops the
 * rest of the text, as a renderer would hide it.
 */
export function withoutComments(text) {
  let out = text;
  for (let previous = null; previous !== out; ) {
    previous = out;
    out = out.replace(/<!--[\s\S]*?-->/g, '');
  }
  const open = out.indexOf('<!--');
  return open < 0 ? out : out.slice(0, open);
}

/** A brief file parsed: [{ heading, when: string[] | null, text }]. Comments outside a when: line are dropped. */
export function parseBrief(markdown) {
  const out = [];
  for (const section of sections(markdown)) {
    let when = null;
    const lines = [];
    for (const raw of section.body) {
      const w = /^\s*<!--\s*when:\s*(.*?)\s*-->\s*$/i.exec(raw);
      if (w) {
        when = w[1].split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
        continue;
      }
      lines.push(raw);
    }
    const body = withoutComments(lines.join('\n')).trim();
    if (!body) continue;
    out.push({ heading: section.heading, when: when && when.length ? when : null, text: body });
  }
  return out;
}

const mentions = (task, word) =>
  new RegExp(`(^|[^\\p{L}\\p{N}])${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'iu').test(task);

/** The approved brief text for one task, or null when there is none. */
export function briefFor(task, { cwd = process.cwd(), env = process.env } = {}) {
  const { global, project } = briefPaths({ cwd, env });
  const blocks = [];
  for (const path of [global, project]) {
    if (!path) continue;
    let text;
    try {
      text = readFileSync(path, 'utf8');
    } catch {
      continue;
    }
    for (const section of parseBrief(text)) {
      if (section.when && !section.when.some((w) => mentions(String(task || ''), w))) continue;
      blocks.push(section.heading ? `## ${section.heading}\n${section.text}` : section.text);
    }
  }
  return blocks.length ? blocks.join('\n\n') : null;
}

/** Is the worker agent loaded? Only when this hook runs from the plugin that ships it. */
export function workerAvailable(env = process.env) {
  const root = env.CLAUDE_PLUGIN_ROOT;
  return Boolean(root) && existsSync(join(root, 'agents', 'worker.md'));
}

// ------------------------------------------------- the generated worker agents
//
// THE ALWAYS-SENT RULES BELONG IN A SYSTEM PROMPT, NOT IN EACH TASK. In the
// task message they were written to cache once per agent (measured: ~4.1k of
// each worker's ~4.1k uncached first-request tokens, while the system prompt
// before them was read from a sibling's cache). Approving a brief therefore
// also writes an agent of the user's own -- the worker's prompt plus the
// always-sent rules -- whose system prompt every later spawn reads from cache.
// Only the sections a task names still travel in its prompt. And a user agent
// needs no plugin: settings-installed hooks route to it too.

/** The user's generated worker, with the user's always-sent rules. */
export const USER_WORKER = 'token-optimizer-worker';
/** The project's generated worker: the user's rules and the project's. A distinct name, so no precedence rule decides which one runs. */
export const PROJECT_WORKER = 'token-optimizer-project-worker';

/** The worker's own instructions, shared by the plugin agent and the generated ones. */
export const WORKER_BODY = [
  'You are an agent working on one task delegated by another agent. Use the tools available to complete it fully, then stop.',
  '',
  '- The prompt you were given is your whole brief: it states the goal, the constraints and anything already ruled out. Follow its constraints exactly; when it is silent, follow the conventions of the code around you.',
  "- The rules from the user's instruction files that apply to you are already in this prompt. Do not read CLAUDE.md, AGENTS.md or other instruction files.",
  '- Work directly: read what the change needs, make it, and run a check once if the task names one. Use only the tools the task needs; do not load other tools or record notes anywhere. Report a failure or anything left undone plainly.',
  '- Do not create files beyond what the task needs, and never commit, push or publish unless the prompt says to.',
  '',
  'Your final reply is read by the agent that started you on every one of its later turns, so keep it short: the outcome, the files you changed with paths, and anything unresolved. If the detail runs longer than about 300 words, write it to a file and give the path.',
].join('\n');

function configDir(env) {
  return env.CLAUDE_CONFIG_DIR || join(env.USERPROFILE || env.HOME || homedir(), '.claude');
}

/** Where the generated worker for a scope lives. */
export function workerAgentPath(scope, { cwd = process.cwd(), env = process.env } = {}) {
  return scope === 'project'
    ? join(cwd, '.claude', 'agents', `${PROJECT_WORKER}.md`)
    : join(configDir(env), 'agents', `${USER_WORKER}.md`);
}

function readSections(path) {
  try {
    return parseBrief(readFileSync(path, 'utf8'));
  } catch {
    return [];
  }
}

const render = (list) => list.map((s) => (s.heading ? `## ${s.heading}\n${s.text}` : s.text)).join('\n\n');

/**
 * The generated worker agent for a scope, from the approved briefs: the
 * user's always-sent sections, then the project's for the project worker.
 * Null when there is nothing always-sent to carry.
 */
export function renderWorkerAgent(scope, { cwd = process.cwd(), env = process.env } = {}) {
  const { global, project } = briefPaths({ cwd, env });
  const sources = scope === 'project' ? [global, project] : [global];
  const always = sources.flatMap((p) => (p ? readSections(p) : [])).filter((s) => !s.when);
  const name = scope === 'project' ? PROJECT_WORKER : USER_WORKER;
  return [
    '---',
    `name: ${name}`,
    "description: A general-purpose agent that starts lean, carrying the user's approved agent brief instead of their instruction files. Generated by token-optimizer-agent-brief approve; regenerated on every approve.",
    'model: inherit',
    'omitClaudeMd: true',
    'disallowedTools: Skill',
    '---',
    '',
    WORKER_BODY,
    ...(always.length ? ['', `# Rules from the user's instructions`, '', render(always)] : []),
    '',
  ].join('\n');
}

/** When the session in `transcriptPath` started, from its first timestamped entry; null when unknown. */
export function sessionStartedAt(transcriptPath) {
  if (!transcriptPath) return null;
  try {
    const handle = openSync(transcriptPath, 'r');
    try {
      const buffer = Buffer.allocUnsafe(64 * 1024);
      const got = readSync(handle, buffer, 0, buffer.length, 0);
      for (const line of buffer.toString('utf8', 0, got).split('\n')) {
        const at = /"timestamp":"([^"]+)"/.exec(line);
        if (at && Number.isFinite(Date.parse(at[1]))) return Date.parse(at[1]);
      }
    } finally {
      closeSync(handle);
    }
  } catch {
    /* unknown */
  }
  return null;
}

/**
 * The generated worker this session can run, or null.
 *
 * ONLY ONE THAT EXISTED WHEN THE SESSION STARTED. Claude Code reads agent
 * definitions at startup; a spawn naming an agent written after that would
 * fail, so an agent file newer than the session -- or a session whose start is
 * unknown -- is not used.
 */
export function generatedWorker({ cwd = process.cwd(), env = process.env, sessionStart = null } = {}) {
  if (!Number.isFinite(sessionStart)) return null;
  for (const [scope, name] of [['project', PROJECT_WORKER], ['user', USER_WORKER]]) {
    const path = workerAgentPath(scope, { cwd, env });
    try {
      if (statSync(path).mtimeMs <= sessionStart) return { name, scope };
    } catch {
      /* not generated */
    }
  }
  return null;
}

/** The approved brief's scoped sections that `task` names, or null. */
export function scopedBriefFor(task, { cwd = process.cwd(), env = process.env, scope = 'project' } = {}) {
  const { global, project } = briefPaths({ cwd, env });
  const sources = scope === 'project' ? [global, project] : [global];
  const picked = sources
    .flatMap((p) => (p ? readSections(p) : []))
    .filter((s) => s.when && s.when.some((w) => mentions(String(task || ''), w)));
  return picked.length ? render(picked) : null;
}

const withRules = (rules, prompt) =>
  `${BRIEF_MARKER} Rules from the user's instructions that apply to this task:\n\n${rules}\n\n---\n\n${prompt}`;

/**
 * The routed input for one general-purpose spawn, or null to leave it alone.
 *
 * Routed only when routing is not off, the spawn is general-purpose (or names
 * no type, which means general-purpose), and an approved brief exists -- to the
 * generated worker when this session can run it, with only the scoped sections
 * the task names in its prompt; otherwise to the plugin's worker, when the
 * plugin is loaded, with the whole applicable brief in its prompt. A user's own
 * agent types, built-ins and forks are never touched.
 */
export function routeToWorker(input, { cwd = process.cwd(), env = process.env, sessionStart = null } = {}) {
  if (/^(off|0|false|no)$/i.test(String(env.TOKEN_OPTIMIZER_AGENT_ROUTE || '').trim())) return null;
  if (!input || typeof input.prompt !== 'string' || !input.prompt.trim()) return null;
  const type = input.subagent_type;
  if (input.prompt.includes(BRIEF_MARKER)) return null;
  const { global, project } = briefPaths({ cwd, env });
  if (!(existsSync(global) || (project && existsSync(project)))) return null;
  // A WORKER NAMED DIRECTLY IS ROUTED TOO. Once a session knows its agents get
  // the brief, the parent picks the worker type itself -- measured on #567's
  // bench, 2 of 3 runs -- and a spawn left alone for not being general-purpose
  // lost the model routing and, for the plugin's worker, the brief: its parent
  // then wrote the rules into every prompt. The type it named is kept.
  if (type === USER_WORKER || type === PROJECT_WORKER) {
    const scoped = scopedBriefFor(input.prompt, { cwd, env, scope: type === PROJECT_WORKER ? 'project' : 'user' });
    return { ...input, prompt: scoped ? withRules(scoped, input.prompt) : input.prompt };
  }
  if (type === WORKER_AGENT) {
    const brief = briefFor(input.prompt, { cwd, env });
    return brief ? { ...input, prompt: withRules(brief, input.prompt) } : { ...input };
  }
  if (type !== undefined && type !== null && type !== '' && type !== 'general-purpose') return null;
  const generated = generatedWorker({ cwd, env, sessionStart });
  if (generated) {
    const scoped = scopedBriefFor(input.prompt, { cwd, env, scope: generated.scope });
    return { ...input, subagent_type: generated.name, prompt: scoped ? withRules(scoped, input.prompt) : input.prompt };
  }
  if (!workerAvailable(env)) return null;
  const brief = briefFor(input.prompt, { cwd, env });
  if (!brief) return null;
  return { ...input, subagent_type: WORKER_AGENT, prompt: withRules(brief, input.prompt) };
}

/** Is `type` one of the workers this package routes to? */
export const isWorkerType = (type) => type === WORKER_AGENT || type === USER_WORKER || type === PROJECT_WORKER;
