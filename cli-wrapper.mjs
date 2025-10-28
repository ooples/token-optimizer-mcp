#!/usr/bin/env node

/**
 * CLI Wrapper for token-optimizer-mcp
 *
 * This wrapper allows one-shot CLI execution without modifying the main server code.
 *
 * Usage:
 *   node cli-wrapper.mjs <tool-name> [arguments-json | --stdin | --file <path>]
 *
 * Example:
 *   node cli-wrapper.mjs optimize_text '{"text":"Hello World","key":"test","quality":11}'
 *   echo '{"text":"Hello World"}' | node cli-wrapper.mjs count_tokens --stdin
 *   node cli-wrapper.mjs optimize_text --file ./args.json
 */

import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Get CLI arguments
const args = process.argv.slice(2);

let toolName;
let argsJson;
let jsonSource = 'argument'; // 'argument', 'stdin', or 'file'
let jsonFilePath;

// Parse arguments for toolName and JSON source
if (args.length < 1) {
  console.error(JSON.stringify({
    success: false,
    error: 'Usage: node cli-wrapper.mjs <tool-name> [arguments-json | --stdin | --file <path>]',
    exitCode: 2
  }));
  process.exit(2);
}

toolName = args[0];

if (args[1] === '--stdin') {
  jsonSource = 'stdin';
} else if (args[1] === '--file' && args[2]) {
  jsonSource = 'file';
  jsonFilePath = args[2];
} else if (args[1]) {
  argsJson = args[1];
} else {
  console.error(JSON.stringify({
    success: false,
    error: 'Missing JSON arguments or source (--stdin, --file <path>)',
    exitCode: 2
  }));
  process.exit(2);
}

let toolArgsPromise;

if (jsonSource === 'stdin') {
  toolArgsPromise = new Promise((resolve, reject) => {
    let data = '';
    process.stdin.on('data', chunk => {
      data += chunk;
    });
    process.stdin.on('end', () => {
      try {
        resolve(JSON.parse(data));
      } catch (e) {
        reject(new Error(`Invalid JSON from stdin: ${e.message}`));
      }
    });
    process.stdin.on('error', err => reject(new Error(`Stdin error: ${err.message}`)));
  });
} else if (jsonSource === 'file') {
  toolArgsPromise = new Promise((resolve, reject) => {
    fs.readFile(jsonFilePath, 'utf8', (err, data) => {
      if (err) {
        return reject(new Error(`Failed to read JSON file ${jsonFilePath}: ${err.message}`));
      }
      try {
        resolve(JSON.parse(data));
      } catch (e) {
        reject(new Error(`Invalid JSON in file ${jsonFilePath}: ${e.message}`));
      }
    });
  });
} else { // jsonSource === 'argument'
  toolArgsPromise = Promise.resolve().then(() => {
    try {
      return JSON.parse(argsJson);
    } catch (e) {
      throw new Error(`Invalid JSON arguments: ${e.message}`);
    }
  });
}

toolArgsPromise.then(toolArgs => {
  // Build MCP JSON-RPC request
  const cleanToolName = toolName.replace(/^mcp__token-optimizer__/, '');
  const request = {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: {
      name: cleanToolName,
      arguments: toolArgs
    }
  };

  const requestJson = JSON.stringify(request);

  // Start the MCP server
  const serverPath = join(__dirname, 'dist', 'server', 'index.js');
  const child = spawn('node', [serverPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      TOKEN_OPTIMIZER_CACHE_DIR: process.env.TOKEN_OPTIMIZER_CACHE_DIR || join(process.env.HOME || process.env.USERPROFILE, '.token-optimizer-cache')
    }
  });

  let stdout = '';
  let stderr = '';
  let responseReceived = false;

  child.stdout.on('data', (data) => {
    const lines = data.toString().split('\n');

    for (const line of lines) {
      if (line.trim() === '') continue;

      try {
        const response = JSON.parse(line);

        if (response.id === 1 && response.result) {
          responseReceived = true;
          console.log(JSON.stringify(response.result, null, 0));
          child.kill();
          process.exit(0);
        } else if (response.error) {
          responseReceived = true;
          console.error(JSON.stringify({
            success: false,
            error: response.error.message || 'MCP server error',
            details: response.error,
            exitCode: 1
          }));
          child.kill();
          process.exit(1);
        }
      } catch (e) {
        stdout += line + '\n';
      }
    }
  });

  child.stderr.on('data', (data) => {
    stderr += data.toString();
  });

  child.on('error', (error) => {
    console.error(JSON.stringify({
      success: false,
      error: 'Failed to start MCP server',
      details: error.message,
      exitCode: 1
    }));
    process.exit(1);
  });

  child.on('close', (code) => {
    if (!responseReceived) {
      console.error(JSON.stringify({
        success: false,
        error: 'MCP server closed without sending response',
        stdout,
        stderr,
        exitCode: code || 1
      }));
      process.exit(code || 1);
    }
  });

  setTimeout(() => {
    child.stdin.write(requestJson + '\n');
  }, 100);

  setTimeout(() => {
    if (!responseReceived) {
      console.error(JSON.stringify({
        success: false,
        error: 'Request timeout after 30 seconds',
        exitCode: 1
      }));
      child.kill();
      process.exit(1);
    }
  }, 30000);
}).catch(error => {
  console.error(JSON.stringify({
    success: false,
    error: error.message,
    exitCode: 2
  }));
  process.exit(2);
});
