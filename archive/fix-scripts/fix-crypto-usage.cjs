#!/usr/bin/env node
/**
 * Fix crypto.createHash() to use imported createHash() directly
 */

const fs = require('fs');
const path = require('path');
const { glob } = require('glob');

async function fixCryptoUsage() {
  const files = await glob('src/tools/**/*.ts', { cwd: process.cwd() });

  let totalFixed = 0;
  let filesModified = 0;

  for (const file of files) {
    const fullPath = path.join(process.cwd(), file);
    let content = fs.readFileSync(fullPath, 'utf-8');
    const original = content;

    // Replace crypto.createHash with createHash (when createHash is imported)
    if (content.includes("import { createHash } from 'crypto'") ||
        content.includes('import { createHash } from "crypto"')) {
      const matches = content.match(/crypto\.createHash/g);
      if (matches) {
        content = content.replace(/crypto\.createHash/g, 'createHash');
        const count = matches.length;
        console.log(`✓ ${file}: Fixed ${count} crypto.createHash calls`);
        totalFixed += count;
        filesModified++;
      }
    }

    if (content !== original) {
      fs.writeFileSync(fullPath, content, 'utf-8');
    }
  }

  console.log(`\n✓ Total: Fixed ${totalFixed} crypto.createHash() calls in ${filesModified} files`);
}

fixCryptoUsage().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
