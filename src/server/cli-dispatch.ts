import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const SUBCOMMAND_SCRIPTS: Record<string, string> = {
  install: '../../scripts/install-cli.mjs',
  'install-client': '../../scripts/install-client-hooks.mjs',
  uninstall: '../../scripts/uninstall.mjs',
  doctor: '../../scripts/doctor.mjs',
  storage: '../../scripts/storage.mjs',
  diagnostics: '../../scripts/export-diagnostics.mjs',
  run: '../../scripts/run-client.mjs',
  route: '../../scripts/route-client.mjs',
  savings: '../savings/cli.js',
  learn: '../learn/cli.js',
  update: '../update/cli.js',
  rollout: '../rollout/cli.js',
  inspect: '../inspect/cli.js',
  proxy: '../proxy/cli.js',
};

function writeStdout(text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    process.stdout.write(text, (error) => (error ? reject(error) : resolve()));
  });
}

/** Return false only when the caller should start the stdio MCP server. */
export async function dispatchCli(args: string[]): Promise<boolean> {
  const first = args[0];
  if (first === '--version' || first === '-v') {
    const pkg = JSON.parse(
      await readFile(new URL('../../package.json', import.meta.url), 'utf8')
    ) as { version?: string };
    await writeStdout(`${pkg.version ?? 'unknown'}\n`);
    return true;
  }
  if (first === '--help' || first === '-h' || first === 'help') {
    await writeStdout(
      [
        '@ooples/token-optimizer-mcp — MCP Server & CLI Dispatcher',
        '',
        'Usage:',
        '  token-optimizer-mcp                     Start stdio MCP server (default)',
        '  token-optimizer-mcp --version | -v      Print package version',
        '  token-optimizer-mcp --help | -h         Show this help message',
        '  token-optimizer-mcp <command> [args...]',
        `Commands: ${Object.keys(SUBCOMMAND_SCRIPTS).join(', ')}`,
        '',
      ].join('\n')
    );
    return true;
  }
  if (!first || !Object.hasOwn(SUBCOMMAND_SCRIPTS, first)) return false;

  const script = fileURLToPath(
    new URL(SUBCOMMAND_SCRIPTS[first], import.meta.url)
  );
  process.exitCode = await new Promise<number>((resolve) => {
    const child = spawn(process.execPath, [script, ...args.slice(1)], {
      stdio: 'inherit',
      env: process.env,
    });
    const interrupt = () => {
      child.kill('SIGINT');
    };
    const terminate = () => {
      child.kill('SIGTERM');
    };
    const cleanup = () => {
      process.off('SIGINT', interrupt);
      process.off('SIGTERM', terminate);
    };
    process.on('SIGINT', interrupt);
    process.on('SIGTERM', terminate);
    child.once('error', (error) => {
      cleanup();
      process.stderr.write(`[token-optimizer] ${error.message}\n`);
      resolve(1);
    });
    child.once('exit', (code, signal) => {
      cleanup();
      resolve(
        code ?? (signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 1)
      );
    });
  });
  return true;
}
