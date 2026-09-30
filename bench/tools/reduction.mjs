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
 * Nothing here is timed, so nothing here needs a quiet machine. The payloads
 * are not quite byte-stable all the same: smart_complexity reports a "duration"
 * field, so two runs of the same call differ by a digit and the reading moves
 * by one or two tokens in sixteen hundred. That is 0.1% and it has never moved
 * a bracket, but it is why these figures are stated to whole percent.
 */

import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
    lo === hi
      ? `${lo}%`
      : lo < 0
        ? `${lo}% to ${hi}%`
        : `${lo}-${hi}%`;
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
  { tool: 'smart_complexity', fixture: 'smart-complexity.ts', args: byFilePath },
  { tool: 'smart_complexity', fixture: 'token-counter.ts', args: byFilePath },
  { tool: 'smart_complexity', fixture: 'tool-profile.ts', args: byFilePath },
  { tool: 'smart_exports', fixture: 'token-counter.ts', args: byFilePath },
  { tool: 'smart_exports', fixture: 'tool-profile.ts', args: byFilePath },
  { tool: 'smart_imports', fixture: 'smart-complexity.ts', args: byFilePath },
  { tool: 'smart_imports', fixture: 'token-counter.ts', args: byFilePath },
  { tool: 'smart_symbols', fixture: 'smart-complexity.ts', args: byFilePath },
  { tool: 'smart_symbols', fixture: 'tool-profile.ts', args: byFilePath },
  { tool: 'smart_security', fixture: 'smart-complexity.ts', args: byFilePath },
  { tool: 'smart_refactor', fixture: 'smart-complexity.ts', args: byFilePath },
  { tool: 'smart_refactor', fixture: 'tool-profile.ts', args: byFilePath },
  { tool: 'smart_config_read', fixture: 'package.json', args: byPath },
  { tool: 'smart_config_read', fixture: 'large-project/package.json', args: byPath },
  { tool: 'smart_env', fixture: 'example.env', args: byEnvFile },
  { tool: 'smart_env', fixture: 'large.env', args: byEnvFile },
  { tool: 'smart_typescript', fixture: 'tool-profile.ts', args: byFileList },
  { tool: 'smart_dependencies', fixture: 'package.json', args: byFileList },
  { tool: 'smart_dependencies', fixture: 'large-project/package.json', args: byFileList },
  { tool: 'smart_read', fixture: 'smart-complexity.ts', args: byPathKey },
  { tool: 'smart_read', fixture: 'token-counter.ts', args: byPathKey },
  { tool: 'smart_read', fixture: 'tool-profile.ts', args: byPathKey },
  { tool: 'smart_package_json', fixture: 'package.json', args: byProjectRoot },
  { tool: 'smart_package_json', fixture: 'large-project/package.json', args: byProjectRoot },
  { tool: 'smart_tsconfig', fixture: 'tsconfig.json', args: byConfigPath },
  { tool: 'smart_tsconfig', fixture: 'large-project/tsconfig.json', args: byConfigPath },
  // A syntax formatter cannot reduce anything -- it returns the same code, and
  // highlighting adds markup to it. Its 86% claim is measured here rather than
  // argued about.
  { tool: 'smart_pretty', fixture: 'tool-profile.ts', args: byFormatting },
];
/** A minimal JSON-RPC client over the server's real stdio transport. */
export class Server {
  constructor() {
    const cacheDir = mkdtempSync(join(tmpdir(), 'tool-reduction-'));
    this.cacheDir = cacheDir;
    this.child = spawn(process.execPath, [join(ROOT, 'dist', 'server', 'index.js')], {
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
    });
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
        rej(new Error(`${method} timed out; stderr: ${this.stderr.slice(-400)}`));
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
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n'
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
export async function measure(server, testCase) {
  const path = join(FIXTURES, testCase.fixture);
  const baselineText = readFileSync(path, 'utf8');
  const baseline = countTokens(baselineText);
  const reply = await server.send('tools/call', {
    name: testCase.tool,
    arguments: testCase.args(path),
  });
  const payloadOf = (message) =>
    (message.result?.content || []).map((part) => part.text || '').join('\n');

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

  const firstRead = await withAllChunks(reply);
  const payload = firstRead.text;
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
  const repeatPayload = repeatRead.text;
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
    refused,
    detail: refused ? payload.slice(0, 160).replace(/\s+/g, ' ') : '',
  };
}

async function main() {
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

  // --record writes the readings down so a description can be checked against
  // them without spawning a server. Nothing here is timed, so a recording taken
  // on a busy machine is as good as one taken on a quiet one.
  if (process.argv.includes('--record')) {
    const at = join(HERE, 'results', 'per-tool-reduction.json');
    mkdirSync(dirname(at), { recursive: true });
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
    writeFileSync(
      at,
      JSON.stringify(
        { encoding: ENCODING_NAME, recorded: new Date().toISOString(), claims, rows },
        null,
        2
      ) + '\n'
    );
    console.log(`recorded ${rows.length} reading(s) to ${at}`);
  }

  const measured = rows.filter((r) => r.reduction !== null).length;
  console.log('');
  console.log(`${measured} of ${rows.length} reading(s) produced a measurement`);
  process.exit(measured === 0 ? 1 : 0);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}