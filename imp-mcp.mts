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
import { spawn } from 'child_process';

// Get the directory of the current module
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface WorkerRequest {
  operation: 'eval' | 'load' | 'list_words' | 'inspect_word';
  code?: string;
  word?: string;
}

interface WorkerResponse {
  success: boolean;
  result?: string;
  error?: string;
}

// Spawn a worker process to handle implish operations
// This ensures a fresh environment for each operation
async function spawnWorker(request: WorkerRequest, timeoutMs: number = 5000): Promise<WorkerResponse> {
  const workerPath = join(__dirname, 'imp-mcp-worker.mjs');

  return new Promise((resolve, reject) => {
    const child = spawn('node', [workerPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    // Set timeout to kill the process if it runs too long
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      // Force kill after 1 second if not dead
      setTimeout(() => {
        if (!child.killed) {
          child.kill('SIGKILL');
        }
      }, 1000);
    }, timeoutMs);

    child.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(new Error(`Failed to spawn worker: ${error.message}`));
    });

    child.on('close', (code) => {
      clearTimeout(timeout);

      if (timedOut) {
        reject(new Error(`Evaluation timed out after ${timeoutMs}ms (possible infinite loop)`));
        return;
      }

      if (code !== 0) {
        reject(new Error(`Worker exited with code ${code}${stderr ? ': ' + stderr : ''}`));
        return;
      }

      try {
        const response: WorkerResponse = JSON.parse(stdout);
        resolve(response);
      } catch (error) {
        reject(new Error(`Failed to parse worker response: ${error}`));
      }
    });

    // Send request to worker
    child.stdin.write(JSON.stringify(request));
    child.stdin.end();
  });
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

        // Spawn worker with fresh environment
        const response = await spawnWorker({ operation: 'eval', code });

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

        // Spawn worker with fresh environment
        const response = await spawnWorker({ operation: 'load', code });

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
        // Spawn worker with fresh environment
        const response = await spawnWorker({ operation: 'list_words' });

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

        // Spawn worker with fresh environment
        const response = await spawnWorker({ operation: 'inspect_word', word });

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
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Implish MCP server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error in main():", error);
  process.exit(1);
});
