/**
 * What THIS session wrote, so a later read can diff against it.
 *
 * THE QUESTION THIS ANSWERS, AND THE ONE IT DOES NOT. A diff base is only sound
 * if the caller already holds the bytes it is being diffed against. That is a
 * statement about AUTHORSHIP or DELIVERY, never about observation.
 *
 * The knowledge graph cannot supply it, and the distinction is not academic:
 * `indexFile` runs on every file either hook OBSERVES -- reads included, across
 * sessions -- so a graph snapshot means "some hook last saw these bytes". Using
 * that as a base would hand a fresh session `// No changes` for a file it has
 * never seen, withholding content while reporting success. That is strictly
 * worse than resending the file, which is the behaviour being improved on.
 *
 * So this store is written ONLY by a write, and every record carries the
 * session that made it.
 *
 * DEGRADATION IS ONE-DIRECTIONAL, BY CONSTRUCTION. Every uncertain state --
 * missing record, unreadable record, different session, absent session id,
 * content whose hash no longer matches disk, a file that has since been deleted
 * -- resolves to `null`, meaning "no base", meaning the caller resends the file.
 * The store can never make a read worse than it is today; at worst it does
 * nothing. Nothing here may throw, because these run inside hooks and a hook
 * that breaks a tool call is worse than one that saves nothing.
 */

import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { canonicalPath, isFsSafePath } from './paths.mjs';

/**
 * Largest authored file kept.
 *
 * Matched to the graph's own snapshot cap for the same reason it has one: a
 * store that keeps every write becomes a second copy of the repository. Past
 * the cap a read simply gets no base and resends, which is today's behaviour.
 */
const limit = () => {
  const raw = Number(process.env.TOKEN_OPTIMIZER_AUTHORED_LIMIT);
  return Number.isFinite(raw) && raw > 0 ? raw : 262_144;
};

const storeDir = (projectRoot) =>
  join(projectRoot, '.token-optimizer', 'authored');

/** One file per authored path, named by a digest so no path escapes the store. */
const recordPath = (projectRoot, filePath) =>
  join(
    storeDir(projectRoot),
    createHash('sha256').update(canonicalPath(filePath)).digest('hex').slice(0, 32) +
      '.json'
  );

const hash = (text) =>
  createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 32);

/**
 * Records that `sessionId` wrote `content` to `filePath`.
 *
 * Written atomically: a torn record read back as valid JSON with the wrong
 * bytes would be a WRONG diff base, which is the one outcome this store must
 * never produce. A temp file plus rename means a reader sees the old record or
 * the new one, never half of either.
 */
export function recordAuthoredContent(projectRoot, sessionId, filePath, content) {
  try {
    if (!projectRoot || !sessionId || !filePath) return;
    if (typeof content !== 'string' || content.length > limit()) return;
    if (!isFsSafePath(filePath)) return;

    const dir = storeDir(projectRoot);
    mkdirSync(dir, { recursive: true });

    const target = recordPath(projectRoot, filePath);
    const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(
      tmp,
      JSON.stringify({
        v: 1,
        sessionId,
        path: canonicalPath(filePath),
        hash: hash(content),
        content,
        at: Date.now(),
      }),
      { mode: 0o600 }
    );
    renameSync(tmp, target);
  } catch {
    /* the write landed; the record is an optimization */
  }
}

/**
 * The bytes `sessionId` wrote to `filePath`, or null.
 *
 * Null on every uncertainty. The hash check against disk is what makes a stale
 * record safe rather than merely unlikely: if anything changed the file after
 * we wrote it -- another process, another tool, a `git checkout` -- the recorded
 * bytes are no longer a truthful "before", and a diff against them would
 * describe a change that never happened.
 */
export function authoredContentFor(projectRoot, sessionId, filePath) {
  try {
    if (!projectRoot || !sessionId || !filePath) return null;
    if (!isFsSafePath(filePath)) return null;

    const raw = readFileSync(recordPath(projectRoot, filePath), 'utf8');
    const record = JSON.parse(raw);

    // THE SESSION GATE, which is the whole point. A record from another session
    // describes bytes this caller never received.
    if (record?.v !== 1 || record.sessionId !== sessionId) return null;
    if (typeof record.content !== 'string') return null;
    if (record.path !== canonicalPath(filePath)) return null;

    // Cheap rejection before reading the file: a size change is a content
    // change, and this runs on a tool-call path.
    const size = statSync(filePath).size;
    if (size !== Buffer.byteLength(record.content, 'utf8')) return null;

    const onDisk = readFileSync(filePath, 'utf8');
    if (hash(onDisk) !== record.hash) return null;

    return record.content;
  } catch {
    return null;
  }
}
