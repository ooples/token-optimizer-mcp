/**
 * Fresh-process probe for unrooted wiki_write containment.
 *
 * os.homedir() may retain the home resolved when Node starts, especially on
 * Windows. The parent test therefore sets HOME and USERPROFILE before spawning
 * this process instead of mutating either variable inside a Jest worker.
 */
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

import {
  canonicalKey,
  load,
  nodeId,
  projectRootFor,
  unrootedRoot,
  wikiDir,
} from '../../hooks-core/wiki.mjs';
import {
  isFilesystemRoot,
  writeHarvested,
} from '../../hooks-core/harvest-write.mjs';
import { canonicalPath } from '../../hooks-core/paths.mjs';
import { ORIGIN_AGENT } from '../../hooks-core/curate.mjs';

const scenario = process.env.TOKEN_OPTIMIZER_TEST_SCENARIO;
const sandbox = process.env.TOKEN_OPTIMIZER_TEST_SANDBOX;
if (!scenario || !sandbox)
  throw new Error('probe scenario and sandbox are required');

const home = homedir();
const outsideHome = join(sandbox, 'outside-home');
mkdirSync(outsideHome, { recursive: true });

function writeFinding(anchors, projectRoot = unrootedRoot()) {
  return writeHarvested(
    wikiDir(projectRoot),
    [
      {
        type: 'finding',
        claim: 'An unrooted anchor must remain inside its authorized boundary.',
        confidence: 0.9,
        anchors,
      },
    ],
    { sessionId: null, origin: ORIGIN_AGENT, projectRoot }
  );
}

let result;

if (scenario === 'home') {
  const anchor = join(home, 'config.json');
  writeFileSync(anchor, '{}\n');
  const project = projectRootFor(anchor, process.cwd());
  result = {
    projectIsUnrooted: project === unrootedRoot(),
    written: writeFinding([anchor], project).length,
  };
} else if (scenario === 'outside') {
  const anchor = join(outsideHome, 'secret.txt');
  writeFileSync(anchor, 'not under home\n');
  const project = projectRootFor(anchor, process.cwd());
  result = {
    projectIsUnrooted: project === unrootedRoot(),
    written: writeFinding([anchor], project).length,
  };
} else if (scenario === 'root') {
  const anchor = join(sandbox, 'root-secret.txt');
  writeFileSync(anchor, 'beneath the simulated root home\n');
  const project = projectRootFor(anchor, process.cwd());
  result = {
    homeIsRoot: isFilesystemRoot(canonicalPath(home)),
    projectIsUnrooted: project === unrootedRoot(),
    written: writeFinding([anchor], project).length,
  };
} else if (scenario === 'case') {
  const actual = join(home, 'CaseConfig.json');
  writeFileSync(actual, '{}\n');
  const differentlyCased = actual.toLowerCase();
  const project = projectRootFor(differentlyCased, process.cwd());
  result = {
    exists: existsSync(differentlyCased),
    projectIsUnrooted: project === unrootedRoot(),
    written: writeFinding([differentlyCased], project).length,
  };
} else if (scenario === 'link') {
  const target = join(outsideHome, 'linked-secret.txt');
  const link = join(home, 'escape');
  writeFileSync(target, 'physically outside home\n');
  symlinkSync(
    outsideHome,
    link,
    process.platform === 'win32' ? 'junction' : 'dir'
  );
  const anchor = join(link, 'linked-secret.txt');
  const project = projectRootFor(anchor, process.cwd());
  result = {
    projectIsUnrooted: project === unrootedRoot(),
    written: writeFinding([anchor], project).length,
  };
} else if (scenario === 'cross-project') {
  const looseAnchor = join(home, 'loose-config.json');
  const repository = join(home, 'repository');
  const repositoryAnchor = join(repository, 'project-secret.txt');
  mkdirSync(join(repository, '.git'), { recursive: true });
  writeFileSync(looseAnchor, '{}\n');
  writeFileSync(repositoryAnchor, 'belongs to another graph\n');

  const project = projectRootFor(looseAnchor, process.cwd());
  const repositoryProject = projectRootFor(repositoryAnchor, process.cwd());
  const written = writeFinding([looseAnchor, repositoryAnchor], project);
  const graph = load(wikiDir(project));
  const repositoryNode = nodeId('file', canonicalKey('file', repositoryAnchor));
  result = {
    projectIsUnrooted: project === unrootedRoot(),
    projectsDiffer: canonicalPath(repositoryProject) !== canonicalPath(project),
    written: written.length,
    repositoryIndexed: graph.nodes.has(repositoryNode),
  };
} else {
  throw new Error(`unknown probe scenario: ${scenario}`);
}

process.stdout.write(`${JSON.stringify(result)}\n`);
