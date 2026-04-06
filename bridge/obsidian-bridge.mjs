#!/usr/bin/env node

/**
 * Obsidian MCP Bridge — stdio-to-SSE adapter
 *
 * Bridges Claude Code's stdio MCP client to the Obsidian plugin's HTTP/SSE server.
 *
 * Usage:
 *   node obsidian-bridge.mjs [--port 22360]
 *
 * Environment variables:
 *   OBSIDIAN_MCP_PORT  — HTTP port of the Obsidian MCP server (default: 22360)
 *
 * Register in Claude Code:
 *   claude mcp add obsidian -- node "/path/to/obsidian-bridge.mjs"
 */

import http from "node:http";
import { createInterface } from "node:readline";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const DEFAULT_PORT = 22360;
const RECONNECT_DELAY_MS = 2000;
const MAX_RECONNECT_ATTEMPTS = 10;
const HOST = "127.0.0.1";

function getPort() {
  // CLI arg: --port 12345
  const idx = process.argv.indexOf("--port");
  if (idx !== -1 && process.argv[idx + 1]) {
    return Number(process.argv[idx + 1]);
  }
  // Environment variable
  if (process.env.OBSIDIAN_MCP_PORT) {
    return Number(process.env.OBSIDIAN_MCP_PORT);
  }
  return DEFAULT_PORT;
}

const PORT = getPort();

// ---------------------------------------------------------------------------
// Logging (all goes to stderr so stdout stays clean for JSON-RPC)
// ---------------------------------------------------------------------------

function log(...args) {
  process.stderr.write(`[obsidian-bridge] ${args.join(" ")}\n`);
}

// ---------------------------------------------------------------------------
// SSE Client — connects to GET /sse, extracts session_id, forwards messages
// ---------------------------------------------------------------------------

let sessionId = null;
let sseRequest = null;
let reconnectAttempts = 0;
let pendingRequests = new Map(); // id -> true (track which requests we're waiting on)

function connectSSE() {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: HOST,
      port: PORT,
      path: "/sse",
      method: "GET",
      headers: {
        Accept: "text/event-stream",
        "Cache-Control": "no-cache",
      },
    };

    sseRequest = http.request(options, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`SSE connection failed: HTTP ${res.statusCode}`));
        return;
      }

      log(`SSE connected to port ${PORT}`);
      reconnectAttempts = 0;

      let buffer = "";
      let currentEvent = null;
      let currentData = null;

      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        buffer += chunk;

        // Parse SSE line by line
        const lines = buffer.split("\n");
        // Keep the last incomplete line in the buffer
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (line.startsWith("event: ")) {
            currentEvent = line.slice(7).trim();
          } else if (line.startsWith("data: ")) {
            currentData = line.slice(6);
          } else if (line === "" && currentEvent !== null) {
            // Empty line = end of SSE message
            handleSSEEvent(currentEvent, currentData, resolve);
            currentEvent = null;
            currentData = null;
          }
        }
      });

      res.on("end", () => {
        log("SSE connection closed by server");
        sessionId = null;
        scheduleReconnect();
      });

      res.on("error", (err) => {
        log("SSE stream error:", err.message);
        sessionId = null;
        scheduleReconnect();
      });
    });

    sseRequest.on("error", (err) => {
      reject(new Error(`Cannot connect to Obsidian MCP at ${HOST}:${PORT} — ${err.message}`));
    });

    sseRequest.end();
  });
}

function handleSSEEvent(event, data, onReady) {
  switch (event) {
    case "endpoint":
      // data is like: /messages?session_id=<uuid>
      if (data) {
        const match = data.match(/session_id=([a-f0-9-]+)/);
        if (match) {
          sessionId = match[1];
          log(`Session established: ${sessionId}`);
          onReady();
        }
      }
      break;

    case "message":
      // data is a JSON-RPC response from Obsidian
      if (data) {
        try {
          const msg = JSON.parse(data);
          // Write to stdout for Claude Code to read
          writeStdout(msg);
        } catch (e) {
          log("Failed to parse SSE message:", e.message);
        }
      }
      break;

    case "ping":
      // Keep-alive, ignore
      break;

    default:
      // Unknown event type, ignore
      break;
  }
}

function scheduleReconnect() {
  if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    log(`Max reconnect attempts (${MAX_RECONNECT_ATTEMPTS}) reached, exiting`);
    process.exit(1);
  }
  reconnectAttempts++;
  log(`Reconnecting in ${RECONNECT_DELAY_MS}ms (attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})...`);
  setTimeout(() => {
    connectSSE().catch((err) => {
      log("Reconnect failed:", err.message);
      scheduleReconnect();
    });
  }, RECONNECT_DELAY_MS);
}

// ---------------------------------------------------------------------------
// HTTP POST — forward stdin JSON-RPC requests to POST /messages
// ---------------------------------------------------------------------------

function postMessage(jsonRpcMessage) {
  return new Promise((resolve, reject) => {
    if (!sessionId) {
      reject(new Error("No active SSE session"));
      return;
    }

    const body = JSON.stringify(jsonRpcMessage);

    const options = {
      hostname: HOST,
      port: PORT,
      path: `/messages?session_id=${sessionId}`,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
    };

    const req = http.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        if (res.statusCode === 202 || res.statusCode === 200) {
          resolve();
        } else {
          reject(new Error(`POST /messages returned ${res.statusCode}: ${data}`));
        }
      });
    });

    req.on("error", (err) => {
      reject(err);
    });

    req.write(body);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// stdio — read JSON-RPC from stdin, write JSON-RPC to stdout
// ---------------------------------------------------------------------------

function writeStdout(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function startStdinReader() {
  const rl = createInterface({
    input: process.stdin,
    terminal: false,
  });

  rl.on("line", async (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch (e) {
      log("Invalid JSON from stdin:", e.message);
      return;
    }

    // Forward to Obsidian via HTTP POST
    try {
      await postMessage(msg);
    } catch (err) {
      log("Failed to forward message:", err.message);
      // If this was a request (has id), send error back to Claude Code
      if (msg.id !== undefined) {
        writeStdout({
          jsonrpc: "2.0",
          id: msg.id,
          error: {
            code: -32603,
            message: `Bridge error: ${err.message}`,
          },
        });
      }
    }
  });

  rl.on("close", () => {
    log("stdin closed, shutting down");
    cleanup();
    process.exit(0);
  });
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

function cleanup() {
  if (sseRequest) {
    sseRequest.destroy();
    sseRequest = null;
  }
}

process.on("SIGINT", () => {
  cleanup();
  process.exit(0);
});

process.on("SIGTERM", () => {
  cleanup();
  process.exit(0);
});

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  log(`Starting bridge to Obsidian MCP at ${HOST}:${PORT}`);

  try {
    await connectSSE();
    log("Bridge ready — forwarding stdio <-> SSE");
    startStdinReader();
  } catch (err) {
    log(`Failed to connect: ${err.message}`);
    log("Make sure Obsidian is running with the MCP plugin enabled.");
    process.exit(1);
  }
}

main();
