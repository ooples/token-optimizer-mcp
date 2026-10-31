# Moving a project's store out of the repository

token-optimizer keeps each project's graph, metrics, artifacts and authored records in a **store**. Older releases put that store inside the repository, at `<repo>/.token-optimizer/`. This page explains how to move it to your home directory, at `~/.token-optimizer/projects/<id>/store/`, safely, and what each step guarantees.

You only need this page if you want to move an existing store, or if a session told you a move happened.

## The short version

```sh
cd path/to/your/repo
token-optimizer-storage status     # where the store is, and anything blocking a move
token-optimizer-storage migrate    # move it, or say exactly why not
token-optimizer-storage gc         # later: delete the kept backup, after re-checking the move
```

If `migrate` says **NOT READY**, nothing was changed. It also recorded that you asked, and the next session start completes the move on its own once the blockers clear. You do not need to run it again.

## What has to be true before anything moves

A move goes ahead only when **both** of these hold:

1. **No older token-optimizer process is running.** Releases without write leases don't know about migrations, so they would keep writing to the old location. `migrate` lists every Node process running a token-optimizer script and checks the code each one runs: it refuses unless that code takes write leases, and it treats a process whose code can't be found or read as one that doesn't.

   **If the process list can't be read completely, that counts as a blocker too.** This happens when permission is denied, or when running inside a container, which can't see processes in other containers that share the same files. Being unable to see a writer is not evidence that none exists.

   To clear this blocker, close every client session (Claude Code, Codex, Cursor or any other) whose process `status` lists as one "whose code takes no write leases", or upgrade it to a release whose code takes them. Then run `status` again.

2. **The old location is fenced off.** The store directory is renamed aside, and a small *file* is put where the directory was. Any older process that later tries to write there fails with `ENOTDIR`, so it can't recreate the store behind your back. `migrate` confirms this with a test write that must fail before it copies anything.

Processes whose code takes write leases don't need to be stopped. They take a short *write lease* for every write, and `migrate` waits up to 30 seconds for those to finish. While a move is in progress, their writes go to a holding area (the *spool*) and are added to the new store afterwards. Each record is added once, even if it was seen twice.

## Step by step

| step | what happens | if it fails |
|---|---|---|
| check | process list read; refuses with the reasons if anything blocks | nothing changed; intent recorded |
| drain | store marked `draining`; waits for write leases to finish | store marked normal again; nothing moved |
| fence | `<repo>/.token-optimizer` renamed aside; a fence file put in its place; test write must fail | rename undone |
| copy | every file copied and flushed to disk; the source is re-checked, and copied again if a late write changed it; the copy must match byte for byte | copy deleted, rename undone |
| publish | the copy becomes `~/.token-optimizer/projects/<id>/store/` in one rename; the fence file becomes a **tombstone** pointing there | copy deleted, rename undone |
| finish | held writes added to the new store; the original kept as `<repo>/.token-optimizer.migrated-<date>/` | — |

**If the process doing the move is killed at any step,** the next session start, or `token-optimizer-storage recover`, finishes it:
- **before publish:** the move is undone, and the store is exactly where it was;
- **after publish:** the move is completed.

No record that was written is lost or added twice. The test suite kills the process at each of these points and checks both.

## After the move

- **The tombstone stays.** `<repo>/.token-optimizer` is now a small file saying where the store went. Up-to-date clients follow it, and older ones are kept out by it, so don't delete it while any client without write leases might still run on this machine. It also records the store's id, so if you move or rename the repository folder, it still finds its store.
- **git doesn't see the tombstone or the backup.** `/.token-optimizer` and `/.token-optimizer.migrated-*` are added to this clone's own `.git/info/exclude`, which is never committed, so `git status` stays clean.
- **The backup stays until you remove it.** `token-optimizer-storage gc` first checks that every file in the backup is also in the new store. Logs that have grown since the move are fine, as long as their original contents are still there at the start. Other files that were rewritten since the move are fine too, as long as the backup still holds exactly what the move copied; a backup file that changed after the copy blocks `gc`, because the new store never received those bytes. If the check passes, it deletes the backup; if not, it refuses and lists what's missing.

## Rolling back

```sh
token-optimizer-storage restore
```

This runs the same steps in the other direction:
- It needs the same offline check, because the tombstone is what keeps older writers out of the repository, and the restore removes it.
- The moved store is copied back and checked byte for byte, so writes made after the original move are kept.
- The tombstone is replaced by the restored folder.
- The moved store is kept as `store.restored-<date>` until you delete it.

If the restore is killed at any point, the next session start, or `token-optimizer-storage recover`, either finishes it or leaves the store in its moved location. Exactly one copy stays live.

Until `gc` has run, the original from before the move is also still in the backup folder.

## What is and isn't guaranteed

| guaranteed (tested) | not claimed |
|---|---|
| a refused or failed move changes nothing, or is fully undone | survival of a **power cut** during a move: files and folders are flushed to disk, but this isn't tested per filesystem |
| a process killed at any step is recovered, with no record lost or duplicated | protection from writers on **other machines** sharing the folder over a network drive: the process check only sees this machine, and the fence is only as reliable as that filesystem's rename |
| older writers can't write to the old location after the fence goes up | that the process list names *every* writer: it lists the ones it can see, and refuses when it knows it can't see everything |
| a full disk or permission error at any step is undone cleanly | |
| writes made during a move are added afterwards, each once | |

## Diagnostics

- `token-optimizer-storage status` shows:
  - where the store is;
  - its maintenance state (`normal`, `draining`, `ready`, `cutover` or `failed`);
  - how many write leases are active;
  - every blocker.
- Writes that were refused or failed are logged with their store, operation and error code in `~/.token-optimizer/write-failures.jsonl` (1 MB, rotated) and printed once on stderr. If even that log can't be written, stderr is the only report.
