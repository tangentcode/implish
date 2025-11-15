#!/usr/bin/env node
/**
 * MCP Server for Implish
 * Allows Claude Code to evaluate implish code directly via MCP protocol
 *
 * Setup (dev-only):
 * 1. npm install && npm run build
 * 2. Add to Claude Code MCP settings:
 *    {
 *      "mcpServers": {
 *        "implish": {
 *          "command": "node",
 *          "args": ["C:\\ver\\implish\\dist\\imp-mcp.mjs"]
 *        }
 *      }
 *    }
 *   To do this from the command line, run:
 *
 *    claude mcp add implish -- node `realpath ./dist/imp-mcp.mjs`
 *
 * 3. Restart Claude Code
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { spawn, type ChildProcess } from 'child_process';
import { watch } from 'fs';

// Get the directory of the current module
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface WorkerRequest {
  operation: 'eval' | 'load' | 'list_words' | 'inspect_word' | 'reload';
  code?: string;
  word?: string;
}

interface WorkerResponse {
  success: boolean;
  result?: string;
  error?: string;
}

// Global worker process
let workerProcess: ChildProcess | null = null;
let workerReady = false;
let pendingRequests = new Map<number, { resolve: (value: WorkerResponse) => void, reject: (reason: any) => void }>();
let requestIdCounter = 0;

// Start a long-running worker process
function startWorker(): void {
  if (workerProcess) {
    workerProcess.kill();
  }

  const workerPath = join(__dirname, 'imp-mcp-worker.mjs');
  workerProcess = spawn('node', [workerPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  workerReady = false;
  let outputBuffer = '';

  workerProcess.stdout?.on('data', (data) => {
    outputBuffer += data.toString();

    // Process complete JSON responses
    const lines = outputBuffer.split('\n');
    outputBuffer = lines.pop() || ''; // Keep incomplete line in buffer

    for (const line of lines) {
      if (!line.trim()) continue;

      try {
        const response = JSON.parse(line);

        // Check if this is a ready signal
        if (response.ready) {
          workerReady = true;
          console.error('Worker ready');
          continue;
        }

        // Handle request responses
        const requestId = response.id;
        if (requestId !== undefined && pendingRequests.has(requestId)) {
          const { resolve } = pendingRequests.get(requestId)!;
          pendingRequests.delete(requestId);
          resolve(response);
        }
      } catch (error) {
        console.error('Failed to parse worker output:', line, error);
      }
    }
  });

  workerProcess.stderr?.on('data', (data) => {
    console.error('Worker stderr:', data.toString());
  });

  workerProcess.on('error', (error) => {
    console.error('Worker error:', error);
    workerReady = false;
  });

  workerProcess.on('exit', (code) => {
    console.error(`Worker exited with code ${code}`);
    workerReady = false;
    workerProcess = null;

    // Reject all pending requests
    for (const [id, { reject }] of pendingRequests.entries()) {
      reject(new Error('Worker process exited'));
    }
    pendingRequests.clear();
  });
}

// Send request to worker and wait for response
async function sendToWorker(request: WorkerRequest, timeoutMs: number = 5000): Promise<WorkerResponse> {
  if (!workerProcess || !workerReady) {
    startWorker();

    // Wait for worker to be ready
    const maxWait = 10000;
    const start = Date.now();
    while (!workerReady && (Date.now() - start) < maxWait) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    if (!workerReady) {
      throw new Error('Worker failed to start');
    }
  }

  return new Promise((resolve, reject) => {
    const requestId = requestIdCounter++;
    const requestWithId = { ...request, id: requestId };

    // Set timeout
    const timeout = setTimeout(() => {
      if (pendingRequests.has(requestId)) {
        pendingRequests.delete(requestId);
        reject(new Error(`Request timed out after ${timeoutMs}ms (possible infinite loop)`));
      }
    }, timeoutMs);

    // Store resolver
    pendingRequests.set(requestId, {
      resolve: (response) => {
        clearTimeout(timeout);
        resolve(response);
      },
      reject: (error) => {
        clearTimeout(timeout);
        reject(error);
      }
    });

    // Send request
    try {
      workerProcess!.stdin!.write(JSON.stringify(requestWithId) + '\n');
    } catch (error) {
      pendingRequests.delete(requestId);
      clearTimeout(timeout);
      reject(error);
    }
  });
}

// Watch for file changes and reload worker
function watchFiles(): void {
  const filesToWatch = [
    'imp-core.mjs',
    'imp-load.mjs',
    'imp-eval.mjs',
    'imp-show.mjs',
    'imp-mcp-worker.mjs',
  ].map(f => join(__dirname, f));

  for (const file of filesToWatch) {
    watch(file, (eventType) => {
      if (eventType === 'change') {
        console.error(`File changed: ${file}, reloading worker...`);
        if (workerReady) {
          sendToWorker({ operation: 'reload' }).catch(() => {
            // If reload fails, restart the worker
            startWorker();
          });
        }
      }
    });
  }
}

// Create server instance
const server = new Server(
  {
    name: "implish-mcp-server",
    version: "0.1.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "eval_implish",
        description: "Evaluate implish code and return the result. Handles multi-line code, expressions, and assignments. Returns the value of the last expression or NIL if there's no result to display.",
        inputSchema: {
          type: "object",
          properties: {
            code: {
              type: "string",
              description: "The implish code to evaluate",
            },
          },
          required: ["code"],
        },
      },
      {
        name: "load_implish",
        description: "Parse implish code into its token tree representation without evaluating it. Useful for debugging parser behavior.",
        inputSchema: {
          type: "object",
          properties: {
            code: {
              type: "string",
              description: "The implish code to parse",
            },
          },
          required: ["code"],
        },
      },
      {
        name: "list_words",
        description: "List all currently defined words (functions and variables) in the implish environment",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "inspect_word",
        description: "Show the definition/value of a specific word in the implish environment",
        inputSchema: {
          type: "object",
          properties: {
            word: {
              type: "string",
              description: "The word name to inspect",
            },
          },
          required: ["word"],
        },
      },
    ],
  };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "eval_implish": {
        if (!args) {
          throw new Error("arguments are required");
        }
        const code = args.code as string;
        if (!code) {
          throw new Error("code parameter is required");
        }

        // Send to long-running worker
        const response = await sendToWorker({ operation: 'eval', code });

        if (!response.success) {
          return {
            content: [
              {
                type: "text",
                text: `Error: ${response.error}`,
              },
            ],
            isError: true,
          };
        }

        return {
          content: [
            {
              type: "text",
              text: response.result || "",
            },
          ],
        };
      }

      case "load_implish": {
        if (!args) {
          throw new Error("arguments are required");
        }
        const code = args.code as string;
        if (!code) {
          throw new Error("code parameter is required");
        }

        // Send to long-running worker
        const response = await sendToWorker({ operation: 'load', code });

        if (!response.success) {
          return {
            content: [
              {
                type: "text",
                text: `Error: ${response.error}`,
              },
            ],
            isError: true,
          };
        }

        return {
          content: [
            {
              type: "text",
              text: response.result || "",
            },
          ],
        };
      }

      case "list_words": {
        // Send to long-running worker
        const response = await sendToWorker({ operation: 'list_words' });

        if (!response.success) {
          return {
            content: [
              {
                type: "text",
                text: `Error: ${response.error}`,
              },
            ],
            isError: true,
          };
        }

        return {
          content: [
            {
              type: "text",
              text: response.result || "",
            },
          ],
        };
      }

      case "inspect_word": {
        if (!args) {
          throw new Error("arguments are required");
        }
        const word = args.word as string;
        if (!word) {
          throw new Error("word parameter is required");
        }

        // Send to long-running worker
        const response = await sendToWorker({ operation: 'inspect_word', word });

        if (!response.success) {
          return {
            content: [
              {
                type: "text",
                text: `Error: ${response.error}`,
              },
            ],
            isError: true,
          };
        }

        return {
          content: [
            {
              type: "text",
              text: response.result || "",
            },
          ],
        };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      content: [
        {
          type: "text",
          text: `Error: ${errorMessage}`,
        },
      ],
      isError: true,
    };
  }
});

// Start the server
async function main() {
  // Start worker process
  startWorker();

  // Watch for file changes
  watchFiles();

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Implish MCP server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error in main():", error);
  process.exit(1);
});
