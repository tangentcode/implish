#!/usr/bin/node
import { ImpT } from "./imp-core.mjs";
import { ImpLoader, lexerTable, TokT } from "./imp-load.mjs";
import { impShow } from "./imp-show.mjs";
import { impEval, impWords } from "./imp-eval.mjs";
import * as readline from "readline";
import * as fs from "fs";

let il = new ImpLoader();

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

  // Special case for Windows: %/d/ means d:/ drive
  let windowsDriveMatch = process.platform === 'win32'
    ? partialPath.match(/^\/([a-zA-Z])(\/|$)(.*)/)
    : null

  let dir = '.'
  let prefix = partialPath

  if (windowsDriveMatch) {
    // Convert %/d/path to d:/path for filesystem operations
    let driveLetter = windowsDriveMatch[1]
    let rest = windowsDriveMatch[3] || ''

    if (rest.includes('/') || rest.includes('\\')) {
      let lastSep = Math.max(rest.lastIndexOf('/'), rest.lastIndexOf('\\'))
      dir = driveLetter + ':/' + rest.slice(0, lastSep)
      prefix = rest.slice(lastSep + 1)
    } else {
      dir = driveLetter + ':/'
      prefix = rest
    }
  } else if (partialPath.includes('/') || partialPath.includes('\\')) {
    let lastSep = Math.max(partialPath.lastIndexOf('/'), partialPath.lastIndexOf('\\'))
    dir = partialPath.slice(0, lastSep) || '.'
    prefix = partialPath.slice(lastSep + 1)
  }

  // Read directory and filter matches
  try {
    let entries = fs.readdirSync(dir, {withFileTypes: true})
    let matches = entries
      .filter(e => e.name.startsWith(prefix))
      .map(e => {
        let fullPath: string

        if (windowsDriveMatch) {
          // For Windows drive paths, reconstruct as %/d/path
          let driveLetter = windowsDriveMatch[1]
          let rest = windowsDriveMatch[3] || ''
          let dirPart = rest.includes('/')
            ? rest.slice(0, rest.lastIndexOf('/') + 1)
            : ''
          fullPath = '/' + driveLetter + '/' + dirPart + e.name
        } else {
          // Regular paths
          fullPath = dir === '.' ? e.name : dir + '/' + e.name
        }

        // Add trailing / for directories
        if (e.isDirectory()) fullPath += '/'
        return '%' + fullPath
      })

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

let rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  completer: completer
});

async function repl() {
  for await (const line of rl) {
    try {
      il.send(line)
      let r = il.read()
      if (r) {
        let e = await impEval(r)
        if (e[0] !== ImpT.NIL) console.log(impShow(e)) }}
    catch (e) { console.trace(e) }}}

await repl()
