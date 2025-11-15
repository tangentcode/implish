#!/usr/bin/env node
/**
 * Worker process for Implish MCP server
 * Long-running process that handles implish evaluation and supports module reloading
 */

import { pathToFileURL } from 'url';
import * as readline from 'readline';

// Dynamic imports to support reloading
let ImpLoader: any;
let impEval: any;
let impWords: any;
let setOutputProvider: any;
let impShow: any;
let ImpT: any;

// Load/reload all implish modules
async function loadModules() {
  const timestamp = Date.now();
  const imp_core = await import(`./imp-core.mjs?t=${timestamp}`);
  const imp_load = await import(`./imp-load.mjs?t=${timestamp}`);
  const imp_eval = await import(`./imp-eval.mjs?t=${timestamp}`);
  const imp_show = await import(`./imp-show.mjs?t=${timestamp}`);

  ImpLoader = imp_load.ImpLoader;
  impEval = imp_eval.impEval;
  impWords = imp_eval.impWords;
  setOutputProvider = imp_eval.setOutputProvider;
  impShow = imp_show.impShow;
  ImpT = imp_core.ImpT;
}

// Capture output provider for echo statements
class CaptureOutputProvider {
  private lines: string[] = [];

  writeLine(text: string): void {
    this.lines.push(text);
  }

  getOutput(): string {
    return this.lines.join('\n');
  }

  clear(): void {
    this.lines = [];
  }
}

interface WorkerRequest {
  id?: number;
  operation: 'eval' | 'load' | 'list_words' | 'inspect_word' | 'reload';
  code?: string;
  word?: string;
}

interface WorkerResponse {
  id?: number;
  success: boolean;
  result?: string;
  error?: string;
  ready?: boolean;
}

async function handleRequest(request: WorkerRequest): Promise<WorkerResponse> {
  try {
    const response: WorkerResponse = { id: request.id, success: false };

    switch (request.operation) {
      case 'reload': {
        await loadModules();
        response.success = true;
        response.result = 'Modules reloaded';
        break;
      }

      case 'eval': {
        if (!request.code) {
          response.error = 'code parameter is required';
          break;
        }

        // Set up output capture for echo statements
        const outputCapture = new CaptureOutputProvider();
        setOutputProvider(outputCapture);

        const loader = new ImpLoader();
        loader.send(request.code);
        const tree = loader.read();

        if (tree[0] === ImpT.ERR) {
          response.error = tree[2] as string;
          break;
        }

        const result = await impEval(tree);
        const capturedOutput = outputCapture.getOutput();

        // If there was echo output, include it in the result
        if (capturedOutput) {
          if (result[0] === ImpT.NIL) {
            response.success = true;
            response.result = capturedOutput;
          } else {
            response.success = true;
            response.result = capturedOutput + '\n' + impShow(result);
          }
        } else if (result[0] === ImpT.NIL) {
          response.success = true;
          response.result = '';
        } else {
          response.success = true;
          response.result = impShow(result);
        }
        break;
      }

      case 'load': {
        if (!request.code) {
          response.error = 'code parameter is required';
          break;
        }

        const loader = new ImpLoader();
        loader.send(request.code);
        const tree = loader.read();

        if (tree[0] === ImpT.ERR) {
          response.error = tree[2] as string;
          break;
        }

        response.success = true;
        response.result = impShow(tree);
        break;
      }

      case 'list_words': {
        const words = Object.keys(impWords).sort();
        response.success = true;
        response.result = words.join('\n');
        break;
      }

      case 'inspect_word': {
        if (!request.word) {
          response.error = 'word parameter is required';
          break;
        }

        const value = impWords[request.word];
        if (!value) {
          response.error = `undefined word: ${request.word}`;
          break;
        }

        response.success = true;
        response.result = impShow(value);
        break;
      }

      default:
        response.error = `unknown operation: ${(request as any).operation}`;
    }

    return response;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return { id: request.id, success: false, error: errorMessage };
  }
}

async function main() {
  // Load modules initially
  await loadModules();

  // Signal ready to parent (on stdout as a special message)
  process.stdout.write(JSON.stringify({ ready: true }) + '\n');

  // Set up readline to process requests one per line
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false
  });

  for await (const line of rl) {
    try {
      const request: WorkerRequest = JSON.parse(line);
      const response = await handleRequest(request);
      process.stdout.write(JSON.stringify(response) + '\n');
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      process.stdout.write(JSON.stringify({
        success: false,
        error: `Failed to process request: ${errorMessage}`
      }) + '\n');
    }
  }
}

main().catch((error) => {
  console.error('Fatal error in worker:', error);
  process.exit(1);
});
