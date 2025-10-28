const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

console.log('Getting list of syntax errors from build...');

let buildOutput;
try {
  buildOutput = execSync('npm run build 2>&1', {
    cwd: __dirname,
    encoding: 'utf-8',
    maxBuffer: 10 * 1024 * 1024
  });
} catch (error) {
  buildOutput = error.stdout || error.output.join('');
}

const lines = buildOutput.split('\n');
const errorFiles = new Set();

lines.forEach(line => {
  const cleanLine = line.replace(/\r/g, '');
  const syntaxMatch = cleanLine.match(/^(.+\.ts)\(\d+,\d+\): error TS1(005|109|134|128):/);
  if (syntaxMatch) {
    errorFiles.add(syntaxMatch[1]);
  }
});

console.log(`Found ${errorFiles.size} files with syntax errors`);

let filesModified = 0;

for (const relativeFilePath of errorFiles) {
  const filePath = path.join(__dirname, relativeFilePath);

  if (!fs.existsSync(filePath)) {
    console.log(`Skipping ${relativeFilePath} - file not found`);
    continue;
  }

  let content = fs.readFileSync(filePath, 'utf-8');
  const originalContent = content;

  // Fix: JSON.stringify(data), "utf-8"), -> JSON.stringify(data),
  content = content.replace(/JSON\.stringify\(([^)]+)\),\s*"utf-8"\),/g, 'JSON.stringify($1),');

  // Fix: variable), "utf-8"), -> variable,
  content = content.replace(/([a-zA-Z_$][a-zA-Z0-9_$]*)\),\s*"utf-8"\),/g, '$1,');

  // Fix: JSON.stringify(data)), -> JSON.stringify(data),
  content = content.replace(/JSON\.stringify\(([^)]+)\)\),/g, 'JSON.stringify($1),');

  // Fix: variable)), -> variable,
  content = content.replace(/([a-zA-Z_$][a-zA-Z0-9_$]*)\)\),/g, '$1,');

  // Fix: JSON.stringify(data), 'utf-8'); -> JSON.stringify(data);
  content = content.replace(/JSON\.stringify\(([^)]+)\),\s*['"]utf-8['"]?\);/g, 'JSON.stringify($1);');

  // Fix: variable), 'utf-8'); -> variable;
  content = content.replace(/([a-zA-Z_$][a-zA-Z0-9_$]*)\),\s*['"]utf-8['"]?\);/g, '$1);');

  // Fix: JSON.stringify(data)); -> JSON.stringify(data);
  content = content.replace(/JSON\.stringify\(([^)]+)\)\);/g, 'JSON.stringify($1);');

  // Fix: variable)); -> variable;
  content = content.replace(/\b([a-zA-Z_$][a-zA-Z0-9_$]*)\)\);/g, '$1);');

  if (content !== originalContent) {
    fs.writeFileSync(filePath, content, 'utf-8');
    filesModified++;
    console.log(`✓ ${relativeFilePath}: Fixed syntax errors`);
  }
}

console.log(`\n✅ Summary:`);
console.log(`   Files modified: ${filesModified}`);
console.log(`\nRun 'npm run build' to verify all syntax errors are fixed.`);
