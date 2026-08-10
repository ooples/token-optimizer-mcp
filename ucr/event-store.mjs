import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import {
  canonicalJson,
  compareHlc,
  sha256,
  validateEvent,
} from './protocol.mjs';

function parseLines(path) {
  if (!existsSync(path)) return { events: [], malformed: [] };
  const events = [];
  const malformed = [];
  const lines = readFileSync(path, 'utf8').split(/\r?\n/);
  lines.forEach((line, index) => {
    if (!line) return;
    try {
      events.push(JSON.parse(line));
    } catch (error) {
      malformed.push({
        line: index + 1,
        error: error.message,
        hash: sha256(line),
      });
    }
  });
  return { events, malformed };
}

function isReplayOrderable(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return false;
  if (
    typeof event.eventId !== 'string' ||
    !event.eventId ||
    typeof event.idempotencyKey !== 'string' ||
    !event.idempotencyKey ||
    typeof event.time?.hlc !== 'string' ||
    typeof event.writer?.id !== 'string' ||
    !event.writer.id ||
    !Number.isSafeInteger(event.writer.sequence)
  )
    return false;
  try {
    compareHlc(event.time.hlc, event.time.hlc);
    return true;
  } catch {
    return false;
  }
}

export function canonicalReplay(events, { strict = true } = {}) {
  const diagnostics = [];
  const byEvent = new Map();
  const byIdempotency = new Map();
  for (const event of events) {
    const validation = validateEvent(event);
    if (!validation.valid) {
      diagnostics.push({
        eventId: event?.eventId ?? null,
        errors: validation.diagnostics,
      });
      if (strict || !isReplayOrderable(event)) continue;
    }
    if (byEvent.has(event.eventId)) continue;
    const prior = byIdempotency.get(event.idempotencyKey);
    if (prior) {
      if (
        prior.payloadHash !== event.payloadHash ||
        prior.type !== event.type
      ) {
        diagnostics.push({
          eventId: event.eventId,
          errors: ['idempotency key reused for a different event'],
        });
      }
      continue;
    }
    byEvent.set(event.eventId, event);
    byIdempotency.set(event.idempotencyKey, event);
  }
  const ordered = [...byEvent.values()].sort(
    (a, b) =>
      compareHlc(a.time.hlc, b.time.hlc) ||
      a.writer.id.localeCompare(b.writer.id) ||
      a.writer.sequence - b.writer.sequence ||
      a.eventId.localeCompare(b.eventId)
  );
  return { events: ordered, diagnostics };
}

export class EventStore {
  constructor(root) {
    this.root = root;
    this.path = join(root, 'events.jsonl');
    mkdirSync(root, { recursive: true });
  }

  read({ strict = true } = {}) {
    const parsed = parseLines(this.path);
    const replay = canonicalReplay(parsed.events, { strict });
    return { ...replay, malformed: parsed.malformed };
  }

  append(event) {
    const validation = validateEvent(event);
    if (!validation.valid)
      return {
        accepted: false,
        duplicate: false,
        diagnostics: validation.diagnostics,
      };
    const current = this.read();
    const duplicate = current.events.find(
      (candidate) =>
        candidate.eventId === event.eventId ||
        candidate.idempotencyKey === event.idempotencyKey
    );
    if (duplicate) {
      const same =
        duplicate.type === event.type &&
        duplicate.payloadHash === event.payloadHash;
      return {
        accepted: false,
        duplicate: same,
        diagnostics: same ? [] : ['idempotency collision'],
        event: duplicate,
      };
    }
    appendFileSync(this.path, `${canonicalJson(event)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    return { accepted: true, duplicate: false, diagnostics: [], event };
  }

  compact() {
    const replay = this.read();
    if (replay.malformed.length || replay.diagnostics.length) {
      return { compacted: false, ...replay };
    }
    const next = `${this.path}.next`;
    writeFileSync(
      next,
      replay.events.map(canonicalJson).join('\n') +
        (replay.events.length ? '\n' : ''),
      {
        encoding: 'utf8',
        mode: 0o600,
      }
    );
    renameSync(next, this.path);
    return {
      compacted: true,
      hash: this.digest(),
      events: replay.events.length,
    };
  }

  digest() {
    const replay = this.read();
    return sha256(replay.events.map(canonicalJson).join('\n'));
  }

  exportRedacted({ maximumSensitivity = 'internal' } = {}) {
    const rank = { public: 0, internal: 1, confidential: 2, restricted: 3 };
    const maximum = rank[maximumSensitivity] ?? 1;
    return this.read().events.map((event) => {
      if ((rank[event.sensitivity] ?? 3) <= maximum) return event;
      const { payload, ...envelope } = event;
      return { ...envelope, payloadRedacted: true };
    });
  }
}
