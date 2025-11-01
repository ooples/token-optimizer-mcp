#!/usr/bin/env node
/**
 * Token Optimizer MCP Daemon
 *
 * Long-running process that manages a persistent MCP server subprocess
 * and exposes it via named pipes (Windows) or Unix domain sockets (Linux/macOS)
 * for PowerShell hooks to communicate with.
 *
 * Performance: ~2-5ms per request (IPC overhead) vs ~1000-4000ms (npx spawn overhead)
 * Eliminates 285x slowdown caused by process spawning.
 *
 * Architecture:
 * - Daemon starts the MCP server (index.ts) as a child process via stdio
 * - Daemon listens on IPC socket (named pipe on Windows, Unix socket on Linux/macOS)
 * - PowerShell hooks connect via IPC and send JSON-RPC requests
 * - Daemon forwards requests to MCP server via stdin
 * - Daemon receives responses from MCP server via stdout
 * - Daemon returns responses to PowerShell hooks via IPC
 */

import net from 'net';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { spawn, ChildProcess } from 'child_process';
import { fileURLToPath } from 'url';

const DAEMON_VERSION = '1.0.0';
const PLATFORM = os.platform();

// Get the directory of the current module
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Platform-specific socket paths
const SOCKET_PATH =
  PLATFORM === 'win32'
    ? '\\\\.\\pipe\\token-optimizer-daemon' // Windows named pipe
    : path.join(os.tmpdir(), 'token-optimizer-daemon.sock'); // Unix socket

// PID file for process management
const PID_FILE = path.join(
  process.env.USERPROFILE || process.env.HOME || os.homedir(),
  '.token-optimizer-daemon.pid'
);

interface DaemonStats {
  startTime: Date;
  requestCount: number;
  errorCount: number;
  avgResponseTime: number;
  mcpRestarts: number;
}

interface PendingRequest {
  id: string | number;
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timestamp: number;
}

const stats: DaemonStats = {
  startTime: new Date(),
  requestCount: 0,
  errorCount: 0,
  avgResponseTime: 0,
  mcpRestarts: 0,
};

// MCP server subprocess
let mcpProcess: ChildProcess | null = null;
const pendingRequests = new Map<string | number, PendingRequest>();
let requestIdCounter = 0;

/**
 * Start the MCP server as a child process
 */
function startMCPServer(): void {
  console.error('[DAEMON] Starting MCP server subprocess...');

  // Path to the MCP server index.js (built version)
  const serverPath = path.join(__dirname, 'index.js');

  if (!fs.existsSync(serverPath)) {
    console.error(`[DAEMON] ERROR: MCP server not found at ${serverPath}`);
    console.error('[DAEMON] Run "npm run build" first to compile TypeScript');
    process.exit(1);
  }

  mcpProcess = spawn('node', [serverPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: process.env,
  });

  console.error(`[DAEMON] MCP server started (PID: ${mcpProcess.pid})`);

  // Handle stdout (responses from MCP server)
  let stdoutBuffer = '';
  mcpProcess.stdout?.on('data', (chunk) => {
    stdoutBuffer += chunk.toString();

    // Process complete JSON-RPC messages (newline-delimited)
    const lines = stdoutBuffer.split('\n');
    stdoutBuffer = lines.pop() || '';

    for (const line of lines) {
      if (line.trim()) {
        try {
          const response = JSON.parse(line);
          handleMCPResponse(response);
        } catch (error) {
          console.error('[DAEMON] Failed to parse MCP response:', error);
          console.error('[DAEMON] Invalid JSON:', line);
        }
      }
    }
  });

  // Handle stderr (logs from MCP server)
  mcpProcess.stderr?.on('data', (chunk) => {
    console.error('[DAEMON] MCP stderr:', chunk.toString().trim());
  });

  // Handle process exit
  mcpProcess.on('exit', (code, signal) => {
    console.error(
      `[DAEMON] MCP server exited (code: ${code}, signal: ${signal})`
    );

    // Reject all pending requests
    for (const [id, request] of pendingRequests.entries()) {
      request.reject(new Error('MCP server crashed'));
      pendingRequests.delete(id);
    }

    // Auto-restart if not intentional shutdown
    if (code !== 0 && !shuttingDown) {
      console.error('[DAEMON] Restarting MCP server in 1 second...');
      stats.mcpRestarts++;
      setTimeout(() => startMCPServer(), 1000);
    }
  });

  mcpProcess.on('error', (error) => {
    console.error('[DAEMON] MCP server error:', error);
  });
}

/**
 * Handle response from MCP server
 */
function handleMCPResponse(response: any): void {
  const id = response.id;

  if (!id) {
    console.error('[DAEMON] Received response without ID:', response);
    return;
  }

  const pending = pendingRequests.get(id);
  if (!pending) {
    console.error(`[DAEMON] No pending request for ID: ${id}`);
    return;
  }

  // Calculate response time
  const duration = Date.now() - pending.timestamp;
  stats.avgResponseTime =
    (stats.avgResponseTime * stats.requestCount + duration) /
    (stats.requestCount + 1);
  stats.requestCount++;

  console.error(`[DAEMON] Request ${id} completed in ${duration}ms`);

  // Resolve the pending request
  pending.resolve(response);
  pendingRequests.delete(id);
}

/**
 * Send request to MCP server and wait for response
 */
async function sendToMCPServer(request: any): Promise<any> {
  if (!mcpProcess || !mcpProcess.stdin) {
    throw new Error('MCP server not running');
  }

  // Generate unique request ID
  const id =
    request.id === undefined || request.id === null
      ? `daemon-${requestIdCounter++}`
      : request.id;
  request.id = id;

  console.error(`[DAEMON] Sending request ${id}: ${request.method}`);

  // Create promise for response
  const promise = new Promise((resolve, reject) => {
    pendingRequests.set(id, {
      id,
      resolve,
      reject,
      timestamp: Date.now(),
    });

    // Timeout after 30 seconds
    setTimeout(() => {
      if (pendingRequests.has(id)) {
        pendingRequests.delete(id);
        reject(new Error(`Request ${id} timed out after 30 seconds`));
      }
    }, 30000);
  });

  // Send request to MCP server
  mcpProcess.stdin.write(JSON.stringify(request) + '\n');

  return promise;
}

/**
 * Handle incoming request from PowerShell hook via IPC
 */
async function handleIPCRequest(data: string): Promise<string> {
  const startTime = Date.now();

  let request: any;
  try {
    request = JSON.parse(data);

    console.error(`[DAEMON] IPC request: ${request.method}`);

    // Validate JSON-RPC 2.0 format
    if (request.jsonrpc !== '2.0' || !request.method) {
      return JSON.stringify({
        jsonrpc: '2.0',
        id: request.id || null,
        error: {
          code: -32600,
          message: 'Invalid Request: must be JSON-RPC 2.0 with method field',
        },
      });
    }

    // Handle daemon-specific methods
    if (request.method === 'daemon/stats') {
      const uptime = Date.now() - stats.startTime.getTime();
      return JSON.stringify({
        jsonrpc: '2.0',
        id: request.id,
        result: {
          version: DAEMON_VERSION,
          platform: PLATFORM,
          uptime,
          uptimeHuman: `${Math.floor(uptime / 1000)}s`,
          mcpServerPid: mcpProcess?.pid || null,
          ...stats,
        },
      });
    }

    if (request.method === 'daemon/shutdown') {
      console.error('[DAEMON] Shutdown requested via IPC');

      // Graceful shutdown
      shutdown();

      return JSON.stringify({
        jsonrpc: '2.0',
        id: request.id,
        result: { success: true, message: 'Daemon shutting down' },
      });
    }

    // Forward to MCP server
    const response = await sendToMCPServer(request);

    const duration = Date.now() - startTime;
    console.error(`[DAEMON] IPC request completed in ${duration}ms`);

    return JSON.stringify(response);
  } catch (error) {
    stats.errorCount++;
    console.error('[DAEMON] Error handling IPC request:', error);

    return JSON.stringify({
      jsonrpc: '2.0',
      id: request?.id ?? null,
      error: {
        code: -32603,
        message: error instanceof Error ? error.message : 'Internal error',
      },
    });
  }
}

let shuttingDown = false;

/**
 * Graceful shutdown
 */
function shutdown(): void {
  if (shuttingDown) return;
  shuttingDown = true;

  console.error('[DAEMON] Shutting down gracefully...');

  // Kill MCP server
  if (mcpProcess) {
    mcpProcess.kill('SIGTERM');
    mcpProcess = null;
  }

  // Remove PID file
  if (fs.existsSync(PID_FILE)) {
    fs.unlinkSync(PID_FILE);
  }

  // Remove Unix socket
  if (PLATFORM !== 'win32' && fs.existsSync(SOCKET_PATH)) {
    fs.unlinkSync(SOCKET_PATH);
  }

  console.error('[DAEMON] Shutdown complete');
  process.exit(0);
}

/**
 * Start the daemon server
 */
function startDaemon(): void {
  console.error('[DAEMON] Token Optimizer MCP Daemon starting...');
  console.error(`[DAEMON] Version: ${DAEMON_VERSION}`);
  console.error(`[DAEMON] Platform: ${PLATFORM}`);
  console.error(`[DAEMON] Socket: ${SOCKET_PATH}`);

  // Start MCP server subprocess
  startMCPServer();

  // Remove stale socket file on Unix
  if (PLATFORM !== 'win32' && fs.existsSync(SOCKET_PATH)) {
    fs.unlinkSync(SOCKET_PATH);
  }

  // Create IPC server
  const server = net.createServer((socket) => {
    console.error('[DAEMON] Client connected');

    let buffer = '';

    socket.on('data', async (chunk) => {
      buffer += chunk.toString();

      // Process complete messages (newline-delimited)
      const messages = buffer.split('\n');
      buffer = messages.pop() || '';

      for (const message of messages) {
        if (message.trim()) {
          const response = await handleIPCRequest(message);
          socket.write(response + '\n');
        }
      }
    });

    socket.on('error', (err) => {
      console.error('[DAEMON] Socket error:', err);
    });

    socket.on('end', () => {
      console.error('[DAEMON] Client disconnected');
    });
  });

  server.listen(SOCKET_PATH, () => {
    console.error(`[DAEMON] Listening on ${SOCKET_PATH}`);
    console.error(`[DAEMON] PID: ${process.pid}`);

    // Write PID file for process management
    fs.writeFileSync(PID_FILE, process.pid.toString());

    console.error('[DAEMON] Daemon ready');
  });

  server.on('error', (err) => {
    console.error('[DAEMON] Server error:', err);
    shutdown();
  });

  // Cleanup on exit
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('exit', () => {
    if (mcpProcess) mcpProcess.kill();
  });
}

// Start daemon
startDaemon();
