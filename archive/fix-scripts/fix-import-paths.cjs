const fs = require('fs');
const path = require('path');

const SRC_DIR = path.join(__dirname, 'src', 'tools');

// Mapping of hypercontext → token-optimizer file names
const PATH_MAPPINGS = {
  '../../core/cache': '../../core/cache-engine',
  '../../core/tokens': '../../core/token-counter',
  '../core/cache': '../core/cache-engine',
  '../core/tokens': '../core/token-counter',
};

let filesModified = 0;
let importsFixed = 0;

function fixImportPaths(content) {
  let modified = content;
  let fixCount = 0;

  for (const [oldPath, newPath] of Object.entries(PATH_MAPPINGS)) {
    const patterns = [
      { find: `from '${oldPath}'`, replace: `from '${newPath}'` },
      { find: `from "${oldPath}"`, replace: `from "${newPath}"` },
    ];

    for (const { find, replace } of patterns) {
      if (modified.includes(find)) {
        const count = (modified.match(new RegExp(find.replace(/[.*+?^${}()|[\]\]/g, '\$&'), 'g')) || []).length;
        fixCount += count;
        modified = modified.replace(new RegExp(find.replace(/[.*+?^${}()|[\]\]/g, '\$&'), 'g'), replace);
      }
    }
  }

  return { content: modified, modified: fixCount > 0, fixCount };
}

function processDirectory(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      processDirectory(fullPath);
    } else if (entry.name.endsWith('.ts')) {
      const content = fs.readFileSync(fullPath, 'utf-8');
      const result = fixImportPaths(content);
      if (result.modified) {
        filesModified++;
        importsFixed += result.fixCount;
        console.log(`✓ ${path.relative(process.cwd(), fullPath)} - Fixed ${result.fixCount} imports`);
        fs.writeFileSync(fullPath, result.content, 'utf-8');
      }
    }
  }
}

console.log('Fixing import paths (hypercontext → token-optimizer)...\n');
processDirectory(SRC_DIR);
console.log(`\n✅ Modified ${filesModified} files, fixed ${importsFixed} imports`);
console.log('\nRunning build to check error count...');
