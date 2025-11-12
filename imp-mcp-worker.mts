#!/usr/bin/env node
/**
 * Worker process for Implish MCP server
 * Handles implish evaluation in a fresh environment
 */

import { ImpLoader } from './imp-load.mjs';
import { impEval, impWords, setOutputProvider, type OutputProvider } from './imp-eval.mjs';
import { impShow } from './imp-show.mjs';
import { ImpT } from './imp-core.mjs';
import * as readline from 'readline';

// Capture output provider for echo statements
class CaptureOutputProvider implements OutputProvider {
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
  operation: 'eval' | 'load' | 'list_words' | 'inspect_word';
  code?: string;
  word?: string;
}

interface WorkerResponse {
  success: boolean;
  result?: string;
  error?: string;
}

async function handleRequest(request: WorkerRequest): Promise<WorkerResponse> {
  try {
    switch (request.operation) {
      case 'eval': {
        if (!request.code) {
          return { success: false, error: 'code parameter is required' };
        }

        // Set up output capture for echo statements
        const outputCapture = new CaptureOutputProvider();
        setOutputProvider(outputCapture);

        const loader = new ImpLoader();
        loader.send(request.code);
        const tree = loader.read();

        if (tree[0] === ImpT.ERR) {
          return { success: false, error: tree[2] as string };
        }

        const result = await impEval(tree);
        const capturedOutput = outputCapture.getOutput();

        // If there was echo output, include it in the result
        if (capturedOutput) {
          if (result[0] === ImpT.NIL) {
            return { success: true, result: capturedOutput };
          } else {
            return { success: true, result: capturedOutput + '\n' + impShow(result) };
          }
        }

        if (result[0] === ImpT.NIL) {
          return { success: true, result: '' };
        }

        return { success: true, result: impShow(result) };
      }

      case 'load': {
        if (!request.code) {
          return { success: false, error: 'code parameter is required' };
        }

        const loader = new ImpLoader();
        loader.send(request.code);
        const tree = loader.read();

        if (tree[0] === ImpT.ERR) {
          return { success: false, error: tree[2] as string };
        }

        return { success: true, result: impShow(tree) };
      }

      case 'list_words': {
        const words = Object.keys(impWords).sort();
        return { success: true, result: words.join('\n') };
      }

      case 'inspect_word': {
        if (!request.word) {
          return { success: false, error: 'word parameter is required' };
        }

        const value = impWords[request.word];
        if (!value) {
          return { success: false, error: `undefined word: ${request.word}` };
        }

        return { success: true, result: impShow(value) };
      }

      default:
        return { success: false, error: `unknown operation: ${(request as any).operation}` };
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return { success: false, error: errorMessage };
  }
}

async function main() {
  // Read request from stdin
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false
  });

  let input = '';

  for await (const line of rl) {
    input += line;
  }

  try {
    const request: WorkerRequest = JSON.parse(input);
    const response = await handleRequest(request);
    console.log(JSON.stringify(response));
    process.exit(0);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.log(JSON.stringify({ success: false, error: `Failed to parse request: ${errorMessage}` }));
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('Fatal error in worker:', error);
  process.exit(1);
});
