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

import { ImpLoader } from "./imp-load.mjs";
import { impEval, impWords } from "./imp-eval.mjs";
import { impShow } from "./imp-show.mjs";
import { ImpT } from "./imp-core.mjs";

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

        // Parse the code
        const loader = new ImpLoader();
        loader.send(code);
        const parsed = loader.read();

        // Check for parse errors
        if (parsed[0] === ImpT.ERR) {
          return {
            content: [
              {
                type: "text",
                text: `Parse error: ${parsed[2]}`,
              },
            ],
          };
        }

        // Evaluate the code
        const result = await impEval(parsed);

        // Format the result
        let output: string;
        if (result[0] === ImpT.ERR) {
          output = `Error: ${result[2]}`;
        } else if (result[0] === ImpT.NIL) {
          output = ""; // Don't show NIL (like the REPL)
        } else {
          output = impShow(result);
        }

        return {
          content: [
            {
              type: "text",
              text: output,
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

        // Parse the code
        const loader = new ImpLoader();
        loader.send(code);
        const parsed = loader.read();

        // Show the parsed result
        const output = impShow(parsed);

        return {
          content: [
            {
              type: "text",
              text: output,
            },
          ],
        };
      }

      case "list_words": {
        const words = Object.keys(impWords).sort();
        return {
          content: [
            {
              type: "text",
              text: words.join("\n"),
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

        const value = impWords[word];
        if (value === undefined) {
          return {
            content: [
              {
                type: "text",
                text: `Word '${word}' is not defined`,
              },
            ],
          };
        }

        const output = impShow(value);
        return {
          content: [
            {
              type: "text",
              text: output,
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
