// imp-b4-js-cli.mts : the browser page's engine (imp-b4-js.mts) as a
// line repl, so b4/test can run the b4 suites on b4's javascript vm.
//
//   b4/imp-b4-js [-q] [-e expr ...]     same interface as b4/imp-b4
//   IMP_B4_IMAGE=file.json              image to load (default web/b4-image.json)
//
// vm-level failures (dirty stack, memory still in use) print imp-b4-js:
// on stderr and make the exit code nonzero, as in b4/imp-b4.

import { readFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { ImpB4 } from './imp-b4-js.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const imageFile = process.env.IMP_B4_IMAGE || path.join(root, 'web', 'b4-image.json')

let quiet = false
const exprs: string[] = []
const argv = process.argv.slice(2)
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '-q' || argv[i] === '--quiet') quiet = true
  else if (argv[i] === '-e' && i + 1 < argv.length) exprs.push(argv[++i])
  else { console.error('usage: imp-b4-js [-q] [-e expr ...]'); process.exit(2) }
}

const imp = new ImpB4(JSON.parse(readFileSync(imageFile, 'utf8')))
let exitCode = 0

function evalLine(src: string): void {
  src = src.replace(/\r$/, '')
  if (src.trim() === '/reset') { imp.reset(); console.log('Ready.'); return }
  const r = imp.eval(src)
  if (r.out !== null) console.log(r.out)
  for (const p of r.problems) { console.error(`imp-b4-js: ${p}`); exitCode = 1 }
}

if (exprs.length) exprs.forEach(evalLine)
else {
  const prompt = !quiet && process.stdin.isTTY
  const rl = createInterface({ input: process.stdin, output: prompt ? process.stdout : undefined, terminal: prompt })
  if (prompt) { rl.setPrompt('imp-b4-js> '); rl.prompt() }
  for await (const line of rl) { evalLine(line); if (prompt) rl.prompt() }
}
process.exitCode = exitCode
