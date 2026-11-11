# How Token Optimizer works

The four mechanisms, subagent behaviour, the knowledge graph, and how savings are attributed and verified. Back to the [README](../README.md).

## The 30-second version

Your agent burns most of its context on work it already did: re-reading files
that have not changed, dumping a whole file to see three lines, running
unbounded searches, and re-deriving conclusions it reached last session and then
forgot.

Token Optimizer attacks that on four fronts.

**1. It makes the expensive call impossible.** Install the plugin and a built-in
`Read` of a 200 KB file is **denied**, with the refusal naming the cached,
diffed replacement. Same for `Grep`, `Glob`, `Edit`, `Write`, and `cat` /
`head` / `grep -r` through the shell. **Re-reading a file you already read this
session returns only a diff** — usually the single biggest win, and one that
size-based rules structurally cannot catch. There is no setting to turn on.

**2. It remembers what your agent worked out.** A per-project knowledge graph
accumulates findings, decisions and dead ends as a side effect of working, then
feeds them back the moment the agent touches the relevant file. A finding costs
~150 tokens to carry. Re-deriving it costs 5k–50k.

**3. It measures itself, in public, and tells you when it is losing.** A
materialized before/actual-return measurement for MCP progressive disclosure,
with later expansions debited from the same net. Modeled graph substitutions
and the randomized control arm for downstream graph effects remain separate.
Every number is measured, visibly collecting, excluded, or absent.

**4. It attributes the traffic.** Returned context, optional cost equivalents,
and net transport avoided are grouped by operation and MCP handshake identity. Codex, Claude Code,
Gemini, and any other connected client get separate rows. Old records without
identity remain explicitly unattributed instead of being assigned to whichever
agent happens to be open now.

No account and no hosted service. MIT, so it is usable at work.

Nothing is measured about you unless you ask for it. Anonymous usage data is
off by default and takes two separate opt-ins: `TOKEN_OPTIMIZER_TELEMETRY=1`
aggregates counts into a file on your own disk, and `TOKEN_OPTIMIZER_BEACON=1`
is what uploads any of it. Setting the first opens no socket. With both set,
the events already on disk are sent once per session at start-up -- in a batch,
never on the hot path -- and the file is cleared only after the receiver has
accepted them. `install_doctor` prints which of the two is on, how many events
are waiting and where they would go; it reports without sending. A package
built without the upload key cannot transmit at all, and the doctor says so
rather than letting an opt-in look like it is working.
`DO_NOT_TRACK=1` overrides both, whatever else is set. The version check
`npm run doctor` and `install_doctor` make is a plain GET to the registry npm
installs from, carries nothing about you, and runs only when you ask for a
diagnosis -- never during a session. `DO_NOT_TRACK=1` or
`TOKEN_OPTIMIZER_UPDATE_CHECK=0` suppresses it before a socket is opened. An event may only
contain numbers and flags -- a string is dropped before it is written, so a
path, a prompt or an error message cannot travel even by mistake -- and the
machine identifier is a salted hash, never your hostname. What the counts are
about is the hook ledger your own project already keeps: how often the graph
answered instead of a tool, what each arm of the holdout was delivered and
withheld, and whether the saving exceeded the cost -- reduced to integers once
every six hours, never the ledger itself, which names your files. Usage is
counted as a rollup rather than a row per request: one event per 200 requests,
holding the request count, bytes in and out, how often compression paid, how
often knowledge was injected, and how many blocks were elided, plus one final
event when the proxy stops. That keeps the totals exact -- a row per request
would overflow the batch on a busy session and leave you reporting its first
five hundred -- at the cost of the per-request distribution, which is not
something anyone downstream needs. `npm run doctor`
prints exactly which of these is on and what has been recorded.

### What the dashboard proves on a real machine

The screenshots in this README come from the shipped server reading persisted
local data, not a design mockup. In the capture above it reports:

- **43,491 net verified MCP transport tokens avoided** in the current live
  proof: 54,037 gross reduction minus a deliberate 10,546-token expansion;
- **486,074,740 historical/tool-reported tokens quarantined**, dominated by
  repository scan volume that never entered model context;
- a live Codex / Claude Code / Gemini stdio smoke against AiDotNet, with each
  client attributed independently;
- **2,648 graph nodes, 6,527 edges, and 58 findings** across 11 local projects;
- **more than 1,000 hook runs with zero failures and zero timeouts** across six
  active CLI clients in the selected rolling 24-hour window;
- **6,332 tokens of modeled graph-substitution potential**, excluded from the
  verified headline while the causal graph-reuse study remains `Collecting`.

The dashboard now reads native CLI usage receipts and prices uncached input,
cache reads, cache writes, and output with the exact captured provider, model,
route, request-time tier, and versioned official source. Ambiguous model ids stay
**Not priced** instead of receiving a blended guess. API/list-price equivalents
are kept separate from provider-reported charges and are never labeled as a
subscription invoice. See the [token accounting contract](TOKEN_ACCOUNTING.md).

## Subagents and workflows

Agents are where token spend concentrates. A long-running subagent re-sends its
whole context on every turn, so every byte a tool adds is paid for again on each
later turn. In one measured session, 42 workflow subagents made 4,483 model
calls. The six longest made 218–348 calls each and peaked at 336K–609K tokens of
context. Together they spent 4.0M output tokens and 1.0B cache-read tokens. The bill is the re-reading, not the writing.

### What works with no setup

The plugin's hooks run for subagents exactly as they do for the main session.
Nothing needs to be configured per agent.

- **Whole-file reads are outlined, through `Read` and through the shell.**
  Agents mostly read files with `cat`, `type` or `Get-Content`, rarely with
  `Read`. In the measured session that was 2,071 shell reads against 9 `Read`
  calls. On the first whole read of a large source file, either kind returns a
  line-numbered outline of its symbols instead of the file. A second whole read
  of the same file returns the file itself. A line range is never outlined:
  `sed -n 'A,Bp'`, `head`, `Get-Content -TotalCount` and a paged `Read` all pass
  through untouched.
- **Each subagent is briefed once.** A subagent never sees the SessionStart
  guidance, so its first tool call carries a four-line briefing instead: load
  the optimizer tools if they are listed, read ranges rather than whole files,
  and keep the final report short. The tools are named only conditionally, so a
  hooks-only install is never told to call something it does not have.
- **Advisories are said once.** A routing hint such as "use smart_grep" appears
  at most once per agent for each kind of call, not on every matching command.
- **Past findings arrive only when they name what you are running.** A finding
  with no explicit trigger is delivered with a command only when its claim names
  that command's program and subcommand, such as `npx jest` or `dotnet build`,
  not when the two merely share a word.
- **Repeated build and test output is bounded**, as it is in the main session.
- **Through the proxy, a range you asked for comes back whole.** A paged `Read`
  or a shell slice is never folded, and a fold inside a whole-file read points at
  the file's own line numbers.

### What to add when you brief an agent

Claude Code gives subagents MCP tools as *deferred* tools: the schemas are not
loaded until the agent asks for them. An agent that never loads them falls back
to shell commands. Put this in the agent's prompt:

```text
Before your first file read or search, load the token-optimizer tools:
ToolSearch("smart_read smart_grep smart_glob").
Use smart_read for files (it returns a diff on re-reads), smart_grep for
searching, and smart_glob for finding files. Do not print whole files or search
the tree through the shell. When you need part of a file, read a line range.
```

The server's own instructions now say the same thing to every client, deferred
or not.

### Keep agents short

The plugin can only shrink what enters an agent's context. The number of turns
and the size of the context it carries are set by how the work is split up:

- **One bounded task per agent.** Several short agents cost less than one agent
  that runs for hundreds of turns, because each starts from a small context.
- **Give the agent the facts it needs** (paths, line numbers, the exact
  question) instead of asking it to rediscover them.
- **Ask for a structured result** so the agent stops when it has the answer.

### Measuring an agent

Each subagent writes its own transcript next to the session's, under
`~/.claude/projects/<project>/<session>/subagents/`. The `usage` block on every
assistant row records `input_tokens`, `output_tokens`,
`cache_read_input_tokens` and `cache_creation_input_tokens`.

**Count each response once.** One model response is written as several
assistant rows that share a `message.id`, and each row repeats the usage
recorded so far. Keep the LAST row per `message.id`, which holds the final
usage, and sum those. Summing every row overstates the cost: on the session
above it reported 1.8B cache-read tokens instead of 1.0B. Keeping the first row
instead understates output, at 0.5M instead of 4.0M.

The number of distinct `message.id`s is the number of model calls the agent
made. Read against its peak context, it shows whether the agent should have
been split.

---

## The knowledge graph — the part nothing else has

Every agent session ends the same way: the reasoning evaporates. The next
session re-derives it, at full price, forever.

This builds a **living per-project graph** — nodes for files, symbols, tasks and
findings; edges for `derived_from`, `contains`, `supersedes`, `contradicts`,
`related` — and it fills itself in from real work. No ingestion job, no
embedding model, no rebuild step, no query to formulate.

```
you touch  src/auth.ts
           │
           ├─ verify() compares exp against the LOCAL clock          (finding, 0.9)
           ├─ per-host retry budgets; global was rejected — deadlock (decision)
           ├─ ! the skew fix was reverted once already               (dead end)
           └─ [git] 47 changes in 90d, last three: "fix token expiry",
                    "revert skew fix", "fix token expiry again"
```

None of that is in your repository. It exists only because an agent once burned
tokens finding it out — and every other tool throws it away at the end of the
session.

**What a default install actually produces.** The structural graph — files,
symbols, tasks, and the edges between them — is captured from ordinary tool
traffic with no configuration at all. Findings are produced two ways. At session
end, `derive` reads evidence already on disk (command outcomes and exit codes,
red-to-green transitions, corrections, re-read churn) and writes findings from
it: no model call, no credential, nothing sent anywhere. And the active model
records durable conclusions itself through `wiki_write`.

The **model-based semantic harvest** is the third path, and the only one that
needs something you do not already have. It is **not opt-in** —
`TOKEN_OPTIMIZER_HARVEST=0` turns it _off_ — but its real gate is a credential:
with none it reports `off:no-key`, which is the state on CI, corporate machines,
and subscription-only logins. Point `TOKEN_OPTIMIZER_HARVEST_ENDPOINT` at a
local model and it runs **free and private, with nothing leaving the machine**.
`npx token-optimizer-doctor` states which of these is live.

### Why this is not RAG

| Classic RAG                                                    | This                                                                          |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Retrieves **evidence**; the model re-derives meaning each time | Retrieves **verdicts** — the reasoning already happened                       |
| Index built by a **batch ingestion job**                       | Accretes from **real agent traffic** — coverage follows attention             |
| **Similarity** search                                          | **Traversal** — this symbol _and its callers_                                 |
| Model must **formulate a query**                               | Fires when the model **reaches for a file**                                   |
| Staleness **invisible**; serves rotted chunks confidently      | Staleness **computed** from content hashes, served with the invalidating diff |
| Returns only what is **in the documents**                      | Returns **dead ends**, which exist nowhere in your source tree                |

Traversal plus lexical search: deterministic, instant, explainable, and it works
offline.

### The zero-turn refusal

A plain deny costs a full turn: the model calls `Read`, is refused, re-plans,
calls `smart_read`. But at refusal time we already hold the file _and_ the
snapshot the graph stored — so the refusal **carries the answer inside it**.
Nothing to re-plan, no second call. Turn cost drops from one to zero.

And when the graph already holds the verdict a tool output would support, the
output never enters context at all. Not compressed. Absent.

---

## Trust: we ship hooks that refuse your tool calls

That is a bigger ask than a normal dependency makes, so:

**Verify the release.** Published from CI with npm provenance — `npm audit
signatures` ties the artifact to the workflow run and the commit, without
trusting us. `CHECKSUMS.sha256` ships alongside for offline checking.

**If nothing seems to be happening, the lifecycle bundle is probably not
installed.** An MCP server process cannot modify the host that launched it, and
npm 11 gates lifecycle scripts behind `allow-scripts`. Install the native
src/plugin/hook bundle listed for your client below; adding only the MCP server gives
the model tools but no pre-execution veto. For a legacy global Claude Code
installation, recovery is one line:

```bash
npx token-optimizer-install     # wire Claude Code hooks
npx token-optimizer-doctor      # prove the Claude hooks work
```

**Check that it works — not that files exist.**

```bash
npx token-optimizer-doctor      # or npm run doctor, from a clone
```

It feeds a synthetic payload to the _real_ hook binary and asserts a large read
is refused and a small one is not. A checklist would have passed on the exact
bug this project once shipped, where the plugin was connected, visible in
`/mcp`, and saving nothing. Every failure names its own fix.

**Every refusal carries its own off switch.** Enforcement that hides its disable
is coercive, and the person who needs it is mid-refusal, not reading a README:

```
auth.ts is 91 KB. Call smart_read instead.
(Not what you wanted? TOKEN_OPTIMIZER_MODE=assist stops refusals and keeps everything else on.)
```

**Removal is exact.** The installer records every file it wrote, with hashes.
Uninstall removes only what still matches; anything you edited since is left in
place and named. Your own hooks are never touched, and we never rewrite your
`settings.json` — we merge into it.

```bash
npm run uninstall-hooks              # show the plan; changes nothing
npm run uninstall-hooks -- --apply   # carry it out
```

---

## It separates direct savings from causal graph evidence

Every tool in this space reports "tokens saved" computed from its own
assumptions. That number cannot be wrong, because nothing checks it.

For optimizer results, this records the materialized before-state and the text
actually returned to the client, then subtracts any linked expansion responses.
Native graph-substitution counterfactuals stay labeled as modeled and outside
the main headline.

The graph's broader claim—whether delivered knowledge prevented later
re-reading—is causal, so it runs a **randomized holdout**. Delivery is silently
withheld on a slice of file touches, stratified by file, and the effect is the
difference in downstream reads between arms. That effect is not added to the
combined net until the experiment can support it, and the page will tell you
plainly:

> the graph is NOT yet paying for itself

A tool that can only ever report good news is not reporting. The same discipline
runs throughout: an unmeasurable saving renders as **unknown**, never as zero,
and never as `$0.00` — because "cannot tell yet" printed as "saved nothing" is a
silent false negative, and dollars get quoted to other people.

## It runs everywhere, and says which tier

The tier is a protocol guarantee, not a preference:

- **Lifecycle continuation:** Claude Code, Codex, GitHub Copilot CLI, Gemini CLI,
  Qwen Code, and Cursor. Native routing/capture/delivery plus one active-model
  completion reflection.
- **Native observation:** Cline, OpenCode, Kilo, and Windsurf. Native
  routing/capture/delivery; the active model performs semantic writes.
- **MCP + rules:** Roo Code, Zed, Amp, Continue, Crush, and Droid. MCP-visible
  activity and explicit graph tools, with no claim over hidden built-in calls.

The exact surfaces still differ. For example, a protocol that can replace a
large read before it reaches the model provides a stronger token guarantee than
one that can only observe it. The generated registry, adapters, dashboard, and
certification report all read the same capability source so those claims cannot
drift independently.

Every config shape is confirmed against that client's published documentation,
with the source URL recorded in its README.

## Everything here is verified, and you can run it

```bash
npm run verify:all
```

| Suite            | Checks | What it proves                                                                                                          |
| ---------------- | ------ | ----------------------------------------------------------------------------------------------------------------------- |
| `test`           | 2,437  | Enforcement, staleness, injection, consolidation, disclosure, cache, routing, trust — driving the real hooks over stdin |
| `verify:clients` | 253    | Every client config, lifecycle manifest, and enforcement surface matches its documented schema                          |
| `verify:harvest` | 26     | Request shape, response parsing, and that **no secret from a tool result crosses the wire**                             |
| `verify:ui`      | 22     | Real headless Chromium: layout, label collisions, legibility                                                            |
| `doctor`         | 10     | The installed hooks actually refuse, and the server actually answers                                                    |

These are not decoration. They found six client configs that would have failed
**silently**, an installer that destroyed user hooks, a Windows path bug that
made enforcement blind to half its own refusals, and an uninstaller that printed
a plan and deleted nothing.
