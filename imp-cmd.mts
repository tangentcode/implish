#!/usr/bin/node
import { ImpT } from "./imp-core.mjs";
import { ImpLoader, lexerTable, TokT } from "./imp-load.mjs";
import { impShow } from "./imp-show.mjs";
import { impEval, impWords, setInputProvider } from "./imp-eval.mjs";
import { parsePartialPath, reconstructImplishPath } from "./lib-file.mjs";
import * as readline from "readline";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// Parse command-line arguments
let quietMode = false;
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  if (args[i] === '-q' || args[i] === '--quiet') {
    quietMode = true;
  }
}

let il = new ImpLoader();

// History file location
const historyFile = path.join(os.homedir(), '.imp-history');

// Tab completion for file paths and word names
function completer(line: string): [string[], string] {
  // Find the token under the cursor (simplified: assume cursor at end)
  let tokens: Array<{type: string, text: string, start: number}> = []
  let pos = 0
  let remaining = line

  // Tokenize the line to find where we are
  while (remaining.length > 0) {
    let matched = false
    for (let [tokType, rx, _trim] of lexerTable) {
      let m = rx.exec(remaining)
      if (m) {
        tokens.push({type: tokType, text: m[0], start: pos})
        pos += m[0].length
        remaining = remaining.slice(m[0].length)
        matched = true
        break
      }
    }
    if (!matched) break
  }

  // Get the last token (the one being completed)
  if (tokens.length === 0) return [[], '']
  let lastTok = tokens[tokens.length - 1]

  // Handle FILE tokens (file path completion)
  if (lastTok.type === TokT.FILE) {
    return completeFilePath(lastTok.text)
  }

  // Handle RAW tokens (word/symbol completion)
  if (lastTok.type === TokT.RAW) {
    return completeWord(lastTok.text)
  }

  // No completion for other token types
  return [[], '']
}

// Complete file paths (tokens starting with %)
function completeFilePath(token: string): [string[], string] {
  // Strip the % prefix
  let partialPath = token.slice(1)

  // Special case for Windows: %/ lists drives
  if (process.platform === 'win32' && partialPath === '/') {
    return completeWindowsDrives()
  }

  // Parse the partial path using lib-path utilities
  let parsed = parsePartialPath(partialPath)

  // Read directory and filter matches
  try {
    let entries = fs.readdirSync(parsed.nativeDir, {withFileTypes: true})
    let matches = entries
      .filter(e => e.name.startsWith(parsed.prefix))
      .map(e => reconstructImplishPath(parsed, e.name, e.isDirectory()))

    return [matches, token]
  } catch (e) {
    // Directory doesn't exist or can't be read
    return [[], token]
  }
}

// List Windows drives as %/c/, %/d/, etc.
function completeWindowsDrives(): [string[], string] {
  let drives = []
  // Check common drive letters A-Z
  for (let i = 65; i <= 90; i++) {
    let letter = String.fromCharCode(i).toLowerCase()
    try {
      // Try to access the drive - if it exists, it won't throw
      fs.accessSync(letter + ':/')
      drives.push('%/' + letter + '/')
    } catch (e) {
      // Drive doesn't exist or isn't accessible
    }
  }
  return [drives, '%/']
}

// Complete word names from the current scope
function completeWord(token: string): [string[], string] {
  // Get all words that start with the token
  let matches = Object.keys(impWords)
    .filter(word => word.startsWith(token))
    .sort()

  return [matches, token]
}

// Quiet mode REPL: simple line-by-line reading without readline
async function quietRepl() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false  // Disable terminal features (no prompt, no special handling)
  });

  const lineIterator = rl[Symbol.asyncIterator]();

  // Create a provider that reads from the shared iterator
  class REPLInputProvider {
    async readLine() {
      const { value, done } = await lineIterator.next();
      if (done) throw new Error('End of input');
      return value;
    }
  }

  setInputProvider(new REPLInputProvider());

  // Process lines without prompting
  for await (const line of lineIterator) {
    try {
      il.send(line)
      let r = il.read()
      if (r) {
        let e = await impEval(r)
        if (e[0] !== ImpT.NIL) console.log(impShow(e))
      }
    } catch (e) {
      console.trace(e)
    }
  }

  setInputProvider(null);
}

// Interactive mode REPL: full readline with prompt, completion, history
async function interactiveRepl() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    completer: completer
  });

  rl.setPrompt('> ');

  // Only enable history persistence when running interactively (TTY)
  const isInteractive = process.stdin.isTTY && process.stdout.isTTY;

  if (isInteractive) {
    // Load history from file if it exists
    try {
      const history = fs.readFileSync(historyFile, 'utf-8')
        .split('\n')
        .filter(line => line.trim().length > 0)
        .reverse(); // Reverse because history is added in reverse order

      for (const line of history) {
        (rl as any).history.push(line);
      }
    } catch (e) {
      // History file doesn't exist yet or can't be read - that's fine
    }

    // Save history on exit
    function saveHistory() {
      try {
        const history = (rl as any).history
          .slice()
          .reverse()
          .join('\n') + '\n';
        fs.writeFileSync(historyFile, history, 'utf-8');
      } catch (e) {
        console.error('Failed to save history:', e);
      }
    }

    process.on('exit', saveHistory);
    process.on('SIGINT', () => {
      saveHistory();
      process.exit(0);
    });
  }

  // Create an async iterator that we control
  const lineIterator = rl[Symbol.asyncIterator]();

  // Create a provider that reads from the shared iterator
  class REPLInputProvider {
    async readLine() {
      const { value, done } = await lineIterator.next();
      if (done) throw new Error('End of input');
      return value;
    }
  }

  setInputProvider(new REPLInputProvider());

  rl.prompt();

  // Manually iterate instead of using for-await to share the iterator
  while (true) {
    const { value: line, done } = await lineIterator.next();
    if (done) break;

    try {
      il.send(line)
      let r = il.read()
      if (r) {
        let e = await impEval(r)
        if (e[0] !== ImpT.NIL) console.log(impShow(e))
      }
    } catch (e) {
      console.trace(e)
    }
    rl.prompt();
  }

  // Clean up when REPL exits
  setInputProvider(null);
}

// Start the appropriate REPL mode
if (quietMode) {
  await quietRepl()
} else {
  await interactiveRepl()
}
