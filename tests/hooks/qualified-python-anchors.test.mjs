import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { extractSymbols, resolveSymbol } from '../../src/hooks-core/symbols.mjs';
import { writeHarvested } from '../../src/hooks-core/harvest-write.mjs';
import { load, nodeId } from '../../src/hooks-core/wiki.mjs';
import { checkAnchor } from '../../src/hooks-core/staleness.mjs';
import { canonicalPath } from '../../src/hooks-core/paths.mjs';

let workspace;
let graph;
let file;
beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'qualified-python-'));
  graph = join(workspace, 'graph');
  file = join(workspace, 'money.py');
});
afterEach(() => {
  if (!resolve(workspace).startsWith(resolve(tmpdir(), 'qualified-python-')))
    throw new Error('Unexpected fixture cleanup target');
  rmSync(workspace, { recursive: true, force: true });
});

const finding = (name) => ({ type: 'finding', scope: 'project', confidence: .95,
  claim: 'The amount conversion must round rather than truncate.',
  evidence: 'A deterministic fixture.', applicability: 'This conversion method.',
  anchors: [`${file}#${name}`] });

test('the paid-run class-qualified anchor stores without changing legacy symbol keys', () => {
  const source = 'class Money:\n    @classmethod\n    def from_float(cls, value):\n        return round(value * 100)\n';
  writeFileSync(file, source);
  expect(extractSymbols(file, source).map((s) => s.name)).toEqual(['Money', 'from_float']);
  expect(writeHarvested(graph, [finding('Money.from_float')], { projectRoot: workspace })).toHaveLength(1);
  const anchor = load(graph).nodes.get(nodeId('symbol', `${canonicalPath(file)}#Money.from_float`));
  expect(checkAnchor(anchor)).toEqual({ fresh: true });
});

test('class reordering and unrelated method edits cannot change a qualified anchor', () => {
  const a = 'class A:\n    def convert(self):\n        return 1\n';
  const b = 'class B:\n    def convert(self):\n        return 2\n';
  writeFileSync(file, a + b);
  writeHarvested(graph, [finding('A.convert')], { projectRoot: workspace });
  const anchor = load(graph).nodes.get(nodeId('symbol', `${canonicalPath(file)}#A.convert`));
  writeFileSync(file, b.replace('return 2', 'return 999') + a);
  expect(checkAnchor(anchor)).toEqual({ fresh: true });
  writeFileSync(file, b + a.replace('return 1', 'return 100'));
  expect(checkAnchor(anchor)).toMatchObject({ fresh: false, reason: 'symbol body changed' });
});

test('wrong classes and repeated qualified scopes never resolve by method name alone', () => {
  const source = 'class Money:\n    def from_float(self):\n        return 1\n';
  expect(resolveSymbol(file, source, 'Other.from_float')).toBeNull();
  expect(resolveSymbol(file, source + source, 'Money.from_float')).toBeNull();
  writeFileSync(file, source);
  expect(writeHarvested(graph, [finding('Other.from_float')], { projectRoot: workspace })).toHaveLength(0);
});

test('nested classes, async methods and tab indentation resolve exact lexical scopes', () => {
  const source = 'class Outer:\n\tclass Inner:\n\t\tasync def load(self):\n\t\t\treturn 3\n';
  expect(resolveSymbol(file, source, 'Outer.Inner.load')).toMatchObject({ name: 'Outer.Inner.load', line: 3 });
  expect(resolveSymbol(file, source, 'Outer.load')).toBeNull();
});

test('moving a method to another class invalidates its old qualified anchor', () => {
  writeFileSync(file, 'class Money:\n    def convert(self):\n        return 1\n');
  writeHarvested(graph, [finding('Money.convert')], { projectRoot: workspace });
  const anchor = load(graph).nodes.get(nodeId('symbol', `${canonicalPath(file)}#Money.convert`));
  writeFileSync(file, 'class Other:\n    def convert(self):\n        return 1\n');
  expect(checkAnchor(anchor)).toMatchObject({ fresh: false, reason: 'symbol no longer found' });
});
