const fs = require('fs');
const path = require('path');

const SRC_DIR = path.join(__dirname, 'src', 'tools');

const PATH_MAPPINGS = {
  '../../core/cache': '../../core/cache-engine',
  '../../core/tokens': '../../core/token-counter',
};

let filesModified = 0;
let importsFixed = 0;

function fixPaths(content) {
  let modified = content;
  let fixCount = 0;

  Object.entries(PATH_MAPPINGS).forEach(([oldPath, newPath]) => {
    const patterns = [
      [`from '${oldPath}'`, `from '${newPath}'`],
      [`from "${oldPath}"`, `from "${newPath}"`],
    ];

    patterns.forEach(([find, replace]) => {
      if (modified.includes(find)) {
        const before = modified;
        modified = modified.split(find).join(replace);
        const count = (before.length - modified.length) / (find.length - replace.length);
        if (count > 0) fixCount += count;
      }
    });
  });

  return { content: modified, modified: fixCount > 0, fixCount };
}

function processDir(dir) {
  fs.readdirSync(dir, { withFileTypes: true }).forEach(entry => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      processDir(fullPath);
    } else if (entry.name.endsWith('.ts')) {
      const content = fs.readFileSync(fullPath, 'utf-8');
      const result = fixPaths(content);
      if (result.modified) {
        filesModified++;
        importsFixed += result.fixCount;
        fs.writeFileSync(fullPath, result.content, 'utf-8');
      }
    }
  });
}

console.log('Fixing import paths...');
processDir(SRC_DIR);
console.log(`Modified ${filesModified} files, fixed ${importsFixed} imports`);
