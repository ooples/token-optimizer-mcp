/**
 * What the knowledge graph tells a subagent on its first tool call.
 *
 * THE GRAPH NEVER REACHED A SUBAGENT. SessionStart delivers the standing rules
 * and the task-relevant index -- to the main session only, because Claude Code
 * fires SessionStart for nothing else. A subagent got the four-line tool
 * briefing and no knowledge at all, so nine agents working one backlog on
 * 2026-10-20 could not see what a sibling, or an earlier session, had already
 * concluded: the dead ends, the commands that work, the decisions taken. That is
 * the whole point of a shared graph, and it was unreachable from the agents that
 * need it most.
 *
 * The subagent's TASK is not in its hook payload, but Claude Code writes the
 * agent's transcript at `<session>/subagents/**\/agent-<agent_id>.jsonl`, and its
 * first user entry is the task. That is what relevance is computed against.
 *
 * Bounded and fail-open: a bounded read of one transcript head, the same
 * budgets SessionStart uses, and null on any failure.
 */

import { closeSync, existsSync, openSync, readSync, readdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { relevantFindingIdsForContext, sessionIndex, standingRules } from './inject.mjs';

const HEAD_BYTES = 256 * 1024;
const MAX_TASK_CHARS = 4_000;

/** The surface subagent deliveries are recorded under, distinct from 'session-start'. */
export const SURFACE = 'subagent-briefing';

function readHead(path) {
  const handle = openSync(path, 'r');
  try {
    const buffer = Buffer.allocUnsafe(HEAD_BYTES);
    const got = readSync(handle, buffer, 0, HEAD_BYTES, 0);
    return buffer.toString('utf8', 0, got);
  } finally {
    closeSync(handle);
  }
}

/** The subagent's own transcript, from its payload, or null. */
export function agentTranscriptFor(raw) {
  const transcript = String(raw?.transcript_path ?? raw?.transcriptPath ?? '');
  if (/[\\/]subagents[\\/].*agent-[^\\/]*\.jsonl$/.test(transcript) && existsSync(transcript)) return transcript;
  const agent = raw?.agent_id ?? raw?.agentId;
  if (!transcript || typeof agent !== 'string' || !agent) return null;
  // The parent's transcript with the agent's id: look beside it.
  const root = join(dirname(transcript), basename(transcript, '.jsonl'), 'subagents');
  const want = `agent-${agent}.jsonl`;
  const walk = (dir, depth) => {
    if (depth > 4) return null;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return null;
    }
    for (const entry of entries) {
      if (entry.isFile() && entry.name === want) return join(dir, entry.name);
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const hit = walk(join(dir, entry.name), depth + 1);
        if (hit) return hit;
      }
    }
    return null;
  };
  return existsSync(root) ? walk(root, 0) : null;
}

/** The task a subagent was given: the first user entry of its transcript. */
export function subagentTask(raw) {
  try {
    const path = agentTranscriptFor(raw);
    if (!path) return '';
    for (const line of readHead(path).split('\n')) {
      if (!line.startsWith('{')) continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (entry.type !== 'user') continue;
      const content = entry.message?.content;
      const text =
        typeof content === 'string'
          ? content
          : Array.isArray(content)
            ? content.filter((p) => p?.type === 'text').map((p) => p.text).join('\n')
            : '';
      if (text.trim()) return text.slice(0, MAX_TASK_CHARS);
    }
  } catch {
    /* no task is no relevance, not a failure */
  }
  return '';
}

/**
 * The knowledge block for a subagent: standing rules plus findings relevant to
 * its task, from each graph given (the project's, then the shared tier where
 * lessons that hold in any repository land). Null when there is nothing.
 */
export function subagentKnowledge(graphs, task, { episode = {} } = {}) {
  const blocks = [];
  for (const { dir, graph } of graphs || []) {
    if (!graph) continue;
    try {
      // Recorded under their own surface, so the subagent deliveries are measured
      // apart from SessionStart's rather than inflating its count (review on #516).
      const rules = standingRules(dir, graph, { episode, surface: SURFACE });
      if (rules) blocks.push(rules);
      const relevant = relevantFindingIdsForContext(graph, task);
      const index = relevant.length ? sessionIndex(dir, graph, { episode, relevantFindingIds: relevant, surface: SURFACE }) : null;
      if (index) blocks.push(index);
    } catch {
      /* one unreadable graph does not cost the other */
    }
  }
  return blocks.length ? blocks.join('\n\n') : null;
}
