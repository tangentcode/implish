#!/usr/bin/env node
// imp-b4.mjs : run implish on the b4 virtual machine.
//
// The interpreter itself is b4/imp.b4a. This driver starts one b4i
// process with it loaded, then for each line of implish:
//
//   :8000 31 20 2B 20 32 00     (the line's bytes, nul-terminated, 16 per line)
//   8000 imp-eval               (the vm evaluates and prints it)
//   ?d                          (sentinel: marks the end of the output)
//
// usage:
//   b4/imp-b4 -e '1 + 2'        evaluate expressions, print results
//   b4/imp-b4 [-q]              line repl on stdin (-q: no prompt)
//   /reset                      (repl line) clear state, print Ready.
// env:
//   B4I                          path to a b4i binary (default: built by b4/imp-b4)

import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const IMP_B4A = path.join(here, 'imp.b4a')
const SRC_ADDR = 0x8000
const MAX_LINE = 0x7000          // keeps the line below the vm stacks at $F800
const SENTINEL = /^ds: \[(.*)\]$/

function usage() {
  console.error("usage: imp-b4 [-q] [-e expr ...]")
  process.exit(2)
}

let quiet = false
const exprs = []
const argv = process.argv.slice(2)
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '-q' || argv[i] === '--quiet') quiet = true
  else if (argv[i] === '-e' && i + 1 < argv.length) exprs.push(argv[++i])
  else usage()
}

const b4i = process.env.B4I
if (!b4i) {
  console.error("imp-b4: set B4I to a b4i binary (b4/imp-b4 does this for you)")
  process.exit(2)
}

const hex = n => n.toString(16).toUpperCase()   // b4a hex is upper case only

// b4i commands that write src, nul-terminated, at SRC_ADDR. Each b4i line
// holds 16 bytes at an explicit address: b4i builds limit line length
// (Pascal truncates long lines), so the source never goes on one line.
function pokeSource(src) {
  const bytes = [...Buffer.from(src, 'utf8'), 0]
  let cmds = ''
  for (let i = 0; i < bytes.length; i += 16)
    cmds += `:${hex(SRC_ADDR + i)} ` + bytes.slice(i, i + 16).map(b => hex(b).padStart(2, '0')).join(' ') + '\n'
  return cmds
}

const vm = spawn(b4i, ['-a', IMP_B4A], { stdio: ['pipe', 'pipe', 'inherit'] })
const out = createInterface({ input: vm.stdout })
// Lines stream to the vm without waiting, since some b4i builds (Pascal)
// buffer stdout until exit. Each sentinel closes the oldest pending line;
// only the interactive prompt waits for it. Lines the driver rejects
// itself join the same queue, so every result prints in input order.
const pending = []               // {resolve, text}: text is set for driver-only lines
let exitCode = 0

function flush() {               // print driver-only lines that reached the front
  while (pending.length && pending[0].text !== undefined) {
    const p = pending.shift(); process.stdout.write(p.text); p.resolve()
  }
}

out.on('line', line => {
  const m = SENTINEL.exec(line)
  if (m && pending.length && pending[0].text === undefined) {
    if (m[1] !== '') {
      console.error(`imp-b4: vm data stack not empty after eval: [${m[1]}]`)
      exitCode = 1
    }
    pending.shift().resolve(); flush()
  } else process.stdout.write(line + '\n')
})

const vmExit = new Promise(resolve => vm.on('close', code => resolve(code ?? 1)))
vmExit.then(code => {
  if (pending.length) {          // the vm died mid-line (e.g. b4i rejected imp.b4a)
    console.error(`imp-b4: b4i exited with code ${code}`)
    process.exit(code || 1)
  }
})

// queue b4i commands; resolves once their output has been printed
function sendVm(cmds) {
  return new Promise(resolve => {
    pending.push({ resolve, text: undefined })
    vm.stdin.write(cmds + '?d\n')
  })
}

// queue a line the driver prints itself, in order with the vm's output
function say(text) {
  return new Promise(resolve => { pending.push({ resolve, text }); flush() })
}

function evalLine(src) {
  src = src.replace(/\r$/, '')
  // tanco's restart protocol, as in imp-cmd.mts
  if (src.trim() === '/reset') { sendVm('imp-reset\n'); return say('Ready.\n') }
  if (Buffer.byteLength(src, 'utf8') > MAX_LINE) return say(`Error: line longer than ${MAX_LINE} bytes\n`)
  if (src.includes('\0')) return say('Error: nul byte in source\n')
  return sendVm(`${pokeSource(src)}${hex(SRC_ADDR)} imp-eval\n`)
}

async function finish() {
  vm.stdin.end('/q\n')
  const code = await vmExit
  process.exit(exitCode || code)
}

if (exprs.length) {
  for (const e of exprs) evalLine(e)
  await finish()
} else {
  const prompt = !quiet && process.stdin.isTTY
  const rl = createInterface({ input: process.stdin, output: prompt ? process.stdout : undefined, terminal: prompt })
  if (prompt) { rl.setPrompt('imp-b4> '); rl.prompt() }
  for await (const line of rl) {
    const done = evalLine(line)
    if (prompt) { await done; rl.prompt() }
  }
  await finish()
}
