#!/usr/bin/env node

/**
 * Package Validation Script
 *
 * Validates package structure before publishing to npm.
 * Checks for required files, package.json fields, and sensitive data.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

// ANSI color codes for terminal output
const colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
};

let errors = 0;
let warnings = 0;

function log(message, color = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

function error(message) {
  errors++;
  log(`✗ ERROR: ${message}`, 'red');
}

function warning(message) {
  warnings++;
  log(`⚠ WARNING: ${message}`, 'yellow');
}

function success(message) {
  log(`✓ ${message}`, 'green');
}

function info(message) {
  log(`ℹ ${message}`, 'cyan');
}

// Check if file exists
function fileExists(filePath) {
  return fs.existsSync(path.join(rootDir, filePath));
}

// Read and parse package.json
function getPackageJson() {
  try {
    const packagePath = path.join(rootDir, 'package.json');
    return JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  } catch (err) {
    error('Cannot read package.json: ' + err.message);
    process.exit(1);
  }
}

// Validate required files
function validateRequiredFiles() {
  info('\nValidating required files...');

  const requiredFiles = [
    { path: 'package.json', description: 'Package manifest' },
    { path: 'README.md', description: 'Documentation' },
    { path: 'LICENSE', description: 'License file' },
    { path: 'CHANGELOG.md', description: 'Changelog' },
    { path: 'dist/server/index.js', description: 'Main entry point' },
    { path: 'dist/server/index.d.ts', description: 'TypeScript declarations' },
  ];

  for (const file of requiredFiles) {
    if (fileExists(file.path)) {
      success(`${file.description}: ${file.path}`);
    } else {
      error(`Missing ${file.description}: ${file.path}`);
    }
  }
}

// Validate package.json fields
function validatePackageJson() {
  info('\nValidating package.json...');

  const pkg = getPackageJson();

  const requiredFields = [
    'name',
    'version',
    'description',
    'main',
    'types',
    'license',
    'author',
    'repository',
    'keywords',
    'engines',
  ];

  for (const field of requiredFields) {
    if (pkg[field]) {
      success(`Field '${field}' is set`);
    } else {
      error(`Missing required field '${field}'`);
    }
  }

  // Validate specific field values
  if (pkg.license !== 'MIT') {
    warning(`License is '${pkg.license}', expected 'MIT'`);
  }

  if (!pkg.keywords || pkg.keywords.length === 0) {
    error('No keywords defined (required for npm discoverability)');
  } else {
    success(`Keywords defined: ${pkg.keywords.length} keywords`);
  }

  if (!pkg.engines || !pkg.engines.node) {
    error('Node.js engine version not specified');
  } else {
    success(`Node.js version requirement: ${pkg.engines.node}`);
  }

  if (!pkg.publishConfig || pkg.publishConfig.access !== 'public') {
    warning('publishConfig.access should be "public" for public npm packages');
  }

  // Check files array
  if (!pkg.files || pkg.files.length === 0) {
    error('No files array defined (package may include unwanted files)');
  } else {
    success(`Files array defined with ${pkg.files.length} entries`);
  }

  // Check bin field for CLI packages
  if (!pkg.bin) {
    warning('No bin field defined (CLI entry point not configured)');
  } else {
    success('CLI entry point configured in bin field');
  }

  return pkg;
}

// Check for sensitive files
function checkSensitiveFiles() {
  info('\nChecking for sensitive files...');

  const sensitivePatterns = [
    /^\.env$/,
    /^\.env\./,
    /credentials\.json$/,
    /secrets\.json$/,
    /^\.npmrc$/,
    /\.key$/,
    /\.pem$/,
    /password/i,
    /secret(?!.*\.d\.ts)/i,  // Match 'secret' but not in TypeScript declaration files
  ];

  const distPath = path.join(rootDir, 'dist');
  if (!fs.existsSync(distPath)) {
    warning('dist/ directory does not exist. Run build first.');
    return;
  }

  let foundSensitive = false;

  function checkDir(dir) {
    const files = fs.readdirSync(dir);
    for (const file of files) {
      const fullPath = path.join(dir, file);
      const stat = fs.statSync(fullPath);

      if (stat.isDirectory()) {
        checkDir(fullPath);
      } else {
        for (const pattern of sensitivePatterns) {
          if (pattern.test(file)) {
            error(`Sensitive file found in dist/: ${path.relative(rootDir, fullPath)}`);
            foundSensitive = true;
          }
        }
      }
    }
  }

  checkDir(distPath);

  if (!foundSensitive) {
    success('No sensitive files found in dist/');
  }
}

// Validate TypeScript compilation
function validateBuild() {
  info('\nValidating build output...');

  if (!fileExists('dist')) {
    error('dist/ directory does not exist. Run `npm run build` first.');
    return;
  }

  if (!fileExists('dist/server/index.js')) {
    error('Main entry point dist/server/index.js not found');
    return;
  }

  // Check for shebang in CLI entry point
  const entryPoint = path.join(rootDir, 'dist/server/index.js');
  const content = fs.readFileSync(entryPoint, 'utf8');

  if (content.startsWith('#!/usr/bin/env node')) {
    success('CLI entry point has correct shebang');
  } else {
    error('CLI entry point missing shebang (#!/usr/bin/env node)');
  }

  // Check for TypeScript declarations
  if (fileExists('dist/server/index.d.ts')) {
    success('TypeScript declarations generated');
  } else {
    error('TypeScript declarations not found');
  }
}

// Calculate package size estimate
function estimatePackageSize() {
  info('\nEstimating package size...');

  const distPath = path.join(rootDir, 'dist');
  if (!fs.existsSync(distPath)) {
    warning('Cannot estimate size: dist/ does not exist');
    return;
  }

  let totalSize = 0;

  function calculateSize(dir) {
    const files = fs.readdirSync(dir);
    for (const file of files) {
      const fullPath = path.join(dir, file);
      const stat = fs.statSync(fullPath);

      if (stat.isDirectory()) {
        calculateSize(fullPath);
      } else {
        totalSize += stat.size;
      }
    }
  }

  calculateSize(distPath);

  // Add size of required files
  if (fileExists('README.md')) {
    totalSize += fs.statSync(path.join(rootDir, 'README.md')).size;
  }
  if (fileExists('LICENSE')) {
    totalSize += fs.statSync(path.join(rootDir, 'LICENSE')).size;
  }
  if (fileExists('CHANGELOG.md')) {
    totalSize += fs.statSync(path.join(rootDir, 'CHANGELOG.md')).size;
  }

  const sizeMB = (totalSize / (1024 * 1024)).toFixed(2);

  if (totalSize < 10 * 1024 * 1024) {
    success(`Estimated package size: ${sizeMB} MB (< 10 MB)`);
  } else {
    warning(`Package size is large: ${sizeMB} MB (> 10 MB)`);
  }
}

// Main validation
function main() {
  log('\n=== Package Validation ===\n', 'blue');

  validateRequiredFiles();
  validatePackageJson();
  validateBuild();
  checkSensitiveFiles();
  estimatePackageSize();

  log('\n=== Validation Summary ===\n', 'blue');

  if (errors > 0) {
    log(`${errors} error(s) found`, 'red');
  } else {
    log('No errors found', 'green');
  }

  if (warnings > 0) {
    log(`${warnings} warning(s) found`, 'yellow');
  } else {
    log('No warnings', 'green');
  }

  if (errors === 0) {
    log('\n✓ Package is ready for publishing!\n', 'green');
    process.exit(0);
  } else {
    log('\n✗ Fix errors before publishing\n', 'red');
    process.exit(1);
  }
}

main();
