/**
 * WHAT A TOOL ACTUALLY SAVES THE CALLER, MEASURED ON THE WIRE.
 *
 * 51 of the 83 tool definitions under src/tools advertise a token reduction --
 * "83% token reduction", "75-85%", "70-80%" -- and until this file nothing in
 * the repository measured one. The figures arrived with bulk feature-integration
 * commits (fc358254, 79f5d7ff) and no bench output is keyed by tool name.
 *
 * Worse, the number the tools compute for themselves does not mean what a reader
 * would take it to mean. smart-complexity.ts:239 sets originalTokens from
 * JSON.stringify(result, null, 2) -- its OWN result, pretty-printed -- and
 * compares it against a compacted rendering of that same result. So the ratio
 * describes the tool's choice of indentation, not anything the caller avoided
 * reading. And the compact rendering is discarded: src/server/index.ts sends
 * JSON.stringify(result, null, 2), the pretty form, so the compaction the tool
 * measures never reaches the client at all.
 *
 * The reduction a caller experiences is a different quantity, and it is the one
 * the descriptions are read as claiming:
 *
 *     baseline   the tokens the caller would have spent to answer the question
 *                without the tool -- for a file analyser, the file's own text
 *     treatment  the tokens of the payload the client really receives
 *     reduction  1 - treatment / baseline
 *
 * Both halves are counted with the same encoding head-to-head.mjs uses, so the
 * figures sit on the same scale as the compression numbers. The treatment half
 * is taken by calling the real server over real stdio, so what is counted is the
 * payload after dispatch and serialisation rather than a handler's return value,
 * which is what the caller pays for.
 *
 * Fixtures are vendored under fixtures/ rather than read out of src/, so a row
 * measured today can be re-measured next month and still mean the same thing.
 *
 * Nothing here is timed, so nothing here needs a quiet machine.
 *
 * AND NOTHING MEASURED HERE MAY CARRY A CLOCK. This paragraph used to excuse the
 * drift -- "smart_complexity reports a duration field, so two runs differ by a
 * digit ... that is 0.1% and it has never moved a bracket". Both halves were
 * wrong when checked: three passes over the same inputs disagreed on 7 of 36
 * cases by up to 8 tokens, 0.6% of the smallest fixture, and it HAD moved a
 * bracket -- smart_pretty's repeated range read -31% once and -30% the next
 * time. The wall-clock fields are gone from those responses, so an identical
 * call now serialises to identical bytes.
 *
 * `--record` is what holds that. It measures every case RECORD_PASSES times and
 * refuses to write unless all of them agree on the bracket it would publish, so
 * a figure reaches the file only once it has been shown to reproduce. The
 * observed spread is written down beside the claims rather than discarded: a
 * recording that drifted but still landed in the same bracket is worth seeing.
 */

import { spawn } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { get_encoding } from 'tiktoken';

export const ENCODING_NAME = 'cl100k_base';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
export const FIXTURES = join(HERE, 'fixtures');

let encoding = null;
export function countTokens(text) {
  if (!encoding) encoding = get_encoding(ENCODING_NAME);
  return encoding.encode(text).length;
}

/**
 * The reduction a caller sees, as a fraction. Negative when a tool costs more
 * than the text it replaces, which is a real outcome and must not be clamped:
 * an analyser whose report is longer than the file is worth knowing about.
 */
export function reduction(baselineTokens, treatmentTokens) {
  if (!(baselineTokens > 0)) return null;
  return 1 - treatmentTokens / baselineTokens;
}

/**
 * Turn a measured fraction into the words a description may use. A range is
 * never invented from a single reading: one fixture yields one number, and a
 * claim of "75-85%" needs the spread of several.
 */
export function claimFor(rows) {
  const usable = rows.filter((r) => r.reduction !== null);
  if (usable.length === 0) return null;
  const pct = usable.map((r) => r.reduction * 100);
  const lo = Math.floor(Math.min(...pct));
  const hi = Math.ceil(Math.max(...pct));
  // A hyphen between two numbers reads as a range until one of them is
  // negative, at which point "-219--218%" is unreadable -- and a tool that
  // costs more than it saves is exactly the case a description must state
  // clearly rather than bury in punctuation.
  const text =
    lo === hi ? `${lo}%` : lo < 0 ? `${lo}% to ${hi}%` : `${lo}-${hi}%`;
  return { lo, hi, n: usable.length, text };
}

/**
 * Each case names the payload a caller would otherwise have put in context, and
 * how that tool wants to be told about it. The argument shapes differ -- some
 * take filePath, some path, some a file list -- so each case carries its own
 * rather than a single shape being forced on all of them, which would record a
 * refusal where the tool was simply asked the wrong question.
 */
const byFilePath = (path) => ({ filePath: path });
const byPath = (path) => ({ path });
const byFileList = (path) => ({ files: [path], cwd: dirname(path) });
/**
 * THE SAME QUESTION, IN THE WORDS THAT TOOL DECLARES.
 *
 * smart_typescript's schema has no `cwd`; the root it reads is `projectRoot`.
 * The key was ignored in silence until unknown arguments became a refusal, and
 * then the case recorded `NO MEASUREMENT` while the tool's own description went
 * on claiming 85-86% from the reading it could no longer take. A refusal here is
 * the harness asking the wrong question, which is exactly what the comment above
 * says these builders exist to prevent.
 */
const byProjectFileList = (path) => ({
  files: [path],
  projectRoot: dirname(path),
});
const byEnvFile = (path) => ({ envFile: path });
const byPathKey = (path) => ({ path });
// A tool given a directory must be given the directory its own fixture is in.
// Both of these used to name FIXTURES outright, so adding a second package.json
// under large-project/ would have measured the small one twice and published a
// range that never moved.
const byProjectRoot = (path) => ({ projectRoot: dirname(path) });
const byConfigPath = (path) => ({ configPath: path });
const byFormatting = (path) => ({ operation: 'format-code', filePath: path });

export const CASES = [
  {
    tool: 'smart_complexity',
    fixture: 'smart-complexity.ts',
    args: byFilePath,
  },
  { tool: 'smart_complexity', fixture: 'token-counter.ts', args: byFilePath },
  { tool: 'smart_complexity', fixture: 'tool-profile.ts', args: byFilePath },
  { tool: 'smart_exports', fixture: 'smart-complexity.ts', args: byFilePath },
  { tool: 'smart_exports', fixture: 'token-counter.ts', args: byFilePath },
  { tool: 'smart_exports', fixture: 'tool-profile.ts', args: byFilePath },
  { tool: 'smart_imports', fixture: 'smart-complexity.ts', args: byFilePath },
  { tool: 'smart_imports', fixture: 'token-counter.ts', args: byFilePath },
  { tool: 'smart_imports', fixture: 'tool-profile.ts', args: byFilePath },
  { tool: 'smart_symbols', fixture: 'smart-complexity.ts', args: byFilePath },
  { tool: 'smart_symbols', fixture: 'token-counter.ts', args: byFilePath },
  { tool: 'smart_symbols', fixture: 'tool-profile.ts', args: byFilePath },
  { tool: 'smart_security', fixture: 'smart-complexity.ts', args: byFilePath },
  { tool: 'smart_security', fixture: 'token-counter.ts', args: byFilePath },
  { tool: 'smart_security', fixture: 'tool-profile.ts', args: byFilePath },
  // The one fixture with findings. Without it every smart_security reading is
  // the same 98-token "0 findings" answer, and the published range describes
  // the empty path only -- see the fixture's own header.
  {
    tool: 'smart_security',
    fixture: 'insecure-handlers.ts',
    args: byFilePath,
  },
  { tool: 'smart_refactor', fixture: 'smart-complexity.ts', args: byFilePath },
  { tool: 'smart_refactor', fixture: 'token-counter.ts', args: byFilePath },
  { tool: 'smart_refactor', fixture: 'tool-profile.ts', args: byFilePath },
  { tool: 'smart_config_read', fixture: 'package.json', args: byPath },
  {
    tool: 'smart_config_read',
    fixture: 'large-project/package.json',
    args: byPath,
  },
  { tool: 'smart_env', fixture: 'example.env', args: byEnvFile },
  { tool: 'smart_env', fixture: 'large.env', args: byEnvFile },
  {
    tool: 'smart_typescript',
    fixture: 'tool-profile.ts',
    args: byProjectFileList,
  },
  { tool: 'smart_dependencies', fixture: 'package.json', args: byFileList },
  {
    tool: 'smart_dependencies',
    fixture: 'large-project/package.json',
    args: byFileList,
  },
  { tool: 'smart_read', fixture: 'smart-complexity.ts', args: byPathKey },
  { tool: 'smart_read', fixture: 'token-counter.ts', args: byPathKey },
  { tool: 'smart_read', fixture: 'tool-profile.ts', args: byPathKey },
  { tool: 'smart_package_json', fixture: 'package.json', args: byProjectRoot },
  {
    tool: 'smart_package_json',
    fixture: 'large-project/package.json',
    args: byProjectRoot,
  },
  { tool: 'smart_tsconfig', fixture: 'tsconfig.json', args: byConfigPath },
  {
    tool: 'smart_tsconfig',
    fixture: 'large-project/tsconfig.json',
    args: byConfigPath,
  },
  // An extends chain: the baseline is BOTH files, because a caller answering
  // this by hand reads the config, sees what it extends, reads that too and
  // merges them. Crediting only the leaf would have measured this tool against
  // a fraction of the work it replaces.
  {
    tool: 'smart_tsconfig',
    fixture: 'ts-extends/tsconfig.json',
    baselineFixtures: [
      'ts-extends/tsconfig.base.json',
      'ts-extends/tsconfig.json',
    ],
    args: byConfigPath,
  },
  // A syntax formatter cannot reduce anything -- it returns the same code, and
  // highlighting adds markup to it. It published 94-95% anyway, off an elided
  // payload counted as economy, so what it costs is measured here on all three.
  { tool: 'smart_pretty', fixture: 'smart-complexity.ts', args: byFormatting },
  { tool: 'smart_pretty', fixture: 'token-counter.ts', args: byFormatting },
  { tool: 'smart_pretty', fixture: 'tool-profile.ts', args: byFormatting },
];
/** A minimal JSON-RPC client over the server's real stdio transport. */
export class Server {
  constructor() {
    const cacheDir = mkdtempSync(join(tmpdir(), 'tool-reduction-'));
    this.cacheDir = cacheDir;
    this.child = spawn(
      process.execPath,
      [join(ROOT, 'dist', 'server', 'index.js')],
      {
        cwd: ROOT,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          TOKEN_OPTIMIZER_TOOL_PROFILE: 'full',
          // A COLD CACHE, OR THE FIRST READING IS NOT A FIRST READING.
          //
          // The cache lives in the home directory and outlives the process, so a
          // second run of this bench found every fixture already cached and
          // reported the cached figure in the first-read column. It moved
          // smart_read's first read from 8-78% to 85-97% between two runs of the
          // same code -- a number that changes because of what a previous run
          // left behind measures history, not the tool. Each run gets its own
          // directory, so the two columns mean what they say.
          TOKEN_OPTIMIZER_CACHE_DIR: cacheDir,
        },
        windowsHide: true,
      }
    );
    this.buffer = '';
    this.pending = new Map();
    this.nextId = 1;
    this.stderr = '';
    this.child.stderr.on('data', (chunk) => {
      this.stderr += chunk.toString();
    });
    this.child.stdout.on('data', (chunk) => {
      this.buffer += chunk.toString();
      let cut;
      while ((cut = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, cut).trim();
        this.buffer = this.buffer.slice(cut + 1);
        if (!line) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue; // a log line on stdout is not a protocol frame
        }
        const waiter = this.pending.get(message.id);
        if (waiter) {
          this.pending.delete(message.id);
          waiter(message);
        }
      }
    });
  }

  send(method, params) {
    const id = this.nextId++;
    const frame = { jsonrpc: '2.0', id, method, params };
    return new Promise((res, rej) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rej(
          new Error(`${method} timed out; stderr: ${this.stderr.slice(-400)}`)
        );
      }, 120000);
      this.pending.set(id, (message) => {
        clearTimeout(timer);
        res(message);
      });
      this.child.stdin.write(JSON.stringify(frame) + '\n');
    });
  }

  async start() {
    await this.send('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'reduction-bench', version: '0' },
    });
    this.child.stdin.write(
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) +
        '\n'
    );
  }

  stop() {
    this.child.stdin.end();
    this.child.kill();
    try {
      rmSync(this.cacheDir, { recursive: true, force: true });
    } catch {
      // A leftover temp directory is not worth failing a measurement over.
    }
  }
}

/**
 * One reading. A tool that refuses, or whose payload carries the validator's
 * "Unknown tool" text, records a null reduction rather than a flattering one:
 * a missing measurement must not read as a measured zero.
 */
/**
 * Every spelling of a saving the fourteen tools have published about themselves.
 *
 * All fourteen counted one, and not one of them was what the caller paid: each
 * counted an internal object, or a compact form, or the string it was about to
 * return -- while the reply is assembled around that string afterwards. They
 * are gone now, both halves measured by the party that sees both, and this list
 * is what stops one coming back. A reading cannot be trusted while the thing
 * being read still publishes a competing figure.
 */
const SELF_CLAIM_KEYS = new Set([
  'tokensSaved',
  'savedTokens',
  'tokenCount',
  'originalTokenCount',
  'originalTokens',
  'compactedTokens',
  'optimizedTokens',
  'compressedTokens',
  'compressionRatio',
  'reductionPercentage',
  'totalTokensSaved',
  'averageReduction',
]);

/**
 * A saving stated in prose rather than in a field.
 *
 * SIX OF THE FOURTEEN ANSWER IN A HUMAN REPORT, NOT IN JSON, and a key walk
 * reads exactly nothing there. Both figures this sweep was built to stop were
 * printed that way and not as fields at all: smart_package_json's footer said
 * -92% where the wire said -20.9%, and smart_security printed a flat 85% for
 * three fixtures of three different sizes. A gate that parses and gives up left
 * 36 of 90 reply parts unread while reporting the fleet clean.
 *
 * A LABELLED FIGURE, NOT A WORD. The words alone appear in source that claims
 * nothing, so what is matched is a report FIELD -- one of these labels, a colon,
 * a number -- which is the shape a report footer has and a sentence does not.
 */
const PROSE_CLAIM =
  /(tokens? saved|tokens?saved|savings?|saved|reduction|compression ratio)[^\n:]{0,8}:\s*-?[\d.,]+/i;

/**
 * KEYS WHERE THERE ARE KEYS, LABELLED FIGURES WHERE THERE ARE NOT.
 *
 * A plain text scan over a JSON payload is unusable: smart_read answers with the
 * fixture's own source, and one of the fixtures is `token-counter.ts`, so the
 * words themselves appear in content that is not a claim about anything. So a
 * payload that parses is walked by KEY and its string values are never looked
 * inside.
 *
 * A payload that does NOT parse is a human report, and is scanned line by line
 * -- minus the lines that are the fixture's own content, because smart_pretty
 * answers with the formatted source and `token-counter.ts` carries the line
 * `percentSaved: 100,`, which is a claim in shape and content in fact.
 *
 * @param contentLines the baseline's own lines, trimmed and whitespace-collapsed
 *   the same way the scan collapses the lines it tests. Lines the fixture
 *   already contains are content; a report's own lines are not in it.
 * @returns the claims found, never null: a part that cannot be parsed is still
 *   read, so there is no longer a way for the scan to look at nothing and
 *   report the same clean result as a scan that looked.
 */
export function selfClaimsInPart(text, contentLines = new Set()) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    const found = new Set();
    for (const raw of text.split('\n')) {
      const line = raw.trim().replace(/\s+/g, ' ');
      if (line === '' || contentLines.has(line)) continue;
      const match = line.match(PROSE_CLAIM);
      if (match) found.add(match[1].toLowerCase());
    }
    return [...found].sort();
  }
  const found = new Set();
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    for (const [key, value] of Object.entries(node)) {
      if (SELF_CLAIM_KEYS.has(key)) found.add(key);
      walk(value);
    }
  };
  walk(parsed);
  return [...found];
}

/** The baseline's lines, in the form the prose scan compares against. */
export function contentLinesOf(text) {
  return new Set(
    text
      .split('\n')
      .map((line) => line.trim().replace(/\s+/g, ' '))
      .filter((line) => line !== '')
  );
}

export async function measure(server, testCase) {
  const path = join(FIXTURES, testCase.fixture);
  // A case may name more than one file as its baseline, for a tool whose whole
  // job is to save the caller from reading a set of them. The texts are joined
  // the way the tool under test joins them, so both sides of the ratio are
  // counted over the same bytes; one fixture is still the common case.
  const baselineText = (testCase.baselineFixtures ?? [testCase.fixture])
    .map((entry) => readFileSync(join(FIXTURES, entry), 'utf8'))
    .join('\n');
  const baseline = countTokens(baselineText);
  const reply = await server.send('tools/call', {
    name: testCase.tool,
    arguments: testCase.args(path),
  });
  // Every part of every message this case produces -- the first reply, each
  // further chunk, each expansion, and the repeat read -- is scanned where it
  // arrives, because a claim could be published on any one of them.
  const claims = new Set();
  const content = contentLinesOf(baselineText);
  let partsScanned = 0;
  const payloadOf = (message) => {
    const parts = message.result?.content || [];
    for (const part of parts) {
      partsScanned += 1;
      for (const key of selfClaimsInPart(part.text || '', content))
        claims.add(key);
    }
    return parts.map((part) => part.text || '').join('\n');
  };

  /**
   * A PAGE IS NOT A SAVING.
   *
   * smart_read answered a 21KB fixture with chunk 0 of 6 and the harness
   * recorded a 96% reduction -- for one sixth of the file. A caller who wants
   * the file pays for all six, so counting the first page as the cost of
   * reading the file credits the tool with pagination. Where a payload declares
   * more chunks, the rest are fetched and counted too, which is what reading
   * the file through this tool actually costs.
   */
  const withAllChunks = async (first) => {
    let text = payloadOf(first);
    const declared = text.match(/"chunkCount":\s*(\d+)/);
    const count = declared ? Number(declared[1]) : 1;
    for (let index = 1; index < count; index += 1) {
      const page = await server.send('tools/call', {
        name: testCase.tool,
        arguments: { ...testCase.args(path), chunkIndex: index },
      });
      text += '\n' + payloadOf(page);
    }
    return { text, chunks: count };
  };

  /**
   * AN ELISION IS NOT A SAVING EITHER.
   *
   * Every result leaves this server through the progressive-disclosure layer,
   * which may replace a section with a one-line marker naming what it withheld
   * and a handle to retrieve it. smart_pretty returned a 1,270-token file as a
   * 95-token preview and the harness recorded 92.5% -- for a payload whose
   * `data.format.code` had been elided outright. That is the same defect the
   * chunk walk above exists to prevent: the content the caller asked for was
   * not in the response, and it was not free, it was one `expand` call away.
   *
   * So the handles are followed and charged, which is what getting the whole
   * answer through this tool actually costs. A single pass is enough: `expand`
   * serves the stored output from the local store rather than re-running the
   * tool, so what comes back is not itself a preview.
   */
  const withExpansions = async (text) => {
    const refs = [
      ...new Set(
        [...text.matchAll(/\(expand ([0-9a-f]+)\)/g)].map((m) => m[1])
      ),
    ];
    let whole = text;
    for (const ref of refs) {
      const expanded = await server.send('tools/call', {
        name: 'expand',
        arguments: { ref },
      });
      whole += '\n' + payloadOf(expanded);
    }
    return { text: whole, expansions: refs.length };
  };

  const firstRead = await withAllChunks(reply);
  const firstWhole = await withExpansions(firstRead.text);
  const payload = firstWhole.text;
  // A REFUSAL IS A SHAPE, NOT A SUBSTRING. Hunting for an "error" key anywhere
  // in the payload threw away smart_refactor's readings, because a refactoring
  // report legitimately carries error fields about the code it examined. The
  // tools that really refuse answer with an error object and nothing else, so
  // that is what this looks for.
  const trimmed = payload.trim();
  const refused =
    !!reply.error ||
    reply.result?.isError === true ||
    payload.includes('No validation schema available') ||
    /^\{\s*"error"\s*:/.test(trimmed);
  const treatment = countTokens(payload);

  // THE SECOND READING IS THE ONE THE DESCRIPTIONS ARE ABOUT. Several of them
  // credit their saving to "intelligent caching", and a single call never
  // reaches that path -- it is the call that populates it. Asking twice is the
  // difference between measuring what a tool costs and measuring what it claims.
  const again = await server.send('tools/call', {
    name: testCase.tool,
    arguments: testCase.args(path),
  });
  const repeatRead = await withAllChunks(again);
  const repeatWhole = await withExpansions(repeatRead.text);
  const repeatPayload = repeatWhole.text;
  const repeatRefused =
    !!again.error ||
    again.result?.isError === true ||
    repeatPayload.includes('No validation schema available') ||
    /^\{\s*"error"\s*:/.test(repeatPayload.trim());
  const repeatTreatment = countTokens(repeatPayload);

  return {
    tool: testCase.tool,
    fixture: testCase.fixture,
    baseline,
    treatment,
    reduction: refused ? null : reduction(baseline, treatment),
    repeatTreatment,
    repeatReduction: repeatRefused
      ? null
      : reduction(baseline, repeatTreatment),
    chunks: firstRead.chunks,
    expansions: firstWhole.expansions,
    refused,
    detail: refused ? payload.slice(0, 160).replace(/\s+/g, ' ') : '',
    selfClaims: [...claims].sort(),
    partsScanned,
  };
}

/**
 * How many independent passes a recording rests on.
 *
 * Three rather than two because two readings that agree cannot be told from one
 * reading taken twice by luck, and three rather than ten because the quantity is
 * now deterministic: the passes exist to prove that, not to average it away. A
 * pass costs about ninety seconds.
 */
const RECORD_PASSES = 3;

/** One full sweep of every case, each on its own server. */
async function measureAll() {
  const rows = [];
  // ONE SERVER PER CASE, BECAUSE THE CASES SHARE FIXTURES.
  //
  // A single server for the whole table gave every case after the first a
  // cache another case had populated on the same fixture, so smart_read's
  // "first read" of smart-complexity.ts was really its seventh: the harness
  // recorded 189 tokens where a genuinely cold call returns 4647 characters.
  // Whatever the run costs in startup, a first read has to be first.
  for (const testCase of CASES) {
    const server = new Server();
    await server.start();
    try {
      rows.push(await measure(server, testCase));
    } finally {
      server.stop();
    }
  }
  return rows;
}

/** The claims a sweep supports, keyed by tool -- what --record would publish. */
function claimsFrom(rows) {
  const byTool = new Map();
  for (const r of rows) {
    if (!byTool.has(r.tool)) byTool.set(r.tool, []);
    byTool.get(r.tool).push(r);
  }
  const claims = {};
  for (const [tool, toolRows] of byTool) {
    const first = claimFor(toolRows);
    const again = claimFor(
      toolRows.map((r) => ({ reduction: r.repeatReduction }))
    );
    claims[tool] = {
      first: first ? { lo: first.lo, hi: first.hi, text: first.text } : null,
      repeated: again ? { lo: again.lo, hi: again.hi, text: again.text } : null,
      fixtures: toolRows.length,
    };
  }
  return claims;
}

async function main() {
  const recording = process.argv.includes('--record');
  const passes = [await measureAll()];
  if (recording) {
    for (let pass = 1; pass < RECORD_PASSES; pass += 1) {
      passes.push(await measureAll());
    }
  }
  const rows = passes[0];

  const pctOf = (value) =>
    value === null ? 'NO MEASUREMENT' : `${(value * 100).toFixed(1)}%`;

  console.log(`encoding ${ENCODING_NAME}`);
  console.log(
    'tool                 fixture                baseline   first    again   first%    again%'
  );
  for (const r of rows) {
    console.log(
      `${r.tool.padEnd(20)} ${r.fixture.padEnd(22)} ${String(r.baseline).padStart(8)} ${String(r.treatment).padStart(7)} ${String(r.repeatTreatment).padStart(8)} ${pctOf(r.reduction).padStart(8)} ${pctOf(r.repeatReduction).padStart(9)}`
    );
    if (r.refused) console.log(`  refused: ${r.detail}`);
  }

  const byTool = new Map();
  for (const r of rows) {
    if (!byTool.has(r.tool)) byTool.set(r.tool, []);
    byTool.get(r.tool).push(r);
  }
  console.log('');
  console.log('what each description could honestly say:');
  for (const [tool, toolRows] of byTool) {
    const first = claimFor(toolRows);
    const again = claimFor(
      toolRows.map((r) => ({ reduction: r.repeatReduction }))
    );
    const repeated = again ? again.text : 'nothing measured';
    console.log(
      `  ${tool.padEnd(20)} ${
        first
          ? `${first.text} first read, ${repeated} repeated, over ${first.n} fixture(s)`
          : 'nothing measured -- no claim available'
      }`
    );
  }

  /*
   * A SELF-CLAIM IN A REPLY VOIDS THE WHOLE SWEEP, RECORDING OR NOT.
   *
   * All fourteen tools used to publish a figure about their own saving, and not
   * one of them was the figure the caller paid: each counted an internal object,
   * a compact form it did not send, or the very string the reply would be built
   * around afterwards. The readings below are the replacement, so a reply that
   * still carries a competing figure makes them unsafe to read as well as
   * unsafe to publish -- a reader has two numbers and no way to tell which is
   * the measurement.
   *
   * THE SCAN HAS TO PROVE IT LOOKED, and the first version of it could not. It
   * walked keys and gave up on a part that would not parse, which is how six of
   * the fourteen answer -- so it read 54 of 90 parts, said nothing was claiming,
   * and was blind to the two figures that started this: a -92% footer and a flat
   * 85%, both printed as prose and never fields. Every part is read now, so the
   * count below is the count of parts, and a sweep that somehow read none of
   * them is a dead instrument rather than a pass.
   */
  const claiming = rows.filter((r) => r.selfClaims.length > 0);
  const scannedParts = rows.reduce((sum, r) => sum + r.partsScanned, 0);
  console.log('');
  console.log(
    `self-claim scan: ${scannedParts} reply part(s) read, ` +
      `${claiming.length} case(s) still publishing a saving`
  );
  if (claiming.length > 0) {
    for (const r of claiming) {
      console.log(`  ${r.tool} ${r.fixture} ${r.selfClaims.join(', ')}`);
    }
    console.log(
      'REFUSED: a tool states a saving of its own, so these readings mean nothing.'
    );
    process.exit(1);
  }
  if (scannedParts === 0) {
    console.log(
      'REFUSED: no reply part was read, so the self-claim scan proves nothing.'
    );
    process.exit(1);
  }

  // --record writes the readings down so a description can be checked against
  // them without spawning a server -- but ONLY once every pass agreed on what it
  // would write. A figure that moves between identical runs is not a measurement
  // of anything, and the previous version of this block wrote whichever one the
  // last pass happened to produce.
  if (recording) {
    const perPass = passes.map((pass) => claimsFrom(pass));
    const reference = JSON.stringify(perPass[0]);
    const disagreed = [];
    for (const tool of Object.keys(perPass[0])) {
      const seen = perPass.map((claims) => JSON.stringify(claims[tool]));
      if (new Set(seen).size > 1) disagreed.push({ tool, seen });
    }

    // THE SPREAD IS RECORDED, NOT CHECKED. Bytes may legitimately differ one day
    // without the published whole-percent bracket moving; that is worth seeing
    // in the file rather than being the thing that blocks a recording.
    let maxTokenSpread = 0;
    const drifting = [];
    for (let i = 0; i < rows.length; i += 1) {
      const key = `${rows[i].tool}/${rows[i].fixture}`;
      for (const field of ['treatment', 'repeatTreatment']) {
        const seen = passes.map((pass) => pass[i][field]);
        const spread = Math.max(...seen) - Math.min(...seen);
        if (spread > 0) {
          maxTokenSpread = Math.max(maxTokenSpread, spread);
          drifting.push({ case: key, field, seen });
        }
      }
    }

    if (disagreed.length > 0) {
      console.log('');
      console.log(
        `REFUSED: ${RECORD_PASSES} passes do not agree on the bracket, so nothing was written.`
      );
      for (const { tool, seen } of disagreed) {
        console.log(`  ${tool}`);
        for (const one of seen) console.log(`    ${one}`);
      }
      for (const d of drifting) {
        console.log(`  drift ${d.case} ${d.field} ${d.seen.join(' / ')}`);
      }
      process.exit(1);
    }

    const at = join(HERE, 'results', 'per-tool-reduction.json');
    mkdirSync(dirname(at), { recursive: true });
    const claims = JSON.parse(reference);
    for (const claim of Object.values(claims)) claim.samples = RECORD_PASSES;
    writeFileSync(
      at,
      JSON.stringify(
        {
          encoding: ENCODING_NAME,
          recorded: new Date().toISOString(),
          // What the figures below rest on: how many independent sweeps produced
          // them, and whether the readings themselves were byte-stable.
          stability: {
            passes: RECORD_PASSES,
            maxTokenSpread,
            drifting,
          },
          claims,
          rows,
        },
        null,
        2
      ) + '\n'
    );
    console.log(
      `recorded ${rows.length} reading(s) from ${RECORD_PASSES} agreeing pass(es) to ${at}`
    );
  }

  const measured = rows.filter((r) => r.reduction !== null).length;
  console.log('');
  console.log(
    `${measured} of ${rows.length} reading(s) produced a measurement`
  );
  process.exit(measured === 0 ? 1 : 0);
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
