import { describe, it, expect } from '@jest/globals';
import {
  trimSubagentContext,
  isSubagentRequest,
  stripMemoryIndex,
  skillNamesOnly,
} from '../../../src/compress/subagent-context.js';
import type { ProviderRequest } from '../../../src/compress/frontier.js';

/**
 * A workflow worker's first request, synthetic but shaped exactly like the one
 * Claude Code 2.1.301 sent (section headers copied from a live transcript).
 */
const memory = Array.from(
  { length: 200 },
  (_, i) => `- [note ${i}](note-${i}.md) - something about project ${i % 9}`
).join('\n');
const instructions = (withClaudeMd: boolean) =>
  '<system-reminder>\nCodebase and user instructions are shown below. Be sure to adhere to these instructions. IMPORTANT: These instructions OVERRIDE any default behavior and you MUST follow them exactly as written.\n\n' +
  (withClaudeMd
    ? 'Contents of C:\\repo\\CLAUDE.md (project instructions, checked into the codebase):\n\nAlways run the tests.\n\n'
    : '') +
  "Contents of C:\\Users\\u\\.claude\\projects\\p\\memory\\MEMORY.md (user's auto-memory, persists across conversations):\n\n# Memory Index\n\n" +
  memory +
  '\n</system-reminder>';
const listing =
  'The following tools just became available and are ready to use:\nmcp__claude_ai_Claude_Docs__batch\nmcp__claude_ai_Claude_Docs__guide\n\n' +
  'The following deferred tools are now available via ToolSearch. Their schemas are NOT loaded -- calling them directly will fail with InputValidationError. Use ToolSearch with query "select:<name>[,<name>...]" to load tool schemas before calling them:\n' +
  [
    'Monitor',
    'WebFetch',
    'mcp__claude_ai_Gmail__authenticate',
    'mcp__claude_ai_Google_Drive__authenticate',
    'mcp__console-automation__console_send_key',
    'mcp__console-automation__console_get_output',
    'mcp__plugin_token-optimizer_token-optimizer__smart_read',
  ].join('\n') +
  '\n\n# Environment\nYou have been invoked in the following environment:\n - Platform: win32\n\n' +
  'The following skills are available for use with the Skill tool:\n\n' +
  '- dataviz: Use this skill whenever you are about to create ANY chart, graph, plot, dashboard, or data visualization.\n' +
  '- anthropic-skills:docx: Use this skill whenever the user wants to create, read, edit, or manipulate Word documents.\n\n' +
  "Today's date is 2026-10-21.";

const worker = (
  task: string,
  opts: { claudeMd?: boolean; subagent?: boolean } = {}
): ProviderRequest =>
  ({
    model: 'claude',
    system: [
      {
        type: 'text',
        text: `x-anthropic-billing-header: cc_version=2.1.302; cc_entrypoint=sdk-cli;${opts.subagent === false ? '' : ' cc_is_subagent=true;'}`,
      },
      {
        type: 'text',
        text: 'You are Claude Code, Anthropic\u2019s official CLI for Claude.',
      },
    ],
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: instructions(opts.claudeMd ?? false) },
          {
            type: 'text',
            text: '<system-reminder>\n# userEmail\nThe user\u2019s email is someone@example.invalid.\n</system-reminder>',
          },
          { type: 'text', text: task },
        ],
      },
      {
        role: 'system',
        content: [
          { type: 'text', text: listing },
          {
            type: 'tool_addition',
            tool: {
              type: 'tool_definition',
              definition: { name: 'mcp__claude_ai_Claude_Docs__batch' },
            },
          },
          {
            type: 'tool_addition',
            tool: {
              type: 'tool_definition',
              definition: {
                name: 'mcp__plugin_token-optimizer_token-optimizer__smart_grep',
              },
            },
            cache_control: { type: 'ephemeral' },
          },
        ],
      },
    ],
  }) as unknown as ProviderRequest;

const texts = (r: ProviderRequest) => JSON.stringify(r.messages);

describe('subagent detection', () => {
  it('reads the billing header and the subagent system prompts', () => {
    expect(isSubagentRequest(worker('t'))).toBe(true);
    expect(isSubagentRequest(worker('t', { subagent: false }))).toBe(false);
  });
});

describe('trimming a subagent\u2019s injected context', () => {
  const out = trimSubagentContext(worker('Fix issue #12 in the repository.'));
  const sent = texts(out.request);

  it('removes the memory index, skill descriptions and unmentioned servers', () => {
    expect(sent).not.toContain('Memory Index');
    expect(sent).not.toContain('Use this skill whenever');
    expect(sent).toContain('- dataviz\\n');
    expect(sent).toContain('- anthropic-skills:docx\\n');
    expect(sent).not.toContain('mcp__claude_ai_Gmail__authenticate');
    expect(sent).not.toContain('mcp__console-automation__console_send_key');
    expect(sent).not.toContain('mcp__claude_ai_Claude_Docs__batch');
    expect(out.removedChars).toBeGreaterThan(10_000);
  });

  it('keeps built-in tools, this package\u2019s tools, the environment, the task and cache markers', () => {
    expect(sent).toContain('Monitor');
    expect(sent).toContain('WebFetch');
    expect(sent).toContain(
      'mcp__plugin_token-optimizer_token-optimizer__smart_read'
    );
    expect(sent).toContain(
      'mcp__plugin_token-optimizer_token-optimizer__smart_grep'
    );
    expect(sent).toContain('# Environment');
    expect(sent).toContain('Fix issue #12 in the repository.');
    expect(sent).toContain('# userEmail');
    expect(sent).toContain('"cache_control"');
  });

  it('moves the cache marker of a dropped block onto the last block kept', () => {
    const req = worker('Fix issue #12 in the repository.');
    const listing = req.messages[1].content as Record<string, unknown>[];
    // As Claude Code sends it: the marker on the LAST tool_addition, here one of an unmentioned server.
    delete listing[2].cache_control;
    listing.push({
      type: 'tool_addition',
      tool: {
        type: 'tool_definition',
        definition: { name: 'mcp__claude_ai_Gmail__authenticate' },
      },
      cache_control: { type: 'ephemeral', ttl: '1h' },
    });
    const kept = trimSubagentContext(req).request.messages[1]
      .content as Record<string, unknown>[];
    expect(JSON.stringify(kept)).not.toContain('Gmail');
    expect(kept[kept.length - 1].cache_control).toEqual({
      type: 'ephemeral',
      ttl: '1h',
    });
    expect(kept.filter((b) => b.cache_control)).toHaveLength(1);
  });

  it('keeps a server the task names', () => {
    const named = texts(
      trimSubagentContext(
        worker('Read the spec from Google Drive and summarise it.')
      ).request
    );
    expect(named).toContain('mcp__claude_ai_Google_Drive__authenticate');
    expect(named).not.toContain('mcp__claude_ai_Gmail__authenticate');
  });

  it('keeps CLAUDE.md instructions when they share the block with the memory index', () => {
    const kept = texts(
      trimSubagentContext(worker('t', { claudeMd: true })).request
    );
    expect(kept).toContain('Always run the tests.');
    expect(kept).not.toContain('Memory Index');
  });

  it('never touches the main session', () => {
    const main = worker('t', { subagent: false });
    const result = trimSubagentContext(main);
    expect(result.removedChars).toBe(0);
    expect(result.request).toBe(main);
  });

  it('is deterministic: a later turn of the same agent keeps the same prefix bytes', () => {
    const later = worker('Fix issue #12 in the repository.');
    later.messages?.push({
      role: 'assistant',
      content: [{ type: 'text', text: 'working' }],
    } as never);
    const a = JSON.stringify(
      trimSubagentContext(
        worker('Fix issue #12 in the repository.')
      ).request.messages?.slice(0, 2)
    );
    const b = JSON.stringify(
      trimSubagentContext(later).request.messages?.slice(0, 2)
    );
    expect(b).toBe(a);
  });
});

describe('the section helpers', () => {
  it('leaves a block without a memory index alone', () => {
    expect(
      stripMemoryIndex('<system-reminder>\nhello\n</system-reminder>')
    ).toBe('<system-reminder>\nhello\n</system-reminder>');
    expect(stripMemoryIndex(instructions(false))).toBeNull();
  });

  it('collapses only the skill list', () => {
    const text =
      'before\nThe following skills are available for use with the Skill tool:\n\n- a: long words\n- b:c: more\n\nafter this';
    expect(skillNamesOnly(text)).toBe(
      'before\nThe following skills are available for use with the Skill tool:\n\n- a\n- b:c\n\nafter this'
    );
  });
});
