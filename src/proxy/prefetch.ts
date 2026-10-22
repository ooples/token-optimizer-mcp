/**
 * First-turn prefetch: the issue or pull request a subagent's task names,
 * fetched before its first call and placed beside the task.
 *
 * WHAT IT REPLACES. Measured on the 10-agent campaign's workers: 21 calls whose
 * only job was fetching the issue or PR their task named (`gh issue view`,
 * `gh api repos/.../issues/N`), 41k characters, each call re-reading about 31k
 * tokens of context first. Fetched once here, the content arrives in the first
 * request and those turns never happen.
 *
 * ONLY WHAT THE TASK ASSIGNS: a reference introduced as the agent's item --
 * "ISSUE owner/repo #N", "PR owner/repo#N", "pull request owner/repo #N" --
 * at most two. Lists of references in passing ("Excluded entirely:
 * owner/repo#2294, ...") are never fetched.
 *
 * Fetched with the user's own `gh` (async, bounded, no console window), cached
 * per reference so siblings share one fetch, and pinned per conversation like
 * the repository pack, so every turn carries the same bytes.
 *
 * OPT-IN (TOKEN_OPTIMIZER_PROXY_PREFETCH=1), MEASURED AGAINST. On the 10-agent
 * campaign replay (3 runs each, 2026-10-22) it reached 59 requests per run, yet
 * workers still made 17 `gh` calls of their own (22 without it), and the runs
 * cost 683k-753k with it against 578k-694k without: every later turn re-reads
 * the prefetched text, and the agents fetch what they want anyway.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ProviderRequest } from '../compress/frontier.js';
import { isSubagentRequest } from '../compress/subagent-context.js';
import { optimizerHome } from './default-routing.js';
import { isNewConversation, taskOf } from './repo-pack.js';

export const PREFETCH_HEADING = '# Prefetched for this task:';
const GH_TIMEOUT_MS = 6_000;
const MAX_WAIT_MS = 6_000;
const BODY_CHARS = 4_000;
const COMMENT_CHARS = 700;
const COMMENTS = 5;
/** A fetched item is reused by siblings for this long. */
const FRESH_MS = 10 * 60_000;

export function prefetchEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(1|true|yes|on)$/i.test(
    String(env.TOKEN_OPTIMIZER_PROXY_PREFETCH ?? '').trim()
  );
}

export interface ItemRef {
  readonly owner: string;
  readonly repo: string;
  readonly number: number;
}

const ASSIGNED =
  /\b(?:issue|pr|pull request)\b\s*:?\s*([A-Za-z0-9][\w.-]*)\/([A-Za-z0-9][\w.-]*?)\s*#(\d+)\b/gi;

/** The issues and pull requests a task assigns, in order, at most two. */
export function assignedItems(task: string): ItemRef[] {
  const out: ItemRef[] = [];
  for (const m of task.matchAll(ASSIGNED)) {
    // Not a reference made in passing inside an exclusion.
    const before = task.slice(Math.max(0, m.index - 80), m.index);
    if (
      /exclud|do not|don't|skip|ignore/i.test(before.split(/[.\n]/).pop() ?? '')
    )
      continue;
    const ref = { owner: m[1], repo: m[2], number: Number(m[3]) };
    if (
      !out.some(
        (r) =>
          r.owner === ref.owner &&
          r.repo === ref.repo &&
          r.number === ref.number
      )
    )
      out.push(ref);
    if (out.length >= 2) break;
  }
  return out;
}

export type GhRunner = (args: string[]) => Promise<string | null>;

export const runGh: GhRunner = (args) =>
  new Promise((resolve) => {
    let settled = false;
    let child: ReturnType<typeof spawn> | undefined;
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
    }, GH_TIMEOUT_MS);
    try {
      child = spawn('gh', args, {
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      });
    } catch {
      done(null);
      return;
    }
    const chunks: Buffer[] = [];
    child.stdout?.on('data', (c: Buffer) => chunks.push(c));
    child.on('error', () => done(null));
    child.on('close', (code) =>
      done(code === 0 ? Buffer.concat(chunks).toString('utf8') : null)
    );
  });

const clip = (s: string, n: number): string =>
  s.length <= n
    ? s
    : `${s.slice(0, n)}\n[... ${s.length - n} more characters; fetch the item for the rest]`;

/** One item, rendered for the model, or null when it could not be fetched. */
export async function fetchItem(
  ref: ItemRef,
  gh: GhRunner = runGh
): Promise<string | null> {
  const path = `repos/${ref.owner}/${ref.repo}/issues/${ref.number}`;
  const [itemRaw, commentsRaw] = await Promise.all([
    gh(['api', path]),
    gh(['api', `${path}/comments?per_page=100`]),
  ]);
  if (!itemRaw) return null;
  let item: {
    title?: string;
    state?: string;
    body?: string | null;
    labels?: { name?: string }[];
    pull_request?: unknown;
    user?: { login?: string };
  };
  try {
    item = JSON.parse(itemRaw);
  } catch {
    return null;
  }
  let comments: {
    user?: { login?: string };
    body?: string;
    created_at?: string;
  }[] = [];
  try {
    comments = JSON.parse(commentsRaw ?? '[]');
  } catch {
    comments = [];
  }
  const kind = item.pull_request ? 'pull request' : 'issue';
  const labels = (item.labels ?? []).map((l) => l.name).filter(Boolean);
  const last = comments.slice(-COMMENTS);
  return [
    `## ${ref.owner}/${ref.repo}#${ref.number} (${kind}, ${item.state ?? 'unknown'}): ${item.title ?? ''}`,
    labels.length ? `Labels: ${labels.join(', ')}` : '',
    '',
    clip(String(item.body ?? '').trim() || '(no description)', BODY_CHARS),
    comments.length
      ? `\n### Comments (last ${last.length} of ${comments.length})\n` +
        last
          .map(
            (c) =>
              `- ${c.user?.login ?? '?'} (${String(c.created_at ?? '').slice(0, 10)}): ${clip(String(c.body ?? '').trim(), COMMENT_CHARS)}`
          )
          .join('\n')
      : '',
  ]
    .filter((l) => l !== '')
    .join('\n');
}

const digest = (s: string): string =>
  createHash('sha256').update(s).digest('hex').slice(0, 24);

export interface PrefetchOutcome {
  readonly text: string | null;
  readonly reason: string;
}

/** Prefetched items per conversation, pinned on disk like repository packs. */
export class Prefetcher {
  private readonly dir: string;
  private readonly gh: GhRunner;
  private readonly now: () => number;
  private readonly items = new Map<
    string,
    { at: number; text: Promise<string | null> }
  >();
  private readonly pins = new Map<string, string>();
  /** First requests in flight, so a retry racing the original pins the same bytes. */
  private readonly pending = new Map<string, Promise<PrefetchOutcome>>();

  constructor(
    options: { dir?: string; gh?: GhRunner; now?: () => number } = {}
  ) {
    this.dir = options.dir ?? join(optimizerHome(), 'prefetch');
    this.gh = options.gh ?? runGh;
    this.now = options.now ?? Date.now;
  }

  async forRequest(
    request: ProviderRequest,
    convKey: string
  ): Promise<PrefetchOutcome> {
    if (!isSubagentRequest(request))
      return { text: null, reason: 'not-subagent' };
    const task = taskOf(request);
    const key = digest(`${convKey}\0${task}`);
    const pinned = await this.pinOf(key);
    if (pinned !== undefined)
      return { text: pinned === '' ? null : pinned, reason: 'pinned' };
    if (!isNewConversation(request)) return { text: null, reason: 'not-new' };
    const inFlight = this.pending.get(key);
    if (inFlight) return inFlight;
    const outcome = this.first(key, task);
    this.pending.set(key, outcome);
    try {
      return await outcome;
    } finally {
      this.pending.delete(key);
    }
  }

  private async first(key: string, task: string): Promise<PrefetchOutcome> {
    const refs = assignedItems(task);
    if (!refs.length) {
      await this.pin(key, '');
      return { text: null, reason: 'none-assigned' };
    }
    let timer: NodeJS.Timeout | undefined;
    const fetched = await Promise.race([
      Promise.all(refs.map((r) => this.item(r))),
      new Promise<'timeout'>((r) => {
        timer = setTimeout(() => r('timeout'), MAX_WAIT_MS);
      }),
    ]);
    clearTimeout(timer);
    const parts =
      fetched === 'timeout' ? [] : fetched.filter((t): t is string => !!t);
    const text = parts.length
      ? `${PREFETCH_HEADING} fetched before your first turn, current as of this conversation's start; no need to fetch it again.\n\n${parts.join('\n\n')}`
      : '';
    await this.pin(key, text);
    return {
      text: text || null,
      reason: text ? 'new' : fetched === 'timeout' ? 'timeout' : 'unfetched',
    };
  }

  private item(ref: ItemRef): Promise<string | null> {
    const id = `${ref.owner}/${ref.repo}#${ref.number}`.toLowerCase();
    const hit = this.items.get(id);
    if (hit && this.now() - hit.at < FRESH_MS) return hit.text;
    const text = fetchItem(ref, this.gh).catch(() => null);
    this.items.set(id, { at: this.now(), text });
    return text;
  }

  private async pinOf(key: string): Promise<string | undefined> {
    const mem = this.pins.get(key);
    if (mem !== undefined) return mem;
    try {
      const v = await readFile(join(this.dir, key), 'utf8');
      this.pins.set(key, v);
      return v;
    } catch {
      return undefined;
    }
  }

  private async pin(key: string, text: string): Promise<void> {
    this.pins.set(key, text);
    if (this.pins.size > 5_000)
      this.pins.delete(this.pins.keys().next().value as string);
    try {
      await mkdir(this.dir, { recursive: true });
      const tmp = join(this.dir, `${key}.${process.pid}.${Date.now()}.tmp`);
      await writeFile(tmp, text, 'utf8');
      await rename(tmp, join(this.dir, key));
    } catch {
      // Kept in memory for this proxy's life.
    }
  }
}
