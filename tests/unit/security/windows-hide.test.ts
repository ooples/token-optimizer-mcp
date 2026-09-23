import { describe, it, expect } from '@jest/globals';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';
import ts from 'typescript';

/**
 * No child process may pop a console window on Windows.
 *
 * WHY A RATCHET AND NOT A REVIEW. #409 was fixed the way this kind of thing
 * usually is -- call site by call site -- and one was missed: the daemon
 * spawned the MCP server with no `windowsHide`, so `token-optimizer-daemon`,
 * a published bin, flashed a console on every start. Nothing in the suite
 * would have said so, and nothing would say so about the next one either.
 *
 * WHY THE AST AND NOT A GREP. `/re/.exec(text)` and `db.exec(SCHEMA)` both
 * match a search for `exec(`, and this repo has plenty of each, so a text
 * scan has to be hand-tuned until it is quiet -- at which point it is a list
 * of today's call sites, not a rule. Resolving the callee to a binding
 * imported from `child_process` costs a parse and names exactly the calls
 * that spawn a process.
 */
const SRC = join(process.cwd(), 'src');
const SPAWNERS = new Set([
  'spawn',
  'spawnSync',
  'execFile',
  'execFileSync',
  'exec',
  'execSync',
]);

interface Site {
  readonly where: string;
  readonly callee: string;
  readonly hidden: boolean;
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (full.endsWith('.ts')) out.push(full);
  }
  return out;
}

/** Local names bound to a process-spawning import in this file, if any. */
function spawnerBindings(file: ts.SourceFile): Set<string> {
  const local = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      /^(node:)?child_process$/.test(node.moduleSpecifier.text)
    ) {
      const bindings = node.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          const imported = (element.propertyName ?? element.name).text;
          if (SPAWNERS.has(imported)) local.add(element.name.text);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return local;
}

/**
 * True only for an options object literal that says `windowsHide: true`.
 *
 * An options object we cannot read -- a variable, a spread with no literal
 * key -- counts as unhidden. The alternative is to trust it, and the whole
 * point of the check is that the missed site looked fine in review.
 */
function hidesTheWindow(argument: ts.Expression | undefined): boolean {
  if (argument === undefined || !ts.isObjectLiteralExpression(argument))
    return false;
  return argument.properties.some(
    (property) =>
      ts.isPropertyAssignment(property) &&
      property.name.getText() === 'windowsHide' &&
      property.initializer.kind === ts.SyntaxKind.TrueKeyword
  );
}

function collect(): Site[] {
  const sites: Site[] = [];
  for (const path of sourceFiles(SRC)) {
    const file = ts.createSourceFile(
      path,
      readFileSync(path, 'utf8'),
      ts.ScriptTarget.Latest,
      true
    );
    const local = spawnerBindings(file);
    if (local.size === 0) continue;
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        local.has(node.expression.text)
      ) {
        const line =
          file.getLineAndCharacterOfPosition(node.getStart()).line + 1;
        sites.push({
          where: `${relative(process.cwd(), path).replace(/\\/g, '/')}:${line}`,
          callee: node.expression.text,
          hidden: hidesTheWindow(node.arguments[node.arguments.length - 1]),
        });
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  return sites;
}

describe('child processes never open a console window', () => {
  const sites = collect();

  it('passes windowsHide at every call site in src', () => {
    const exposed = sites
      .filter((site) => !site.hidden)
      .map((site) => `${site.where} (${site.callee})`);
    expect(exposed).toEqual([]);
  });

  it('found the call sites it claims to police', () => {
    // NOT VACUOUS: a scanner that resolves nothing reports no violations, and
    // an empty list of exposed sites is exactly what passing looks like.
    expect(sites.length).toBeGreaterThanOrEqual(10);
    const files = new Set(sites.map((site) => site.where.split(':')[0]));
    expect(files).toContain('src/utils/safe-exec.ts');
    expect(files).toContain('src/proxy/supervisor.ts');
    expect(files).toContain('src/server/daemon.ts');
  });
});
