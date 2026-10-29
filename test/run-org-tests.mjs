#!/usr/bin/env node
// Minimal, dependency-free runner for the tanco-style org test files.
// Runs every heading marked TEST: lines starting with "> " are fed to the
// quiet REPL (dist/imp-cmd.mjs -q); all other lines are expected output.
// Lines starting with "#" inside a block are comments. Each test starts
// from a fresh interpreter state via the REPL's /reset command.
//
// usage: node test/run-org-tests.mjs [file.org ...]   (default: all test files)

import { spawnSync } from 'child_process'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import * as path from 'path'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_FILES = ['imp-tests.org', 'prim-tests.org', 'test/regressions.org']
const files = process.argv.length > 2 ? process.argv.slice(2) : DEFAULT_FILES

function parseTests(file) {
  let tests = [], cur = null, inSrc = false
  readFileSync(path.resolve(root, file), 'utf-8').split('\n').forEach((line, i) => {
    let m = /^\*+ (\S+) ([^ :]+)/.exec(line)
    if (m) { cur = m[1] === 'TEST' ? {file, line: i + 1, name: m[2], input: [], expect: []} : null
             if (cur) tests.push(cur); return }
    if (!cur) return
    if (/^#\+begin_src/.test(line)) { inSrc = true; return }
    if (/^#\+end_src/.test(line)) { inSrc = false; return }
    if (!inSrc || line.startsWith('#')) return
    if (line.startsWith('> ')) cur.input.push(line.slice(2))
    else cur.expect.push(line)
  })
  return tests
}

// Run all tests of one file in a single REPL process, separated by /reset.
function runFile(tests) {
  let stdin = tests.map(t => ['/reset', ...t.input].join('\n')).join('\n') + '\n'
  let r = spawnSync(process.execPath, ['dist/imp-cmd.mjs', '-q'], {cwd: root, input: stdin, encoding: 'utf-8', timeout: 60000})
  if (r.error) throw r.error
  let chunks = r.stdout.split(/^Ready\.\n/m).slice(1)
  return tests.map((t, i) => (chunks[i] ?? '').replace(/\n$/, ''))
}

let passed = 0, total = 0, failures = []
for (let file of files) {
  let tests = parseTests(file)
  let outs = runFile(tests)
  tests.forEach((t, i) => {
    total++
    let want = t.expect.join('\n').replace(/\n+$/, ''), got = outs[i]
    if (got === want) passed++
    else failures.push({t, want, got})
  })
}
for (let {t, want, got} of failures) {
  console.log(`FAIL ${t.file}:${t.line} ${t.name}`)
  console.log('  input:\n' + t.input.map(l => '    > ' + l).join('\n'))
  console.log('  expected:\n' + want.split('\n').map(l => '    ' + l).join('\n'))
  console.log('  got:\n' + got.split('\n').map(l => '    ' + l).join('\n'))
}
console.log(`${passed}/${total} tests passed`)
process.exit(passed === total ? 0 : 1)
