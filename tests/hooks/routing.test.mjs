/**
 * Model routing.
 *
 * The properties under test are the ones a task-sizing heuristic cannot have:
 * the recommendation comes from outcomes observed IN THIS PROJECT, both
 * directions of a wrong call are priced from measured rates rather than
 * balanced by a taste setting, the heuristic is a floor that measurement
 * outvotes rather than the whole product, a switch is costed against the warm
 * prefix it discards, and the briefing that reaches the prompt prefix carries
 * no number that would invalidate it.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  readEpisodes,
  classifyShape,
  outcomeTable,
  route,
  routingNote,
  routingBriefing,
  routingReport,
  expectedCost,
  tierOf,
  cachedRoutingBriefing,
  HEURISTIC,
  MIN_EPISODES,
} from '../../hooks-core/routing.mjs';
import { volatileLines } from '../../hooks-core/cache.mjs';

let workspace;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'routing-'));
});
afterEach(() => rmSync(workspace, { recursive: true, force: true }));

/**
 * Writes a transcript of episodes in the client's own format.
 * Each episode: { model, tools:[{name,file}], turns, errors }
 */
function transcript(episodes) {
  const rows = [];
  for (const episode of episodes) {
    rows.push({
      type: 'user',
      timestamp: new Date().toISOString(),
      message: { role: 'user', content: 'do the thing' },
    });
    for (let turn = 0; turn < (episode.turns || 1); turn++) {
      // All of the episode's tool calls land in its first turn, the way parallel
      // tool use actually arrives. Spreading one per turn made the number of
      // DISTINCT files depend on the turn count, so a one-turn episode claiming
      // three files silently produced one and was classified as the wrong shape.
      const tools = turn === 0 ? episode.tools || [] : [];
      rows.push({
        type: 'assistant',
        timestamp: new Date().toISOString(),
        message: {
          role: 'assistant',
          model: episode.model,
          content: tools.length
            ? tools.map((tool) => ({
                type: 'tool_use',
                name: tool.name,
                input: tool.file ? { file_path: tool.file } : {},
              }))
            : [{ type: 'text', text: 'thinking' }],
        },
      });
      rows.push({
        type: 'user',
        timestamp: new Date().toISOString(),
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              is_error: turn < (episode.errors || 0),
              content: 'x',
            },
          ],
        },
      });
    }
  }
  const path = join(workspace, 'transcript.jsonl');
  writeFileSync(path, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return path;
}

/** N episodes of one shape on one model. */
const runs = (n, { model, files = 1, turns = 1, errors = 0, tool = 'Edit' }) =>
  Array.from({ length: n }, () => ({
    model,
    turns,
    errors,
    tools: Array.from({ length: files }, (_, i) => ({
      name: tool,
      file: `/f${i}.ts`,
    })),
  }));

describe('outcomes are observed from what actually happened', () => {
  test('an episode is one request and everything done about it', () => {
    const episodes = readEpisodes(
      transcript(runs(2, { model: 'claude-opus-5', turns: 3 }))
    );
    expect(episodes).toHaveLength(2);
    expect(episodes[0].turns).toBe(3);
  });

  test('errored tool results are counted, because a retry is another attempt', () => {
    const episodes = readEpisodes(
      transcript(runs(1, { model: 'claude-sonnet-5', turns: 3, errors: 2 }))
    );
    expect(episodes[0].errors).toBe(2);
  });

  test('a missing transcript yields nothing rather than a fabricated table', () => {
    expect(readEpisodes(null)).toEqual([]);
    expect(outcomeTable([])).toEqual({});
  });

  test('an episode that changed model midway is attributed to neither', () => {
    // Splitting a mixed episode between tiers would put an outcome on a model
    // that may not have caused it.
    const path = transcript([
      {
        model: 'claude-opus-5',
        turns: 1,
        tools: [{ name: 'Edit', file: '/a.ts' }],
      },
    ]);
    const episodes = readEpisodes(path);
    episodes[0].models = ['claude-opus-5', 'claude-haiku-4-5-20251001'];
    expect(outcomeTable(episodes)).toEqual({});
  });
});

describe('shapes are coarse on purpose', () => {
  test('editing several files is a multi-file change', () => {
    expect(
      classifyShape({ tools: ['Edit'], files: ['/a.ts', '/b.ts', '/c.ts'] })
    ).toBe('multi-file-change');
  });

  test('editing one file is not', () => {
    expect(classifyShape({ tools: ['Edit'], files: ['/a.ts'] })).toBe(
      'single-file-change'
    );
  });

  test('reading without editing is investigation', () => {
    expect(classifyShape({ tools: ['Grep'], files: [] })).toBe('investigation');
  });

  test('a conversation with no tools at all is its own shape', () => {
    expect(classifyShape({ tools: [], files: [] })).toBe('conversation');
  });
});

describe('the heuristic is a floor that measurement outvotes', () => {
  test('with no history the shipped default is used, and says so', () => {
    const decision = route('multi-file-change', {});
    expect(decision.basis).toBe('heuristic');
    expect(decision.recommend).toBe(HEURISTIC['multi-file-change']);
  });

  test('a thin cell does not get to outvote anything', () => {
    // A routing table with one episode per row is a table of anecdotes.
    const table = outcomeTable(
      readEpisodes(
        transcript(
          runs(MIN_EPISODES - 1, {
            model: 'claude-haiku-4-5-20251001',
            files: 3,
            tool: 'Edit',
            turns: 3,
          })
        )
      )
    );
    expect(route('multi-file-change', table).basis).toBe('heuristic');
  });

  test('enough episodes and the measurement takes over', () => {
    const table = outcomeTable(
      readEpisodes(
        transcript(
          runs(MIN_EPISODES + 2, {
            model: 'claude-haiku-4-5-20251001',
            files: 3,
            tool: 'Edit',
            turns: 3,
          })
        )
      )
    );
    const decision = route('multi-file-change', table);
    expect(decision.basis).toBe('measured');
    expect(decision.recommend).toBe('haiku');
  });
});

describe('a cheap model that keeps retrying is not cheap', () => {
  test('turns and errors multiply into the expected cost', () => {
    const clean = expectedCost('haiku', {
      meanTurns: 1,
      errorRate: 0,
      episodes: 9,
      measured: true,
    });
    const churny = expectedCost('haiku', {
      meanTurns: 3,
      errorRate: 0.5,
      episodes: 9,
      measured: true,
    });
    expect(churny.cost).toBeGreaterThan(clean.cost * 4);
  });

  test('a retry-prone cheap tier loses to a clean expensive one', () => {
    // The whole point: per-token price is not the cost.
    const cheap = expectedCost('sonnet', {
      meanTurns: 4,
      errorRate: 0.8,
      episodes: 9,
      measured: true,
    });
    const dear = expectedCost('opus', {
      meanTurns: 1,
      errorRate: 0,
      episodes: 9,
      measured: true,
    });
    expect(dear.cost).toBeLessThan(cheap.cost);
  });
});

describe('both directions of a wrong call are priced', () => {
  /** Cheap model flails, expensive model does it first time. */
  function mixedTable() {
    const path = transcript([
      ...runs(MIN_EPISODES + 1, {
        model: 'claude-haiku-4-5-20251001',
        files: 3,
        turns: 4,
        errors: 3,
      }),
      ...runs(MIN_EPISODES + 1, {
        model: 'claude-opus-5',
        files: 3,
        turns: 1,
        errors: 0,
      }),
    ]);
    return outcomeTable(readEpisodes(path));
  }

  test('the recommendation follows expected cost, not per-token price', () => {
    expect(route('multi-file-change', mixedTable()).recommend).toBe('opus');
  });

  test('the underpowered option is reported with what it actually costs', () => {
    // Treating routing accuracy as one number would hide this asymmetry.
    const decision = route('multi-file-change', mixedTable());
    expect(decision.underpowered.tier).toBe('haiku');
    expect(decision.underpowered.errorRate).toBeGreaterThan(0.5);
  });

  test('when the cheap tier IS right, the expensive one is reported as waste', () => {
    const path = transcript([
      ...runs(MIN_EPISODES + 1, {
        model: 'claude-haiku-4-5-20251001',
        files: 1,
        turns: 1,
        errors: 0,
      }),
      ...runs(MIN_EPISODES + 1, {
        model: 'claude-opus-5',
        files: 1,
        turns: 1,
        errors: 0,
      }),
    ]);
    const decision = route(
      'single-file-change',
      outcomeTable(readEpisodes(path))
    );

    expect(decision.recommend).toBe('haiku');
    expect(decision.overpowered.tier).toBe('opus');
    expect(decision.overpowered.wasted).toBeGreaterThan(0);
  });
});

describe('the advice reaches the decision, and costs the switch', () => {
  function mixedTable() {
    const path = transcript([
      ...runs(MIN_EPISODES + 1, {
        model: 'claude-haiku-4-5-20251001',
        files: 3,
        turns: 4,
        errors: 3,
      }),
      ...runs(MIN_EPISODES + 1, {
        model: 'claude-opus-5',
        files: 3,
        turns: 1,
        errors: 0,
      }),
    ]);
    return outcomeTable(readEpisodes(path));
  }

  test('no note when the current model is already the right one', () => {
    expect(
      routingNote('multi-file-change', mixedTable(), {
        currentModel: 'claude-opus-5',
      })
    ).toBeNull();
  });

  test('the note names the retry rate that justifies it', () => {
    const note = routingNote('multi-file-change', mixedTable(), {
      currentModel: 'claude-haiku-4-5-20251001',
    });
    expect(note.recommend).toBe('opus');
    expect(note.text).toMatch(/needed a retry/);
  });

  test('and the warm prefix a switch would discard', () => {
    // Advice to change model that ignores the cache it throws away is
    // incomplete: sometimes the right answer is "at the next break".
    const note = routingNote('multi-file-change', mixedTable(), {
      currentModel: 'claude-haiku-4-5-20251001',
      switchCost: {
        prefixTokens: 262_614,
        rewriteInputCostEquivalent: 328_268,
      },
    });
    expect(note.text).toMatch(/discards a 262,614-token warm prefix/);
    expect(note.text).toMatch(/next break/);
  });
});

describe('the briefing is cache-safe, because it lands in the prefix', () => {
  test('it carries no number that would change between sessions', () => {
    // A count that ticks up as evidence accumulates would invalidate the prefix
    // every session -- the optimizer paying for its own advice. The fixture has
    // to be a case where the measurement DISAGREES with the shipped default,
    // since agreement is deliberately silent.
    const path = transcript([
      ...runs(MIN_EPISODES + 1, {
        model: 'claude-haiku-4-5-20251001',
        files: 3,
        turns: 1,
        errors: 0,
      }),
      ...runs(MIN_EPISODES + 1, {
        model: 'claude-opus-5',
        files: 3,
        turns: 1,
        errors: 0,
      }),
    ]);
    const text = routingBriefing(outcomeTable(readEpisodes(path)));

    expect(text).toBeTruthy();
    expect(text).toContain('haiku');
    expect(text).not.toMatch(/\d/);
    expect(volatileLines(text)).toHaveLength(0);
  });

  test('nothing is said when the measurement agrees with the default', () => {
    const path = transcript(
      runs(MIN_EPISODES + 1, { model: 'claude-sonnet-5', files: 1, turns: 1 })
    );
    // sonnet is already the shipped default for a single-file change.
    expect(HEURISTIC['single-file-change']).toBe('sonnet');
    expect(routingBriefing(outcomeTable(readEpisodes(path)))).toBeNull();
  });

  test('the full numbers live in the report, where changing costs nothing', () => {
    // A tier that errors in EVERY episode is excluded rather than ranked, so a
    // measured recommendation needs a fixture that sometimes succeeds.
    const path = transcript([
      ...runs(2, { model: 'claude-opus-5', files: 3, turns: 2, errors: 1 }),
      ...runs(MIN_EPISODES, {
        model: 'claude-opus-5',
        files: 3,
        turns: 2,
        errors: 0,
      }),
    ]);
    const report = routingReport(outcomeTable(readEpisodes(path)));

    expect(report).toMatch(/multi-file-change -> opus \(measured\)/);
    expect(report).toMatch(/% needed a retry/);
  });

  test('a tier that fails most attempts is excluded rather than ranked cheapest', () => {
    // Token arithmetic alone routes work to a model that fails most of the
    // time, because four cheap turns cost fewer tokens than one expensive one.
    // The half it cannot see is the failed attempt and the user watching it.
    const path = transcript([
      ...runs(MIN_EPISODES + 1, {
        model: 'claude-haiku-4-5-20251001',
        files: 3,
        turns: 4,
        errors: 3,
      }),
      ...runs(MIN_EPISODES + 1, {
        model: 'claude-opus-5',
        files: 3,
        turns: 1,
        errors: 0,
      }),
    ]);
    const decision = route(
      'multi-file-change',
      outcomeTable(readEpisodes(path))
    );

    expect(decision.recommend).toBe('opus');
    expect(decision.underpowered.tier).toBe('haiku');
    expect(decision.underpowered.excluded).toBe(true);
  });

  test('an empty table reports nothing rather than an empty table', () => {
    expect(routingReport({})).toBeNull();
    expect(routingBriefing({})).toBeNull();
  });

  test('the briefing is memoised, because it blocks the first turn of a session', () => {
    // Measured at 0.5s against a 70 MB transcript, which is not a price worth
    // paying every session for a fact that changes about once a week. Stability
    // is also the correct behaviour here, not merely the cheap one.
    const path = transcript([
      ...runs(MIN_EPISODES + 1, {
        model: 'claude-haiku-4-5-20251001',
        files: 3,
        turns: 1,
        errors: 0,
      }),
      ...runs(MIN_EPISODES + 1, {
        model: 'claude-opus-5',
        files: 3,
        turns: 1,
        errors: 0,
      }),
    ]);
    const dir = join(workspace, 'wiki');

    const first = cachedRoutingBriefing(dir, path);
    expect(first).toContain('haiku');

    // The transcript is gone; a recomputation would now return nothing, so the
    // identical answer proves the memo served it.
    rmSync(path);
    expect(cachedRoutingBriefing(dir, path)).toBeNull();

    writeFileSync(path, '');
    expect(cachedRoutingBriefing(dir, path)).toBe(first);
  });

  test('a missing transcript memoises nothing rather than an empty briefing', () => {
    expect(
      cachedRoutingBriefing(
        join(workspace, 'wiki'),
        join(workspace, 'gone.jsonl')
      )
    ).toBeNull();
  });
});

describe('model ids map to tiers', () => {
  test('the current families are recognised', () => {
    expect(tierOf('claude-opus-5')).toBe('opus');
    expect(tierOf('claude-sonnet-5')).toBe('sonnet');
    expect(tierOf('claude-haiku-4-5-20251001')).toBe('haiku');
  });

  test('an unknown model is null rather than guessed into a tier', () => {
    expect(tierOf('some-other-model')).toBeNull();
  });
});
