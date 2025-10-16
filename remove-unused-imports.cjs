const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Get all TS6133 and TS6192 errors from build output
console.log('Getting list of unused imports from build errors...');

let buildOutput;
try {
  buildOutput = execSync('npm run build 2>&1', {
    cwd: __dirname,
    encoding: 'utf-8',
    maxBuffer: 10 * 1024 * 1024
  });
} catch (error) {
  // Build will fail, but we can still get the output
  buildOutput = error.stdout || error.output.join('');
}

const lines = buildOutput.split('\n');
const unusedImports = new Map(); // filepath -> Set of unused imports

lines.forEach(line => {
  // Clean up any \r characters from Windows line endings
  const cleanLine = line.replace(/\r/g, '');

  // Match: src/tools/.../file.ts(line,col): error TS6133: 'ImportName' is declared but its value is never read.
  const ts6133Match = cleanLine.match(/^(.+\.ts)\(\d+,\d+\): error TS6133: '(.+)' is declared but its value is never read\.$/);
  if (ts6133Match) {
    const [, filePath, importName] = ts6133Match;
    if (!unusedImports.has(filePath)) {
      unusedImports.set(filePath, new Set());
    }
    unusedImports.get(filePath).add(importName);
  }

  // Match: src/tools/.../file.ts(line,col): error TS6192: All imports in import declaration are unused.
  const ts6192Match = cleanLine.match(/^(.+\.ts)\(\d+,\d+\): error TS6192: All imports in import declaration are unused\.$/);
  if (ts6192Match) {
    const [, filePath] = ts6192Match;
    if (!unusedImports.has(filePath)) {
      unusedImports.set(filePath, new Set());
    }
    unusedImports.get(filePath).add('__ALL_IMPORTS_UNUSED__');
  }
});

console.log(`Found ${unusedImports.size} files with unused imports`);

let filesModified = 0;
let importsRemoved = 0;

for (const [relativeFilePath, unusedSet] of unusedImports.entries()) {
  const filePath = path.join(__dirname, relativeFilePath);

  if (!fs.existsSync(filePath)) {
    console.log(`Skipping ${relativeFilePath} - file not found`);
    continue;
  }

  let content = fs.readFileSync(filePath, 'utf-8');
  const originalContent = content;
  const lines = content.split('\n');
  const modifiedLines = [];
  let removed = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Check if this is an import line
    if (!line.trim().startsWith('import ')) {
      modifiedLines.push(line);
      continue;
    }

    // If ALL imports are unused (TS6192), skip this entire line
    if (unusedSet.has('__ALL_IMPORTS_UNUSED__')) {
      // Check if this line has any of the unused imports
      let hasUnused = false;
      for (const unusedName of unusedSet) {
        if (unusedName !== '__ALL_IMPORTS_UNUSED__' && line.includes(unusedName)) {
          hasUnused = true;
          break;
        }
      }

      // If this import line is completely unused, skip it
      const importMatch = line.match(/import\s+(?:\{[^}]+\}|[^;]+)\s+from/);
      if (importMatch) {
        // Check if all imports in this line are in our unused set
        const importsMatch = line.match(/import\s+\{([^}]+)\}/);
        if (importsMatch) {
          const imports = importsMatch[1].split(',').map(s => s.trim());
          const allUnused = imports.every(imp => unusedSet.has(imp));
          if (allUnused) {
            removed++;
            continue; // Skip this line entirely
          }
        }
      }
    }

    // For TS6133, remove specific unused imports from the line
    let modifiedLine = line;
    let lineModified = false;

    // Extract imports from the line: import { A, B, C } from '...'
    const importsMatch = line.match(/import\s+\{([^}]+)\}\s+from/);
    if (importsMatch) {
      const imports = importsMatch[1].split(',').map(s => s.trim());
      const keptImports = imports.filter(imp => !unusedSet.has(imp));

      if (keptImports.length === 0) {
        // All imports removed, skip this line
        removed++;
        continue;
      } else if (keptImports.length < imports.length) {
        // Some imports removed
        const restOfLine = line.substring(line.indexOf('from'));
        modifiedLine = `import { ${keptImports.join(', ')} } ${restOfLine}`;
        lineModified = true;
        removed += (imports.length - keptImports.length);
      }
    }

    // Check for default imports: import Name from '...'
    const defaultMatch = line.match(/import\s+(\w+)\s+from/);
    if (defaultMatch && !importsMatch) {
      const importName = defaultMatch[1];
      if (unusedSet.has(importName)) {
        removed++;
        continue; // Skip this line
      }
    }

    modifiedLines.push(modifiedLine);
  }

  if (removed > 0) {
    fs.writeFileSync(filePath, modifiedLines.join('\n'), 'utf-8');
    filesModified++;
    importsRemoved += removed;
    console.log(`✓ ${relativeFilePath}: Removed ${removed} unused import(s)`);
  }
}

console.log(`\n✅ Summary:`);
console.log(`   Files modified: ${filesModified}`);
console.log(`   Imports removed: ${importsRemoved}`);
console.log(`\nRun 'npm run build' to verify errors are fixed.`);
