/**
 * What an arm IS: a settings file and an environment, nothing more.
 *
 * No arm-specific code path exists anywhere in this harness. That is a
 * deliberate constraint rather than an accident of design: the moment the
 * runner knows which arm it is running, the benchmark can favour one, and no
 * reader could rule it out. An arm here is data an operator could write by
 * hand and hand to `claude --settings`, so a result is reproducible without
 * trusting us.
 */

import { readFileSync } from 'node:fs';
import { OUTPUT_DISCIPLINE } from '../../hooks-core/adapter.mjs';

/** Vanilla Claude Code. No hooks, no MCP server, no optimizer. */
export const control = {
  name: 'control',
  settings: {},
  env: {
    // Stated rather than assumed: with nothing installed there is no inventory
    // to fabricate, and an explicit empty value cannot be topped up by a
    // package that happens to be present in the image.
    TOKEN_OPTIMIZER_MCP_CAPABILITIES: '',
    TOKEN_OPTIMIZER_MODE: 'off',
  },
};

const HOOK = (event, script) => ({
  [event]: [
    {
      hooks: [
        {
          type: 'command',
          command: `node "/usr/local/lib/node_modules/@ooples/token-optimizer-mcp/plugin/hooks/${script}"`,
        },
      ],
    },
  ],
});

/** The hook set the product installs. */
const optimizerHooks = {
  ...HOOK('SessionStart', 'session-start.mjs'),
  PreToolUse: [
    {
      matcher: 'Read|Grep|Glob|Edit|MultiEdit|Write|Bash|PowerShell',
      hooks: [
        {
          type: 'command',
          command:
            'node "/usr/local/lib/node_modules/@ooples/token-optimizer-mcp/plugin/hooks/pretooluse-router.mjs"',
        },
      ],
    },
  ],
  ...HOOK('PostToolUse', 'post-tool.mjs'),
  ...HOOK('Stop', 'stop.mjs'),
  // precompact-optimize.mjs, which is the file that exists. This said
  // `pre-compact.mjs` and pointed both assist arms at a hook that is not
  // there. It changed no published result -- the largest context any run
  // reached was 125,641 tokens against a window near 200,000, so PreCompact
  // never fired and the broken path was never taken -- but it would have
  // silently disabled compaction on any task long enough to need it, which is
  // exactly the kind of arm that measures the product with a feature switched
  // off and reports it as the product. The test below now checks every hook
  // path an arm names against the filesystem.
  ...HOOK('PreCompact', 'precompact-optimize.mjs'),
};

/**
 * The product as we intend to ship it: hooks on, refusals off, no MCP server.
 *
 * `assist` is the posture worth measuring. Enforcement refuses a call and costs
 * a whole turn to redirect it, which on a cost benchmark is the most expensive
 * thing an optimizer can do -- so the interesting question is what the hooks
 * are worth WITHOUT that.
 */
export const assist = {
  name: 'assist',
  settings: { hooks: optimizerHooks },
  env: {
    TOKEN_OPTIMIZER_MODE: 'assist',
    TOKEN_OPTIMIZER_MCP_CAPABILITIES: '',
    TOKEN_OPTIMIZER_RUNTIME: '/opt/token-optimizer-runtime',
    TOKEN_OPTIMIZER_REFRESH_INTERVAL_MS: '999999999999',
  },
};

/**
 * assist with the project index disabled.
 *
 * The A/B partner for the search advisory: identical in every other respect,
 * so the difference between them is the seed and nothing else.
 */
export const assistNoSeed = {
  name: 'assist-noseed',
  settings: assist.settings,
  env: { ...assist.env, TOKEN_OPTIMIZER_SEED: '0' },
};

/**
 * assist with the output-discipline block removed, and nothing else changed.
 *
 * THE ONLY ARM THAT CAN ATTRIBUTE THE RESULT. assist beat control at 0.818 and
 * 0.535 cost per unit delivered with output at 0.751 and 0.428 -- but assist
 * carries the bound, the compactor and outline substitution too, so that
 * comparison cannot say whether the instructions or the interception did it.
 * Everything measured in this project until now has been an arm-versus-control
 * test of a bundle; this is the first difference of one variable.
 */
export const assistNoRules = {
  name: 'assist-norules',
  settings: assist.settings,
  env: { ...assist.env, TOKEN_OPTIMIZER_OUTPUT_DISCIPLINE: '0' },
};


/**
 * The leader, represented by the thing that actually moves their numbers.
 *
 * NOT A FAITHFUL REPLICA, and the difference is stated rather than buried:
 * their arm requires a "tokenade" binary that is absent from this image, so
 * their six hooks and their CLI cannot run here. What CAN run is their rules
 * file, which their own published data says is the mechanism -- 6.1 CLI calls
 * across 16 tasks, 0.38 per task, against output tokens at 0.722 of control.
 *
 * If their hooks contribute materially this arm understates them, and that is
 * the honest caveat on any comparison drawn from it. It is included because a
 * text-versus-text head-to-head is the experiment the analysis points at: both
 * products reduce to a block of instructions, and theirs is 2,667 characters
 * against our 510.
 */
export const tokenadeRules = {
  name: 'tokenade-rules',
  settings: {},
  env: {
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: '700000',
    TOKEN_OPTIMIZER_MODE: 'off',
    TOKEN_OPTIMIZER_MCP_CAPABILITIES: '',
  },
  claudeMd: "# Project rules for AI coding agents\n\nAuto-scaffolded by tokenade on first MCP session. Safe to edit; the tokenade block below is identified by the HTML marker and will be updated in-place on future tokenade upgrades.\n\n<!-- tokenade-scaffold -->\n## Explore code with the `tokenade` CLI (cheaper than reading whole files)\nUse these only when you don't yet know where code lives — if you know the path, open it directly:\n`tokenade map` (repo structure) · `skeleton <file…>` (signatures) · `query <symbol…>` (locate a symbol) · `impact <file…>` (dependents) · `semantic \"<query>\"` (search by meaning). They take MANY targets per call (`tokenade skeleton a.rs b.rs c.rs`) — batch in ONE turn.\n\n## Compute over data with `tokenade exec`\n`tokenade exec --lang python --script '<code>'` (also sh/node/ruby/awk/jq/perl) runs in a sandbox and returns ONLY its stdout. Use it to COMPUTE over data — filter/aggregate a large or structured output, pull facts across SEVERAL files, or apply one mechanical edit across many files (migration, find-replace) — in ONE script, not one command per item. It is NOT a file reader: to read content, use the parallel reads above, not `exec`. Long or quote-heavy script? `--script-file <path>` (or `--script -` on stdin) avoids shell quoting entirely.\n\n## Commands\nIf you do not have hooks (i.e. you are not Claude Code or Gemini CLI), use `tokenade wrap '<cmd>'` to wrap all your commands. If there is an opportunity for compacting noisy output, tokenade will find it — and you will waste fewer tokens.\nCall binaries by their PATH name, not an absolute path (`git`, not `/usr/bin/git`) — an absolute path bypasses tokenade's hook and PATH shim, so that command's output isn't compacted.\n\n## Keep output lean\nKeep prose terse and code minimal — every token you write is billed as output.\n- **Prose:** answer directly — no preamble, recap, tool-call narration, summary, or emoji. Drop articles, filler (*just/really/basically/simply*) and hedging; fragments fine; short word over long.\n- **Output:** don't paste long raw output — quote the shortest decisive line. No decorative tables.\n- **Code:** write the least that works; reuse before adding (`query` / `skeleton` / `impact`, stdlib, platform feature — YAGNI).\n- **Verbatim:** keep code, identifiers, API/CLI names and error strings exact — never abbreviate or paraphrase. Keep the user's language.\n- **Correctness first:** fix root causes not symptoms, don't downgrade the algorithm, don't guess APIs/flags/versions — verify.\n- **Full prose where terseness could mislead:** security/data-loss warnings, irreversible-action confirmations, multi-step sequences.\n<!-- /tokenade-scaffold -->",
};

/**
 * OUR text, delivered exactly as theirs is: a CLAUDE.md and no hooks.
 *
 * THE ARM THAT MAKES THE HEAD-TO-HEAD HONEST. The first comparison put `assist`
 * -- hooks PLUS the block -- against their text alone, and I reported it as
 * text versus text. It was not. Attribution had shown hooks-without-block is
 * indistinguishable from control, but that does not license treating
 * hooks-plus-text as equivalent to text; the interaction is exactly what an
 * uncontrolled comparison cannot rule out.
 *
 * This arm carries the shipped constant, imported rather than copied so the
 * measured text cannot drift from the text users get, with no hooks, no MCP,
 * and the optimizer switched off. Against tokenade-rules it is 510 characters
 * against 2,667, same delivery, same everything else.
 *
 * THE NUMBERS ARE THE DELIVERED FILES, not the block alone. 510 is this arm's
 * whole claudeMd -- the shipped OUTPUT_DISCIPLINE constant plus the one-line
 * header that makes it a rules file -- measured the same way as their 2,667,
 * so the two are comparable. An earlier "471" counted the constant without the
 * header and disagreed with itself two comments apart; a count that cannot be
 * reproduced from the arm it describes is worse than no count.
 */
export const oursRulesOnly = {
  name: 'ours-rules',
  settings: {},
  env: {
    TOKEN_OPTIMIZER_MODE: 'off',
    TOKEN_OPTIMIZER_MCP_CAPABILITIES: '',
  },
  claudeMd: `# Project rules for AI coding agents\n\n${OUTPUT_DISCIPLINE}\n`,
};

export const ARMS = {
  control,
  assist,
  'assist-noseed': assistNoSeed,
  'assist-norules': assistNoRules,
  'tokenade-rules': tokenadeRules,
  'ours-rules': oursRulesOnly,
};

/** Loads extra arms from a JSON file, so an outsider can add their own. */
export function loadArms(path) {
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  const out = {};
  for (const [name, arm] of Object.entries(raw)) {
    if (!arm || typeof arm !== 'object') throw new Error(`arm ${name} is not an object`);
    if (arm.claudeMd !== undefined && typeof arm.claudeMd !== 'string') {
      throw new Error(`arm ${name} has a non-string claudeMd`);
    }
    // CARRIED THROUGH, because dropping it made the file unable to express the
    // very thing this harness exists to compare. Every competitor here reduces
    // to a rules file -- tokenade's own CLI runs 0.38 times per task while its
    // claudeMd does the work -- so an outsider adding an arm by JSON could
    // define one, watch it be silently discarded, and measure their tool as
    // though it shipped no instructions at all. The shipped arms could do this
    // and only the external path could not, which is the worst place for the
    // gap to be: it is the path we do not run ourselves.
    out[name] = {
      name,
      settings: arm.settings ?? {},
      env: arm.env ?? {},
      ...(arm.claudeMd === undefined ? {} : { claudeMd: arm.claudeMd }),
    };
  }
  return out;
}
