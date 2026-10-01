/**
 * What an agent plugin is.
 *
 * ONE PLUGIN PER LOG FORMAT, and nothing above it knows which agent it is looking
 * at. Adding support for another coding agent is then a file in plugins/ plus a
 * line in the registry, and it cannot change how the analysis reads -- which is
 * the property that makes a second agent worth supporting at all.
 *
 * `detect()` is the cheap half of that bargain: it may stat, and it may not read.
 * Auto-detection runs every plugin's detect() before doing any work, so a plugin
 * that parses a directory there would make the whole pass slow for the agents the
 * user does not even have installed.
 *
 * EVERY METHOD THAT TOUCHES A DISK IS ASYNC. A discovery pass stats every session
 * file an agent has ever written and reads the head of hundreds of them, and one
 * transcript can run to hundreds of megabytes, so a synchronous plugin would stop
 * whatever process hosted it for the length of the pass. These signatures are also
 * the contract an external plugin is written against, which is not a thing to
 * change after people have written against it.
 */

import { stat } from 'node:fs/promises';

import { ProjectInfo, SessionData } from './models.js';

/** The agents this package ships a parser for. */
export enum BuiltInAgent {
  Claude = 'claude',
  Codex = 'codex',
}

/** Where a plugin says its instructions and notes files are, per project. */
export interface ContextTarget {
  /** The agent's instructions file, relative to the project directory. */
  readonly contextFile: string;
  /** The durable notes file, where the agent has a convention for one. */
  readonly memoryFile: string | null;
}

export interface ScanOptions {
  /** Stop reading a session file after this many bytes. */
  readonly maxBytesPerSession?: number;
  /** Ignore sessions older than this. */
  readonly since?: Date;
  /** Read at most this many session files, newest first. */
  readonly maxSessions?: number;
  /**
   * Called with the path of a transcript that could not be read.
   *
   * A plugin skips one it cannot parse rather than abandoning the other two
   * hundred, and without this the skip would be silent -- a pass that read two of
   * fifty files would report confidently on two. The count is the number that
   * bounds how much of the result to believe, so it is handed back, not swallowed.
   */
  readonly onUnreadable?: (path: string) => void;
}

/**
 * Whether a directory is there, without reading it.
 *
 * This is the one filesystem call the cheap half of the bargain above allows a
 * `detect()` to make. It answers false for anything it cannot stat and for a path
 * that exists but is not a directory, so a plugin never readdirs a file.
 */
export async function directoryExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    // Absent, or on a disk this process cannot reach. Either way: no data here.
    return false;
  }
}

export interface AgentPlugin {
  /** Lowercase identifier, as typed on the command line. */
  readonly name: string;
  /** How it is printed. */
  readonly displayName: string;
  /** True when this machine has data for this agent. Stat only, never read. */
  detect(): Promise<boolean>;
  /** Projects this agent has sessions for. */
  discoverProjects(): Promise<readonly ProjectInfo[]>;
  /** Read one project's sessions into the shared shapes. */
  scanProject(
    project: ProjectInfo,
    options?: ScanOptions
  ): Promise<readonly SessionData[]>;
  /** Where this agent reads its instructions from. */
  contextTarget(): ContextTarget;
}
