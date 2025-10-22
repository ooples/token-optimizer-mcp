#!/usr/bin/env node

/**
 * Test script to verify granular MCP server tracking logic
 * This directly tests the parsing logic against the JSONL log
 */

const fs = require('fs');
const path = require('path');

// Find the most recent session log
const dataDir = path.join(process.env.USERPROFILE, '.claude-global', 'hooks', 'data');
const files = fs.readdirSync(dataDir).filter(f => f.startsWith('session-log-') && f.endsWith('.jsonl'));
const latestLog = files.sort().reverse()[0];
const logPath = path.join(dataDir, latestLog);

console.log(`Testing with log: ${latestLog}\n`);

// Read and parse the JSONL log
const content = fs.readFileSync(logPath, 'utf-8');
const lines = content.trim().split('\n');

// Initialize tracking structures (matching the MCP server code)
const tokensByServer = {};
let totalTools = 0;
let mcpToolCallEvents = 0;
let mcpToolResultEvents = 0;

// Parse each event
for (const line of lines) {
  if (!line.trim()) continue;

  try {
    const event = JSON.parse(line);

    // Process tool calls (PreToolUse phase)
    if (event.type === 'tool_call') {
      totalTools++;
      const tokens = event.estimated_tokens || 0;

      // Track by MCP server with tool-level granularity
      if (event.toolName.startsWith('mcp__')) {
        mcpToolCallEvents++;
        const parts = event.toolName.split('__');
        const serverName = parts[1] || 'unknown';
        const toolName = parts.slice(2).join('__') || 'unknown';

        console.log(`[tool_call] Found MCP tool: ${event.toolName}`);
        console.log(`  -> server=${serverName}, tool=${toolName}, tokens=${tokens}`);

        // Initialize server if not exists
        if (!tokensByServer[serverName]) {
          tokensByServer[serverName] = { total: 0, tools: {} };
          console.log(`  -> Initialized server: ${serverName}`);
        }

        // Initialize tool within server if not exists
        if (!tokensByServer[serverName].tools[toolName]) {
          tokensByServer[serverName].tools[toolName] = { count: 0, tokens: 0 };
          console.log(`  -> Initialized tool: ${serverName}.${toolName}`);
        }

        // Aggregate tokens at both server and tool level
        tokensByServer[serverName].total += tokens;
        tokensByServer[serverName].tools[toolName].count++;
        tokensByServer[serverName].tools[toolName].tokens += tokens;
        console.log(`  -> Updated: ${serverName}.${toolName} count=${tokensByServer[serverName].tools[toolName].count} tokens=${tokensByServer[serverName].tools[toolName].tokens}\n`);
      }
    }

    // Process tool results (PostToolUse phase)
    if (event.type === 'tool_result') {
      const tokens = event.actualTokens || 0;

      // Also aggregate MCP server attribution from tool_result events
      if (event.toolName.startsWith('mcp__')) {
        mcpToolResultEvents++;
        const parts = event.toolName.split('__');
        const serverName = parts[1] || 'unknown';
        const toolName = parts.slice(2).join('__') || 'unknown';

        console.log(`[tool_result] Found MCP tool: ${event.toolName}`);
        console.log(`  -> server=${serverName}, tool=${toolName}, tokens=${tokens}`);

        // Initialize server if not exists
        if (!tokensByServer[serverName]) {
          tokensByServer[serverName] = { total: 0, tools: {} };
          console.log(`  -> Initialized server: ${serverName}`);
        }

        // Initialize tool within server if not exists
        if (!tokensByServer[serverName].tools[toolName]) {
          tokensByServer[serverName].tools[toolName] = { count: 0, tokens: 0 };
          console.log(`  -> Initialized tool: ${serverName}.${toolName}`);
        }

        // Aggregate tokens at both server and tool level
        tokensByServer[serverName].total += tokens;
        tokensByServer[serverName].tools[toolName].tokens += tokens;
        console.log(`  -> Updated: ${serverName}.${toolName} count=${tokensByServer[serverName].tools[toolName].count} tokens=${tokensByServer[serverName].tools[toolName].tokens}\n`);
      }
    }
  } catch (err) {
    console.error(`Error parsing line: ${err.message}`);
  }
}

// Print final results
console.log('\n=== FINAL RESULTS ===\n');
console.log(`Total tools in log: ${totalTools}`);
console.log(`MCP tool_call events: ${mcpToolCallEvents}`);
console.log(`MCP tool_result events: ${mcpToolResultEvents}`);
console.log(`\ntokensByServer keys: ${Object.keys(tokensByServer).join(', ') || 'EMPTY'}`);
console.log('\ntokensByServer content:');
console.log(JSON.stringify(tokensByServer, null, 2));

// Verify expectations
console.log('\n=== VERIFICATION ===\n');
if (Object.keys(tokensByServer).length === 0) {
  console.log('❌ FAIL: tokensByServer is empty!');
  console.log('This means no MCP tools were found in either tool_call or tool_result events.');
} else {
  console.log('✅ PASS: tokensByServer is populated!');

  // Check for tool-level granularity
  let hasGranularity = false;
  for (const [serverName, serverData] of Object.entries(tokensByServer)) {
    if (Object.keys(serverData.tools).length > 0) {
      hasGranularity = true;
      console.log(`✅ Server "${serverName}" has ${Object.keys(serverData.tools).length} tools tracked`);
    }
  }

  if (hasGranularity) {
    console.log('✅ PASS: Tool-level granularity is working!');
  } else {
    console.log('❌ FAIL: No tool-level granularity found!');
  }
}
