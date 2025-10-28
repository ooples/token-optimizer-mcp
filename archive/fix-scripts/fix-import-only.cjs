const fs = require('fs');
const path = require('path');

const SRC_DIR = path.join(__dirname, 'src', 'tools');
let filesModified = 0;
let importsFixed = 0;

function fixImports(content) {
  const lines = content.split('\n');
  let modified = false;
  let fixCount = 0;

  const fixedLines = lines.map(line => {
    if (!line.trim().startsWith('import ')) return line;
    
    const fixedLine = line.replace(/import\s+\{([^}]+)\}/g, (match, imports) => {
      const fixed = imports.replace(/_([a-zA-Z][a-zA-Z0-9]*)/g, (m, name) => {
        fixCount++;
        return name;
      });
      return `import {${fixed}}`;
    });
    
    if (fixedLine !== line) modified = true;
    return fixedLine;
  });

  return { content: fixedLines.join('\n'), modified, fixCount };
}

function processDirectory(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      processDirectory(fullPath);
    } else if (entry.name.endsWith('.ts')) {
      const content = fs.readFileSync(fullPath, 'utf-8');
      const result = fixImports(content);
      if (result.modified) {
        filesModified++;
        importsFixed += result.fixCount;
        fs.writeFileSync(fullPath, result.content, 'utf-8');
      }
    }
  }
}

processDirectory(SRC_DIR);
console.log(`Fixed ${importsFixed} imports in ${filesModified} files`);
