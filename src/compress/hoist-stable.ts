/**
 * Moving the session-invariant part of Claude Code's opening context into the
 * prefix that sessions share.
 *
 * THE COST. Claude Code sends its environment context as a system-role turn
 * right after the first user turn (messages[1]): the SessionStart hook text,
 * the environment, the deferred-tool listing, the agent types, the MCP server
 * instructions and the skills listing. Only a few of those paragraphs change
 * between sessions (working directory, date, budget). But the whole turn sits
 * after the user's task, and the cache markers that hold it are per-session,
 * so every new session writes all of it at the 1h write rate (2x). Measured on
 * routed `claude -p` sessions: the first request of a fresh session wrote
 * 4,301 tokens, of which the stable paragraphs are the large majority.
 *
 * THE MOVE. A paragraph of that turn which already appeared, byte for byte, in
 * an EARLIER session goes into one extra system block, in its original order.
 * The rest stays in messages[1]. The block carries a cache marker, so the
 * moved text becomes part of a prefix the next session reads at 0.1x instead
 * of writing at 2x. Where in the system prompt it goes is placeHoisted's
 * decision, below.
 *
 * WHY "AN EARLIER SESSION", AND NOT A LIST OF HEADINGS. What is stable depends
 * on the install: other plugins add SessionStart text, a learned-pruning
 * notice appears once, the date changes at midnight. Hoisting a paragraph that
 * then changes would rewrite the shared prefix from that point on. Only text a
 * previous session already sent is moved, so a one-off notice stays where it
 * was. The decision is stable within a session: a paragraph is recorded with
 * the first session that sent it and never moves inside that session, and a
 * paragraph recorded with another session moves from that session's first
 * request on.
 *
 * NOTHING IS REMOVED. Every character reaches the model; only its position
 * changes, from a system-role turn to the system prompt. If any step finds a
 * shape it does not expect, the request goes out unchanged.
 */
/* eslint-disable n/no-sync -- SYNCHRONOUS ON PURPOSE: the ledger is consulted
   inside compressBodyOnce, which is synchronous, and its write is the
   write-then-rename supervisor.ts uses so a reader never sees half a file. One
   read per proxy process; one small write per session's first request. */
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Block, Message, ProviderRequest } from './frontier.js';

/** Paragraphs remembered across sessions; the oldest are forgotten first. */
export const MAX_REMEMBERED = 4096;

/** Below this many characters a move is not worth a changed system prompt. */
export const MIN_HOISTED_CHARS = 1000;

const SEPARATOR = '\n\n';

export interface HoistResult {
  readonly request: ProviderRequest;
  /** Characters moved into the system prompt; 0 when nothing was moved. */
  readonly hoistedChars: number;
}

/** Where the ledger persists: hashes only, never the paragraphs themselves. */
export function paragraphLedgerFile(
  env: NodeJS.ProcessEnv = process.env
): string {
  return join(
    env.TOKEN_OPTIMIZER_HOME || join(homedir(), '.token-optimizer'),
    'proxy-paragraphs.json'
  );
}

const digest = (text: string, length: number): string =>
  createHash('sha256').update(text).digest('hex').slice(0, length);

interface LedgerFile {
  readonly schema: 1;
  /** [paragraph hash, first session hash], oldest first. */
  readonly entries: readonly (readonly [string, string])[];
}

/**
 * Which session first sent each paragraph, keyed by hashes so the file holds no
 * conversation text. A Map keeps insertion order, which is what the bound uses
 * to forget the oldest.
 *
 * PERSISTED, because the proxy does not outlive every gap between sessions: it
 * stops when idle, on upgrade and on reboot, and a ledger that forgot each time
 * would never see a paragraph twice. The file is read once, and written only
 * after a request that recorded something new -- the first request of a
 * session, in practice. SYNCHRONOUS, for the reason supervisor.ts gives:
 * write-then-rename so a reader sees the old file or the new one, never half.
 */
export class ParagraphLedger {
  private readonly firstSession = new Map<string, string>();
  private loaded = false;
  private dirty = false;

  constructor(
    private readonly file: string | null = null,
    private readonly limit: number = MAX_REMEMBERED
  ) {}

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    if (!this.file || !existsSync(this.file)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as LedgerFile;
      if (parsed?.schema !== 1 || !Array.isArray(parsed.entries)) return;
      for (const entry of parsed.entries)
        if (
          Array.isArray(entry) &&
          typeof entry[0] === 'string' &&
          typeof entry[1] === 'string'
        )
          this.firstSession.set(entry[0], entry[1]);
    } catch {
      // An unreadable ledger is an empty one: nothing moves until a paragraph
      // is seen again, which is the safe direction.
      this.firstSession.clear();
    }
  }

  /** True when an earlier, different session already sent this paragraph. */
  seenElsewhere(paragraph: string, session: string): boolean {
    this.load();
    const key = digest(paragraph, 32);
    const who = digest(session, 16);
    const first = this.firstSession.get(key);
    if (first === undefined) {
      this.firstSession.set(key, who);
      this.dirty = true;
      if (this.firstSession.size > this.limit) {
        const oldest = this.firstSession.keys().next();
        if (!oldest.done) this.firstSession.delete(oldest.value);
      }
      return false;
    }
    return first !== who;
  }

  /** Write the ledger if this request recorded anything. Never throws. */
  flush(): void {
    if (!this.dirty || !this.file) return;
    this.dirty = false;
    const body: LedgerFile = {
      schema: 1,
      entries: [...this.firstSession.entries()],
    };
    const temporary = `${this.file}.tmp-${process.pid}`;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(temporary, JSON.stringify(body), { mode: 0o600 });
      renameSync(temporary, this.file);
    } catch {
      rmSync(temporary, { force: true });
    }
  }

  get size(): number {
    this.load();
    return this.firstSession.size;
  }
}

/** Claude Code's session id, from `metadata.user_id` (a JSON string). */
export function sessionOf(request: ProviderRequest): string | undefined {
  const metadata = request.metadata as { user_id?: unknown } | undefined;
  const raw = metadata?.user_id;
  if (typeof raw !== 'string') return undefined;
  try {
    const id = (JSON.parse(raw) as { session_id?: unknown }).session_id;
    return typeof id === 'string' && id.length > 0 ? id : undefined;
  } catch {
    return undefined;
  }
}

/** The opening system-role turn: the first system message before any assistant turn. */
function openingContextIndex(messages: Message[]): number {
  for (let i = 0; i < messages.length; i++) {
    const role = messages[i]?.role;
    if (role === 'assistant') return -1;
    if (role === 'system') return i > 0 ? i : -1;
  }
  return -1;
}

/** The turn's text, when it is a plain string or exactly one text block. */
function textOf(
  message: Message
): { text: string; block: Block | null } | null {
  const content = message.content;
  if (typeof content === 'string') return { text: content, block: null };
  if (
    Array.isArray(content) &&
    content.length === 1 &&
    content[0]?.type === 'text' &&
    typeof content[0].text === 'string'
  )
    return { text: content[0].text, block: content[0] };
  return null;
}

function withoutMarker(block: Block): Block {
  const copy: Block = { ...block };
  delete copy.cache_control;
  return copy;
}

/** The API's limit on cache_control markers per request. */
const MAX_CACHE_MARKERS = 4;

/** Every cache marker in the request: tools, system and message blocks. */
function markerCount(request: ProviderRequest): number {
  const marked = (b: unknown): number =>
    (b as Block | null)?.cache_control ? 1 : 0;
  let count = 0;
  for (const tool of request.tools ?? []) count += marked(tool);
  if (Array.isArray(request.system))
    for (const block of request.system) count += marked(block);
  for (const message of request.messages ?? [])
    if (Array.isArray(message?.content))
      for (const block of message.content) count += marked(block);
  return count;
}

/**
 * WHERE THE MOVED TEXT GOES, which decides who can read it.
 *
 * Claude Code's last system block is per PROJECT, not per install: it names
 * the project's memory directory, under the config directory. So a prefix
 * entry that ends after it is shared only by sessions of the same project.
 *
 *  - A SYSTEM PROMPT AN EARLIER SESSION SENT (the same project again): the
 *    moved text goes after it and takes its marker. One entry then holds the
 *    tools, the system prompt and the moved text; measured on repeated
 *    sessions of one project, a new session wrote 508 tokens instead of 4,301.
 *  - A SYSTEM PROMPT NOT SEEN BEFORE (a new project, or a fresh config
 *    directory): the moved text goes BEFORE it, with a marker of its own, so
 *    the entry it ends is the same in every project. Measured across four
 *    repositories the moved text was byte-identical while that system block
 *    was not, so placing it after the block shared nothing. The client's own
 *    markers stay where they were, so if the moved text ever changes, the
 *    tools entry before it still hits. This adds one marker, so it is taken
 *    only when the request is below the API's four.
 *
 * Both choices are stable within a session: the system prompt is recorded
 * with the first session that sent it, exactly as paragraphs are.
 */
function placeHoisted(
  system: Block[],
  hoisted: string,
  sameProject: boolean,
  markers: number
): Block[] {
  const last = system[system.length - 1];
  const marker = last?.cache_control;
  if (!marker) return [...system, { type: 'text', text: hoisted }];
  if (!sameProject && markers < MAX_CACHE_MARKERS)
    return [
      ...system.slice(0, -1),
      { type: 'text', text: hoisted, cache_control: marker },
      last,
    ];
  return [
    ...system.slice(0, -1),
    withoutMarker(last),
    { type: 'text', text: hoisted, cache_control: marker },
  ];
}

const none = (request: ProviderRequest): HoistResult => ({
  request,
  hoistedChars: 0,
});

export function hoistStableContext(
  request: ProviderRequest,
  ledger: ParagraphLedger
): HoistResult {
  const session = sessionOf(request);
  const messages = request.messages;
  if (!session || !Array.isArray(messages) || !Array.isArray(request.system))
    return none(request);
  const index = openingContextIndex(messages);
  if (index < 0) return none(request);
  const current = textOf(messages[index]);
  if (!current) return none(request);

  const moved: string[] = [];
  const kept: string[] = [];
  // Every paragraph is offered to the ledger, so that what this session sends
  // is on record for the next one even when nothing moves now.
  for (const paragraph of current.text.split(SEPARATOR)) {
    if (paragraph.trim() !== '' && ledger.seenElsewhere(paragraph, session))
      moved.push(paragraph);
    else kept.push(paragraph);
  }
  // The system prompt is on record from the first request too, so the next
  // session of this project knows it has been here (see placeHoisted).
  const system = request.system as Block[];
  const lastText = system[system.length - 1]?.text;
  const sameProject =
    typeof lastText === 'string' &&
    lastText !== '' &&
    ledger.seenElsewhere(`system:${lastText}`, session);
  ledger.flush();
  const hoisted = moved.join(SEPARATOR);
  const remaining = kept.join(SEPARATOR);
  if (hoisted.length < MIN_HOISTED_CHARS || remaining.trim() === '')
    return none(request);

  const replaced: Message = {
    ...messages[index],
    content: current.block
      ? [{ ...current.block, text: remaining }]
      : remaining,
  };
  return {
    request: {
      ...request,
      system: placeHoisted(system, hoisted, sameProject, markerCount(request)),
      messages: [
        ...messages.slice(0, index),
        replaced,
        ...messages.slice(index + 1),
      ],
    },
    hoistedChars: hoisted.length,
  };
}

/**
 * TOKEN_OPTIMIZER_PROXY_HOIST_CONTEXT: on by default; 0/false/no/off disables it.
 */
export function hoistContextEnabled(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  const raw = String(env.TOKEN_OPTIMIZER_PROXY_HOIST_CONTEXT ?? '')
    .trim()
    .toLowerCase();
  return !/^(0|false|no|off)$/.test(raw);
}
