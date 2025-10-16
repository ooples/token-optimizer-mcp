import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Read the problematic file
const filePath = path.join(__dirname, 'src/tools/api-database/smart-rest.ts');
let content = fs.readFileSync(filePath, 'utf8');

// Remove BOM if present
if (content.charCodeAt(0) === 0xFEFF) {
  content = content.substring(1);
}

// Fix the crypto import (currently incomplete in some versions)
content = content.replace(/import\s*\{\s*\}\s*from\s*"crypto"\s*;/, 'import { createHash } from "crypto";');

// The challenge is the file is all on one line. We need to add line breaks intelligently.
// Strategy: Look for patterns that should have newlines before/after them

let formatted = content;

// Add newlines after semicolons followed by keywords
formatted = formatted.replace(/;\s*(?=import\s)/g, ';\n');
formatted = formatted.replace(/;\s*(?=export\s)/g, ';\n');
formatted = formatted.replace(/;\s*(?=interface\s)/g, ';\n');
formatted = formatted.replace(/;\s*(?=class\s)/g, ';\n\n');
formatted = formatted.replace(/;\s*(?=function\s)/g, ';\n\n');
formatted = formatted.replace(/;\s*(?=const\s)/g, ';\n');
formatted = formatted.replace(/;\s*(?=type\s)/g, ';\n');

// Add newlines before and after comment blocks
formatted = formatted.replace(/(\s+)(\/\*\*[^*]*\*+(?:[^/*][^*]*\*+)*\/)/g, '\n\n$2\n');
formatted = formatted.replace(/(\s+)(\/\/[^\n;]+)/g, '\n$2\n');

// Add newlines after closing braces of type definitions
formatted = formatted.replace(/\}(\s*)(?=(export\s+(interface|class|function|const)))/g, '}\n\n');

// Clean up excessive newlines
formatted = formatted.replace(/\n{4,}/g, '\n\n');

// Write back with UTF-8 no BOM
fs.writeFileSync(filePath, formatted, { encoding: 'utf8' });

console.log('File reformatted successfully!');
console.log('First 500 characters:');
console.log(formatted.substring(0, 500));
