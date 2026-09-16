import { readFile, readdir, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function treeFiles(root, accept = () => true) {
  const files = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory() && entry.name !== '__pycache__')
      files.push(...(await treeFiles(path, accept)));
    else if (entry.isFile() && accept(path)) files.push(path);
  }
  return files.sort();
}
export async function hashes(paths) {
  const result = {};
  for (const path of paths) {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(path, { highWaterMark: 65536 }))
      hash.update(chunk);
    result[path] = hash.digest('hex');
  }
  return result;
}
export async function verifyFreeze(freeze) {
  const now = await hashes(Object.keys(freeze.sha256));
  for (const [path, hash] of Object.entries(now))
    if (hash !== freeze.sha256[path])
      throw Error(`Frozen artifact changed: ${path}`);
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const study = resolve(process.argv[2]);
  const root = resolve('.');
  const headroom = dirname(
    execFileSync(
      process.env.PYTHON || 'python',
      ['-c', 'import headroom; print(headroom.__file__)'],
      { encoding: 'utf8', windowsHide: true }
    ).trim()
  );
  const codex = join(process.env.APPDATA, 'npm/node_modules/@openai/codex');
  const files = [
    ...(await treeFiles(join(root, 'dist'), (p) => /\.(js|json)$/.test(p))),
    ...(await treeFiles(headroom, (p) => /\.(py|pyd)$/.test(p))),
    ...(await treeFiles(codex, (p) => /\.(js|json|exe)$/.test(p))),
    ...(await treeFiles(
      join(root, 'bench/live'),
      (p) => !p.includes(`${join('live', 'evidence')}`) && /\.(mjs|py)$/.test(p)
    )),
    join(study, 'plan.json'),
    join(study, 'PROTOCOL.md'),
    process.execPath,
  ];
  for (const name of ['continuation.json', 'AMENDMENT.md']) {
    const path = join(study, name);
    try {
      await readFile(path);
      files.push(path);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  const dependencies = JSON.parse(
    execFileSync(
      process.env.PYTHON || 'python',
      [
        '-c',
        'import importlib.metadata as m,json; print(json.dumps(sorted([(d.metadata["Name"],d.version) for d in m.distributions() if d.metadata["Name"]])))',
      ],
      { encoding: 'utf8', windowsHide: true }
    )
  );
  const freeze = {
    created: new Date().toISOString(),
    root,
    headroom,
    codex,
    node: process.version,
    pythonDependencies: dependencies,
    sha256: await hashes(files),
  };
  await writeFile(
    join(study, 'freeze.json'),
    JSON.stringify(freeze, null, 2) + '\n',
    { flag: 'wx' }
  );
  console.log(JSON.stringify({ frozenFiles: files.length }));
}
