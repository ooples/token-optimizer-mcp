/**
 * The shared repository pack: one snapshot of a repository, identical for every
 * agent and instance working on it, in the cached prefix.
 *
 * WHAT IT REPLACES. Measured on a 10-agent campaign, each worker spent its first
 * two to four calls -- at 40-60k context apiece -- on `git branch -a`, `ls` and
 * `git show master:file`, re-discovering what its siblings had already found.
 * Every one of those calls re-reads the whole context, so a discovery turn costs
 * far more than the tokens of its answer.
 *
 * WHY IT IS CHEAP. The prompt cache is shared across conversations with an
 * identical prefix. The pack is built once per repository and base commit and
 * served byte for byte to everyone, so one agent writes it (1.25x) and every
 * other agent and instance on the repository reads it (0.1x).
 *
 * BYTE-STABILITY, three ways:
 *   - Built from git OBJECTS at the base branch tip (`origin/HEAD`, else
 *     master/main), never the working tree, so every worktree of a repository
 *     gets the same bytes.
 *   - Kept on disk, so separate proxies and instances serve the bytes the first
 *     builder wrote instead of rebuilding their own.
 *   - PINNED PER CONVERSATION. A conversation keeps the pack it started with for
 *     its whole life, even after a commit moves the base: changing the prefix
 *     mid-conversation would re-write everything behind it. A conversation that
 *     started without one never gets one, for the same reason.
 *
 * WHERE. Appended to `system`, carrying the system prompt's last cache marker,
 * so the pack sits inside the most widely shared cached region without
 * spending a marker.
 *
 * TOKEN_OPTIMIZER_PROXY_REPO_PACK=0 turns it off;
 * TOKEN_OPTIMIZER_PROXY_REPO_PACK_CHARS sets its budget.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdir,
  readFile,
  readdir,
  rename,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Block, Message, ProviderRequest } from '../compress/frontier.js';
import {
  MAX_CACHE_MARKERS,
  markersInOrder,
} from '../compress/sibling-prefix.js';
import { isSubagentRequest } from '../compress/subagent-context.js';
import { optimizerHome } from './default-routing.js';

/**
 * EVERY CALL RE-READS THE PACK, so it has to remove more than it adds. Measured
 * (isolated harness, n=5 per arm, cost vs the same build without a pack): a 5k
 * pack cut the fix task to 77%; on exploration of a 4.8k-file repository a 24k
 * pack cost 102-111% and an 8k pack 100.4% -- fewer calls, more re-read.
 */
export const DEFAULT_PACK_CHARS = 8_000;
/** A pack for an unchanged base is rebuilt at most this often (branch list, findings). */
export const REBUILD_MS = 60 * 60_000;
/** How long a conversation's pin, and the pack it names, are kept. */
export const PIN_MS = 24 * 60 * 60_000;
/** Longest a new conversation waits for a pack being built. */
export const MAX_WAIT_MS = 5_000;
const GIT_TIMEOUT_MS = 10_000;
const MAX_GIT_OUTPUT = 64 * 1024 * 1024;

/** First line of every pack; also how an already-injected request is recognised. */
export const PACK_HEADING = '# Repository pack:';

export function repoPackEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return !/^(0|false|no|off)$/i.test(
    String(env.TOKEN_OPTIMIZER_PROXY_REPO_PACK ?? '').trim()
  );
}

/**
 * The task-path pack, for a subagent of a session started outside any
 * repository, is OPT-IN (TOKEN_OPTIMIZER_PROXY_REPO_PACK_TASK=1), on
 * measurement. Campaign replay, real environment, n=4 per arm, every turn
 * carrying the pack: 107.4% of the same build's cost without it, with calls
 * unchanged (107 vs 106). Those workers' discovery is issues and pull
 * requests, which a repository snapshot does not replace, so every call paid
 * to re-read it for nothing.
 */
export function taskPackEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(1|true|yes|on)$/i.test(
    String(env.TOKEN_OPTIMIZER_PROXY_REPO_PACK_TASK ?? '').trim()
  );
}

export function packCharsFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.TOKEN_OPTIMIZER_PROXY_REPO_PACK_CHARS);
  return Number.isFinite(n) && n >= 2_000 ? Math.floor(n) : DEFAULT_PACK_CHARS;
}

function textsOf(request: ProviderRequest): string[] {
  const out: string[] = [];
  const add = (content: unknown): void => {
    if (typeof content === 'string') out.push(content);
    else if (Array.isArray(content))
      for (const b of content)
        if (typeof (b as Block)?.text === 'string')
          out.push(String((b as Block).text));
  };
  add(request.system);
  for (const m of request.messages ?? []) add(m?.content);
  return out;
}

/**
 * The session's working directory, when the client says it is a git repository.
 * Claude Code states both in its environment section.
 */
export function workingRepoOf(request: ProviderRequest): string | null {
  for (const text of textsOf(request)) {
    const m =
      /Primary working directory: ([^\n]+)\n[\s\S]{0,200}?Is a git repository: (true|false)/.exec(
        text
      );
    if (m) return m[2] === 'true' ? m[1].trim() : null;
  }
  return null;
}

/** No assistant turn yet: the only request on which a pack may be added. */
export function isNewConversation(request: ProviderRequest): boolean {
  return !(request.messages ?? []).some((m) => m?.role === 'assistant');
}

/** An agent loop rather than one of the client's small utility calls. */
function isAgentic(request: ProviderRequest): boolean {
  const tools = (request as { tools?: unknown }).tools;
  return Array.isArray(tools) && tools.length > 0;
}

function alreadyPacked(request: ProviderRequest): boolean {
  return textsOf(request).some((t) => t.startsWith(PACK_HEADING));
}

/**
 * Append the pack to `system`, moving the system prompt's last cache marker onto
 * it so the cached region ends after the pack. No marker is added.
 */
export function injectPack(
  request: ProviderRequest,
  text: string
): ProviderRequest {
  const system = request.system;
  if (Array.isArray(system) && system.length > 0) {
    const last = system[system.length - 1] as Block & {
      cache_control?: unknown;
    };
    if (last?.cache_control) {
      const { cache_control, ...bare } = last;
      return {
        ...request,
        system: [
          ...system.slice(0, -1),
          bare as Block,
          { type: 'text', text, cache_control } as Block,
        ],
      };
    }
    return { ...request, system: [...system, { type: 'text', text } as Block] };
  }
  const existing = typeof system === 'string' ? system : '';
  return { ...request, system: `${existing}${existing ? '\n\n' : ''}${text}` };
}

/** The same directory, however it was spelled. */
export function samePath(a: string, b: string): boolean {
  const norm = (p: string): string => {
    const r = resolve(p).replace(/\\/g, '/').replace(/\/$/, '');
    return process.platform === 'win32' ? r.toLowerCase() : r;
  };
  return norm(a) === norm(b);
}

/**
 * Put the pack at the head of a subagent's task turn, AFTER the prefix its
 * siblings share. Only in the shape the sibling-prefix reorder produces --
 * shared leading turn, the system-role listing, then the task in a turn of its
 * own -- and otherwise not at all (null).
 *
 * The pack carries a copy of the listing's cache marker when the request has a
 * marker to spare, so siblings on the same repository read it from the cache.
 * A copy of the PRECEDING marker always satisfies the API's ordering rule
 * (longer-lived markers first).
 */
export function injectTaskPack(
  request: ProviderRequest,
  text: string
): ProviderRequest | null {
  const messages = request.messages;
  const listing = messages?.[1];
  const task = messages?.[2];
  if (
    !messages ||
    listing?.role !== 'system' ||
    task?.role !== 'user' ||
    !Array.isArray(task.content) ||
    !Array.isArray(listing.content)
  )
    return null;
  const before = [...listing.content]
    .reverse()
    .map((b) => (b as Block & { cache_control?: unknown }).cache_control)
    .find(Boolean);
  const spare = markersInOrder(request).length < MAX_CACHE_MARKERS;
  const block = {
    type: 'text',
    text,
    ...(spare && before ? { cache_control: { ...(before as object) } } : {}),
  } as Block;
  return {
    ...request,
    messages: [
      messages[0],
      listing,
      { ...task, content: [block, ...task.content] } as Message,
      ...messages.slice(3),
    ],
  };
}

/**
 * The pack just before the task, inside the first user turn: the shape of a
 * subagent's later turns, which no longer carry the system-role listing. No
 * marker is added; Claude Code's own trailing marker caches it from then on.
 */
export function injectPackBeforeTask(
  request: ProviderRequest,
  text: string
): ProviderRequest | null {
  const messages = request.messages;
  const first = messages?.[0];
  if (!messages || first?.role !== 'user' || !Array.isArray(first.content))
    return null;
  const blocks = first.content as Block[];
  const task = blocks.length - 1;
  if (task < 0 || typeof blocks[task]?.text !== 'string') return null;
  return {
    ...request,
    messages: [
      {
        ...first,
        content: [
          ...blocks.slice(0, task),
          { type: 'text', text } as Block,
          blocks[task],
        ],
      } as Message,
      ...messages.slice(1),
    ],
  };
}

export type GitRunner = (
  cwd: string,
  args: string[],
  timeoutMs?: number
) => Promise<string | null>;

/**
 * Async, never sync, and never starting git's fsmonitor daemon: the daemon
 * inherits the caller's pipes, so a call that starts it never sees them close.
 */
export const runGit: GitRunner = (cwd, args, timeoutMs = GIT_TIMEOUT_MS) =>
  new Promise((resolve) => {
    let settled = false;
    const done = (v: string | null): void => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(v);
      }
    };
    const timer = setTimeout(() => {
      child?.kill();
      done(null);
    }, timeoutMs);
    let child: ReturnType<typeof spawn> | undefined;
    try {
      child = spawn(
        'git',
        [
          '-c',
          'core.fsmonitor=false',
          '-c',
          'core.quotepath=false',
          '-C',
          cwd,
          ...args,
        ],
        { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }
      );
    } catch {
      done(null);
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    child.stdout?.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_GIT_OUTPUT) {
        child?.kill();
        done(null);
      } else chunks.push(chunk);
    });
    child.on('error', () => done(null));
    child.on('close', (code) =>
      done(code === 0 ? Buffer.concat(chunks).toString('utf8') : null)
    );
  });

export interface Repo {
  readonly top: string;
  readonly commonDir: string;
  readonly baseRef: string;
  readonly baseSha: string;
}

export async function resolveRepo(
  dir: string,
  git: GitRunner = runGit
): Promise<Repo | null> {
  const out = await git(dir, [
    'rev-parse',
    '--path-format=absolute',
    '--show-toplevel',
    '--git-common-dir',
  ]);
  const [top, commonDir] = (out ?? '').split(/\r?\n/).map((s) => s.trim());
  if (!top || !commonDir) return null;
  // ONE CALL for every candidate base, not a probe each: on the first request
  // of a fan-out this sits on the path the agent is waiting on.
  const refs = await git(dir, [
    'for-each-ref',
    '--format=%(refname:short)\t%(objectname)\t%(symref:short)',
    'refs/remotes/origin/HEAD',
    'refs/remotes/origin/master',
    'refs/remotes/origin/main',
    'refs/heads/master',
    'refs/heads/main',
  ]);
  const sha = new Map<string, string>();
  let originHead: string | undefined;
  for (const line of (refs ?? '').split(/\r?\n/)) {
    const [name, object, target] = line.split('\t');
    if (!name || !object) continue;
    // origin/HEAD prints as `origin`; its target names the default branch.
    if (target) originHead = target;
    else sha.set(name, object);
  }
  const shape = (baseRef: string, baseSha: string): Repo => ({
    top,
    commonDir: commonDir.replace(/\\/g, '/').replace(/\/$/, ''),
    baseRef,
    baseSha,
  });
  for (const ref of [
    originHead,
    'origin/master',
    'origin/main',
    'master',
    'main',
  ]) {
    const found = ref ? sha.get(ref) : undefined;
    if (ref && found) return shape(ref, found);
  }
  const head = (
    await git(dir, ['rev-parse', '--verify', '-q', 'HEAD^{commit}'])
  )?.trim();
  return head ? shape('HEAD', head) : null;
}

const OUTLINEABLE = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|rb|php|cs)$/i;
const MANIFESTS =
  /^(package\.json|pyproject\.toml|setup\.py|Cargo\.toml|go\.mod|Makefile|CMakeLists\.txt|pom\.xml|build\.gradle(\.kts)?|Gemfile|composer\.json|[^/]+\.sln|Directory\.Build\.props|global\.json)$/;

interface PackFinding {
  claim: string;
  key?: string;
  confidence?: number;
  confidenceLabel?: string;
  scope?: string;
  stale?: boolean;
  retired?: boolean;
  pinned?: boolean;
}

export interface BuildOptions {
  readonly budget: number;
  readonly git?: GitRunner;
  readonly findings?: readonly PackFinding[];
}

type Symbols = (
  path: string,
  text: string
) => { name: string; line?: number; indent?: number }[];
let symbolsModule: Promise<Symbols | null> | null = null;
function loadSymbols(): Promise<Symbols | null> {
  symbolsModule ??= (async () => {
    try {
      const here = new URL('.', import.meta.url);
      const url = pathToFileURL(
        fileURLToPath(new URL('../../hooks-core/symbols.mjs', here))
      ).href;
      return ((await import(url)) as { extractSymbols: Symbols })
        .extractSymbols;
    } catch {
      return null;
    }
  })();
  return symbolsModule;
}

function section(title: string, lines: string[], cap: number): string {
  if (!lines.length) return '';
  let out = `\n## ${title}\n`;
  for (const line of lines) {
    if (out.length + line.length + 1 > cap) {
      out += '...\n';
      break;
    }
    out += `${line}\n`;
  }
  return out;
}

function structureOf(files: string[]): string[] {
  const dirs = new Map<string, number>();
  const rootFiles: string[] = [];
  for (const f of files) {
    const parts = f.split('/');
    if (parts.length === 1) {
      rootFiles.push(f);
      continue;
    }
    dirs.set(parts[0] + '/', (dirs.get(parts[0] + '/') ?? 0) + 1);
    if (parts.length > 2) {
      const sub = `${parts[0]}/${parts[1]}/`;
      dirs.set(sub, (dirs.get(sub) ?? 0) + 1);
    }
  }
  const lines = [...dirs.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([d, n]) => `${d.split('/').length > 2 ? '  ' : ''}${d} (${n} files)`);
  if (rootFiles.length)
    lines.push(`root files: ${rootFiles.sort().join(', ')}`);
  return lines;
}

/** The pack text. Deterministic for a given repository state. */
export async function buildPack(
  repo: Repo,
  options: BuildOptions
): Promise<string | null> {
  const git = options.git ?? runGit;
  const sha = repo.baseSha;
  const budget = options.budget;
  const listing = await git(repo.commonDir, ['ls-tree', '-r', '-z', sha]);
  if (listing === null) return null;
  // "<mode> blob <id>\t<path>": the blob id is what tells a synced copy from its source.
  const blobOf = new Map<string, string>();
  for (const entry of listing.split('\0')) {
    const tab = entry.indexOf('\t');
    if (tab > 0)
      blobOf.set(entry.slice(tab + 1), entry.slice(0, tab).split(' ')[2] ?? '');
  }
  const files = [...blobOf.keys()];
  const inTree = blobOf;

  const [log, refs, churn] = await Promise.all([
    git(repo.commonDir, [
      'log',
      '-n',
      '25',
      '--format=%h %ad %s',
      '--date=short',
      sha,
    ]),
    git(repo.commonDir, [
      'for-each-ref',
      '--sort=-committerdate',
      '--count=40',
      '--format=%(refname:short) %(objectname:short) %(committerdate:short)',
      'refs/heads',
      'refs/remotes',
    ]),
    git(repo.commonDir, ['log', '-n', '300', '--format=', '--name-only', sha]),
  ]);

  // The REPOSITORY's name, not this worktree's folder: every worktree must get the same bytes.
  const name = /\.git$/.test(repo.commonDir)
    ? basename(dirname(repo.commonDir))
    : basename(repo.commonDir);
  let text =
    `${PACK_HEADING} ${name} @ ${sha.slice(0, 10)} (${repo.baseRef})\n` +
    `A shared snapshot of this repository, built from git at ${repo.baseRef} ${sha.slice(0, 10)} and ` +
    'identical for every agent working on it, so it is read from the prompt cache. It shows the committed ' +
    'base branch, not uncommitted changes or newer commits. Use it instead of re-listing branches, the tree ' +
    'or history; ask git only for state newer than this.\n';

  // Build and test commands: what an agent otherwise reads package.json for.
  const manifestLines: string[] = files
    .filter((f) => MANIFESTS.test(f))
    .map((f) => `manifest: ${f}`);
  if (inTree.has('package.json')) {
    const pkg = await git(repo.commonDir, ['show', `${sha}:package.json`]);
    try {
      const scripts =
        (JSON.parse(pkg ?? '{}') as { scripts?: Record<string, string> })
          .scripts ?? {};
      // The everyday commands first; the long tail of tooling scripts after.
      const rank = (k: string): number =>
        /^(build|test|lint|typecheck|format|check|start|dev)(:|$)/.test(k)
          ? 0
          : 1;
      for (const [k, v] of Object.entries(scripts).sort(
        ([a], [b]) => rank(a) - rank(b) || (a < b ? -1 : 1)
      ))
        manifestLines.push(`npm run ${k}: ${String(v).slice(0, 140)}`);
    } catch {
      // A package.json that does not parse simply contributes no scripts.
    }
  }
  text += section('Build and test', manifestLines, Math.floor(budget * 0.12));
  text += section(
    `Tree at ${repo.baseRef} (${files.length} tracked files)`,
    structureOf(files),
    Math.floor(budget * 0.2)
  );
  text += section(
    'Branches, most recent first',
    (refs ?? '').split(/\r?\n/).filter(Boolean),
    Math.floor(budget * 0.08)
  );
  text += section(
    `Recent commits on ${repo.baseRef}`,
    (log ?? '').split(/\r?\n/).filter(Boolean),
    Math.floor(budget * 0.1)
  );

  const facts = (options.findings ?? [])
    .filter(
      (f) =>
        !f.retired &&
        !f.stale &&
        f.scope !== 'global' &&
        (f.confidence ?? 0.9) >= 0.5
    )
    .filter((f) => f.confidenceLabel !== 'speculative')
    .sort(
      (a, b) =>
        Number(!!b.pinned) - Number(!!a.pinned) ||
        (b.confidence ?? 0.9) - (a.confidence ?? 0.9) ||
        String(a.key ?? a.claim).localeCompare(String(b.key ?? b.claim))
    )
    .map((f) => `- ${f.claim.replace(/\s+/g, ' ').slice(0, 300)}`);
  text += section(
    'Established facts (from the shared knowledge graph)',
    facts,
    Math.floor(budget * 0.15)
  );

  // The most-changed source files, outlined with line numbers, filling what is left.
  const counts = new Map<string, number>();
  for (const f of (churn ?? '').split(/\r?\n/))
    if (f && inTree.has(f) && OUTLINEABLE.test(f))
      counts.set(f, (counts.get(f) ?? 0) + 1);
  // One outline per distinct CONTENT: a file synced into several places is outlined once.
  const seenBlobs = new Set<string>();
  const hot = [...counts.entries()]
    // Ties go to the shallower path: the source, not the copy synced deeper.
    .sort(
      ([a, x], [b, y]) =>
        y - x || a.split('/').length - b.split('/').length || (a < b ? -1 : 1)
    )
    .map(([f]) => f)
    .filter((f) => {
      const blob = blobOf.get(f) || f;
      if (seenBlobs.has(blob)) return false;
      seenBlobs.add(blob);
      return true;
    })
    .slice(0, 24);
  const outlined: [string, number][] = [];
  const extract = await loadSymbols();
  if (extract && hot.length) {
    let outlines =
      '\n## Outlines of the most-changed files (line numbers at the base commit)\n';
    for (const file of hot) {
      const room = budget - text.length - outlines.length;
      if (room < 400) break;
      const source = await git(repo.commonDir, ['show', `${sha}:${file}`]);
      if (!source || source.length > 400_000) continue;
      const lines = source.split(/\r?\n/);
      // A synced copy with a header of its own: same name, near-identical length.
      const twin = [...outlined].some(
        ([n, len]) =>
          n === basename(file) &&
          Math.abs(len - lines.length) <= Math.max(3, len * 0.02)
      );
      if (twin) continue;
      outlined.push([basename(file), lines.length]);
      let block = `### ${file} (${lines.length} lines)\n`;
      for (const s of extract(file, source).slice(0, 40)) {
        const raw = (lines[(s.line ?? 1) - 1] ?? s.name).trim();
        const line = `${String(s.line ?? '').padStart(5)} ${raw.length > 110 ? `${raw.slice(0, 107)}...` : raw}\n`;
        if (block.length + line.length > Math.min(room, 2_400)) break;
        block += line;
      }
      outlines += block;
    }
    text += outlines;
  }
  return text.length > budget
    ? text.slice(0, text.lastIndexOf('\n', budget) + 1)
    : text;
}

const digest = (s: string): string =>
  createHash('sha256').update(s).digest('hex').slice(0, 24);

async function writeAtomic(path: string, text: string): Promise<void> {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, text, 'utf8');
  await rename(tmp, path);
}

/** `system` when the session runs in the repository; `task` for a subagent's named one. */
export type Placement = 'system' | 'task';

export interface PackOutcome {
  readonly text: string | null;
  /** 'pinned' | 'new' | 'not-new' | 'no-repo' | 'not-agentic' | 'timeout' | 'unbuilt' | 'already' | 'off' */
  readonly reason: string;
  readonly placement: Placement | null;
}

/** The task: the last text block of the client's first user turn. */
export function taskOf(request: ProviderRequest): string {
  const first = (request.messages ?? []).find((m) => m?.role === 'user');
  const content = first?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const texts = content
    .filter((b) => typeof (b as Block)?.text === 'string')
    .map((b) => String((b as Block).text));
  return texts[texts.length - 1] ?? '';
}

const ABSOLUTE_PATH =
  /(?<![\w.])(?:[A-Za-z]:[\\/]|\/(?=[\w.-]+\/))[^\s"'`<>|*?,;()]+/g;

/** Absolute paths a text names, in order, without trailing punctuation. */
export function pathsIn(text: string, max = 24): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(ABSOLUTE_PATH)) {
    const p = m[0].replace(/[.:]+$/, '');
    if (p.length > 3 && !out.includes(p)) out.push(p);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * Directories worth asking git about for a path a task names: the path and
 * its parent (it is often a file, or a worktree still to be created). Roots
 * and one-segment paths are skipped: no repository is named that way.
 *
 * NO fs CALLS. A path on a failing drive held its stat calls for seconds and
 * filled Node's file-system thread pool, so the stats for healthy paths
 * behind them timed out and read as missing. Git runs in its own process.
 */
export function candidateDirs(path: string): string[] {
  const clean = path.replace(/[\\/]+$/, '');
  const deep = (p: string): boolean =>
    p.split(/[\\/]/).filter(Boolean).length >= 2;
  return [clean, dirname(clean)].filter(
    (p, i, all) => deep(p) && all.indexOf(p) === i
  );
}

/** Repository resolution normally takes 0.1-0.3 s; past this the path is not worth waiting for. */
const RESOLVE_TIMEOUT_MS = 2_500;

/** The repository's own name (not a worktree folder's). */
export function repoNameOf(repo: Pick<Repo, 'commonDir'>): string {
  return /\.git$/.test(repo.commonDir)
    ? basename(dirname(repo.commonDir))
    : basename(repo.commonDir);
}

const escapeRegExp = (s: string): string =>
  s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Which of the repositories a task names it is ABOUT. Shared campaign rules
 * name every repository to every agent, so presence alone is not enough:
 *   1. a single declared one ("Repo owner/name", "repository: name");
 *   2. else the single one its issue and PR references (`name#123`) point to;
 *   3. else the strictly most-mentioned one.
 * A tie gets no pack: none costs less than the wrong one.
 */
export function chooseRepo<R extends Pick<Repo, 'commonDir'>>(
  task: string,
  repos: readonly R[]
): R | null {
  if (repos.length <= 1) return repos[0] ?? null;
  const named = repos.map((r) => ({ r, name: repoNameOf(r) }));
  const whole = (name: string, suffix = ''): RegExp =>
    new RegExp(
      `(?<![\\w.])(?:[\\w.-]+/)?${escapeRegExp(name)}(?![\\w]|\\.[\\w])${suffix}`,
      'gi'
    );
  const pick = (score: (name: string) => number): R | null => {
    const scored = named
      .map(({ r, name }) => ({ r, n: score(name) }))
      .sort((a, b) => b.n - a.n);
    return scored[0].n > 0 && scored[0].n > (scored[1]?.n ?? 0)
      ? scored[0].r
      : null;
  };
  const declared = pick(
    (name) =>
      (
        task.match(
          new RegExp(
            `\\b(?:repo(?:sitory)?|project)\\b\\s*[:=]?\\s*(?:[\\w.-]+/)?${escapeRegExp(name)}(?![\\w]|\\.[\\w])`,
            'gi'
          )
        ) ?? []
      ).length
  );
  if (declared) return declared;
  const counts = named.map(
    ({ name }) => (task.match(whole(name, '#\\d+')) ?? []).length
  );
  if (counts.filter((n) => n > 0).length === 1)
    return named[counts.findIndex((n) => n > 0)].r;
  return pick((name) => (task.match(whole(name)) ?? []).length);
}

export interface RepoPacksOptions {
  readonly dir?: string;
  readonly git?: GitRunner;
  readonly budget?: number;
  readonly maxWaitMs?: number;
  readonly now?: () => number;
  /** Findings for a repository root; the proxy passes its graph loader. */
  readonly findingsFor?: (root: string) => Promise<readonly PackFinding[]>;
  /** The task-path pack; defaults to taskPackEnabled(). */
  readonly taskPlacement?: boolean;
}

/** Packs and per-conversation pins, in memory and on disk. */
export class RepoPacks {
  private readonly dir: string;
  private readonly git: GitRunner;
  private readonly budget: number;
  private readonly maxWaitMs: number;
  private readonly now: () => number;
  private readonly findingsFor?: RepoPacksOptions['findingsFor'];
  private readonly taskPlacement: boolean;
  private readonly pins = new Map<string, string>();
  private readonly texts = new Map<string, string>();
  private readonly builds = new Map<string, Promise<string | null>>();
  private readonly repos = new Map<string, Promise<Repo | null>>();

  constructor(options: RepoPacksOptions = {}) {
    this.dir = options.dir ?? join(optimizerHome(), 'repo-packs');
    this.git = options.git ?? runGit;
    this.budget = options.budget ?? packCharsFromEnv();
    this.maxWaitMs = options.maxWaitMs ?? MAX_WAIT_MS;
    this.now = options.now ?? Date.now;
    this.findingsFor = options.findingsFor;
    this.taskPlacement = options.taskPlacement ?? taskPackEnabled();
  }

  /** The pack this request should carry, if any. `convKey` is computed on the client's request. */
  async forRequest(
    request: ProviderRequest,
    convKey: string
  ): Promise<PackOutcome> {
    const none = (reason: string): PackOutcome => ({
      text: null,
      reason,
      placement: null,
    });
    if (alreadyPacked(request)) return none('already');
    if (!isAgentic(request)) return none('not-agentic');
    // KEYED BY THE TASK TOO. The conversation key is the system prompt plus the
    // first text block, which every sibling of a fan-out shares; without the
    // task, sibling 1's repository would be pinned onto sibling 2.
    const key = digest(`${convKey}\0${taskOf(request)}`);
    const pinned = await this.pinOf(key);
    if (pinned !== undefined) {
      const [placement, hash] = pinned.split(':');
      if (!hash || (placement !== 'system' && placement !== 'task'))
        return none('pinned');
      return { text: await this.textOf(hash), reason: 'pinned', placement };
    }
    if (!isNewConversation(request)) return none('not-new');
    const cwd = workingRepoOf(request);
    // A session started in a repository packs it in `system`. A subagent of a
    // session started elsewhere packs the repository its task is about, in its
    // task turn, so siblings on different repositories still share all of the
    // prefix before it.
    const placement: Placement | null = cwd
      ? 'system'
      : this.taskPlacement && isSubagentRequest(request)
        ? 'task'
        : null;
    if (!placement) return none('no-repo');
    const build =
      placement === 'system'
        ? this.packFor(cwd as string)
        : this.taskRepo(taskOf(request)).then((r) =>
            r ? this.current(r) : null
          );
    let timer: NodeJS.Timeout | undefined;
    const hash = await Promise.race([
      build,
      new Promise<'timeout'>((r) => {
        timer = setTimeout(() => r('timeout'), this.maxWaitMs);
      }),
    ]);
    clearTimeout(timer);
    if (hash === 'timeout' || hash === null) {
      await this.pin(key, 'none');
      return none(hash === null ? 'unbuilt' : 'timeout');
    }
    await this.pin(key, `${placement}:${hash}`);
    return { text: await this.textOf(hash), reason: 'new', placement };
  }

  /** The repository a task is about, among those it names by absolute path. */
  private async taskRepo(task: string): Promise<Repo | null> {
    // IN PARALLEL, and each repository's pack starts building the moment it
    // resolves: a slow path (a drive spinning up took 2.4 s, measured) then
    // overlaps the build instead of preceding it, and the chosen pack is
    // already in flight when the choice is made.
    const resolved = await Promise.all(
      [...new Set(pathsIn(task).flatMap(candidateDirs))].map(async (dir) => {
        let repo = this.repos.get(dir);
        if (!repo) {
          repo = resolveRepo(dir, (cwd, args) =>
            this.git(cwd, args, RESOLVE_TIMEOUT_MS)
          );
          this.repos.set(dir, repo);
          setTimeout(() => this.repos.delete(dir), 60_000).unref?.();
        }
        const r = await repo;
        if (r) void this.current(r);
        return r;
      })
    );
    const found = new Map<string, Repo>();
    for (const r of resolved)
      if (r && !found.has(r.commonDir)) found.set(r.commonDir, r);
    return chooseRepo(task, [...found.values()]);
  }

  private async pinOf(convKey: string): Promise<string | undefined> {
    const mem = this.pins.get(convKey);
    if (mem !== undefined) return mem;
    try {
      const v = (
        await readFile(join(this.dir, 'pins', convKey), 'utf8')
      ).trim();
      if (v) this.pins.set(convKey, v);
      return v || undefined;
    } catch {
      return undefined;
    }
  }

  private async pin(convKey: string, hash: string): Promise<void> {
    this.pins.set(convKey, hash);
    if (this.pins.size > 5_000)
      this.pins.delete(this.pins.keys().next().value as string);
    try {
      await mkdir(join(this.dir, 'pins'), { recursive: true });
      await writeAtomic(join(this.dir, 'pins', convKey), hash);
    } catch {
      // A pin kept only in memory still holds for this proxy's life.
    }
  }

  private async textOf(hash: string): Promise<string | null> {
    const mem = this.texts.get(hash);
    if (mem !== undefined) return mem;
    try {
      const t = await readFile(join(this.dir, 'packs', `${hash}.txt`), 'utf8');
      this.texts.set(hash, t);
      return t;
    } catch {
      return null;
    }
  }

  /** The current pack's hash for the repository at `cwd`, building it once. */
  private packFor(cwd: string): Promise<string | null> {
    let repo = this.repos.get(cwd);
    if (!repo) {
      repo = resolveRepo(cwd, this.git);
      this.repos.set(cwd, repo);
      // Re-resolved after a while so a moved base is seen.
      setTimeout(() => this.repos.delete(cwd), 60_000).unref?.();
    }
    return repo.then((r) => (r ? this.current(r) : null));
  }

  private current(repo: Repo): Promise<string | null> {
    const id = digest(repo.commonDir);
    const flight = this.builds.get(id);
    if (flight) return flight;
    const run = (async () => {
      const latest = join(this.dir, 'latest', id);
      try {
        const [sha, hash, built] = (await readFile(latest, 'utf8')).split('\n');
        if (
          sha === repo.baseSha &&
          hash &&
          this.now() - Number(built) < REBUILD_MS &&
          (await this.textOf(hash)) !== null
        )
          return hash;
      } catch {
        // No pack yet for this repository.
      }
      const findings = this.findingsFor
        ? await this.findingsFor(
            /\.git$/.test(repo.commonDir) ? dirname(repo.commonDir) : repo.top
          ).catch(() => [])
        : [];
      const text = await buildPack(repo, {
        budget: this.budget,
        git: this.git,
        findings,
      });
      if (!text) return null;
      const hash = digest(text);
      this.texts.set(hash, text);
      try {
        await mkdir(join(this.dir, 'packs'), { recursive: true });
        await mkdir(join(this.dir, 'latest'), { recursive: true });
        await writeAtomic(join(this.dir, 'packs', `${hash}.txt`), text);
        await writeAtomic(latest, `${repo.baseSha}\n${hash}\n${this.now()}`);
      } catch {
        // Served from memory; another proxy builds its own.
      }
      void this.sweep();
      return hash;
    })().finally(() => this.builds.delete(id));
    this.builds.set(id, run);
    return run;
  }

  /** Drop pins and packs nobody has used for PIN_MS. */
  private async sweep(): Promise<void> {
    for (const sub of ['pins', 'packs']) {
      try {
        const dir = join(this.dir, sub);
        for (const name of await readdir(dir)) {
          const path = join(dir, name);
          const s = await stat(path);
          if (this.now() - s.mtimeMs > PIN_MS) await unlink(path);
        }
      } catch {
        // Best effort.
      }
    }
  }
}
