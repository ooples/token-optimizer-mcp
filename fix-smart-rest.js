const fs = require('fs');
const path = require('path');

// Read the problematic file
const filePath = path.join(__dirname, 'src/tools/api-database/smart-rest.ts');
let content = fs.readFileSync(filePath, 'utf8');

// Remove BOM if present
if (content.charCodeAt(0) === 0xFEFF) {
  content = content.substring(1);
}

// The file appears to be all on one line - let's format it properly
// Split by common patterns and reassemble with proper formatting

// Since this is too complex to parse, let's use Prettier or a simpler approach
// For now, let's add the missing import properly and ensure proper line breaks

const formatted = content
  // Fix the crypto import (currently empty)
  .replace(/import\s*\{\s*\}\s*from\s*"crypto"\s*;/, 'import { createHash } from "crypto";')
  // Add line breaks after semicolons and before certain keywords
  .replace(/;(?=\s*(?:import|export|interface|class|function|const|type|\/\/))/g, ';\n')
  // Add line breaks before comments
  .replace(/(\s+)(\/\/[^\n]*)/g, '\n$1$2')
  // Add line breaks after closing braces of interfaces/classes
  .replace(/\}(?=\s*(?:export|interface|class|function|const|type))/g, '}\n\n')
  // Clean up multiple consecutive newlines
  .replace(/\n{3,}/g, '\n\n');

// Write back with UTF-8 no BOM
fs.writeFileSync(filePath, formatted, { encoding: 'utf8' });

console.log('File formatting fixed!');
