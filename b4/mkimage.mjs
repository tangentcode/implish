#!/usr/bin/env node
// mkimage.mjs : assemble implish for b4 into a ram image, for the browser.
//
//   B4I=path/to/b4i node b4/mkimage.mjs [out.json]    (default: web/b4-image.json)
//   IMP_B4A=file.b4a                                  another interpreter (for tests)
//
// b4's js assembler can't read pre.b4a or imp.b4a (no .[ .] quotations,
// no >forward refs, no strings with spaces), so the Rust b4i assembles
// them, exactly as b4/imp-b4 loads them, and this script reads the
// result back out of the vm: every byte from 0 (the registers) up to
// the end of the code, plus the addresses of the words the page calls.
// b4/test rebuilds the image and fails if the committed one differs.

import { spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import os from 'node:os'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.dirname(here)
const B4 = process.env.B4 || path.join(os.homedir(), 'ver', 'b4')
const b4i = process.env.B4I
if (!b4i) { console.error('mkimage: set B4I to a Rust b4i binary'); process.exit(2) }
const out = process.argv[2] || path.join(root, 'web', 'b4-image.json')
const files = [path.join(B4, 'b4a', 'pre.b4a'), path.join(here, 'mm.b4a'), process.env.IMP_B4A || path.join(here, 'imp.b4a')]
const WORDS = ['imp-eval', 'imp-reset', 'imp-leaks']

function b4iRun(cmds) {
  const args = files.flatMap(f => ['-a', f])
  const r = spawnSync(b4i, args, { input: cmds + '/q\n', encoding: 'utf8' })
  if (r.status !== 0) { console.error(`mkimage: b4i failed:\n${r.stdout}${r.stderr}`); process.exit(1) }
  return r.stdout.split('\n').filter(l => l.startsWith('ds: ['))
    .map(l => l.slice(5, -1).split(' ').filter(Boolean).map(x => parseInt(x, 16)))
}

const [[end, ...addrs]] = b4iRun(`@_ ${WORDS.map(w => '`' + w).join(' ')} ?d\n`)
const labels = Object.fromEntries(WORDS.map((w, i) => [w, addrs[i]]))

// read the image a cell at a time, 16 cells per b4i line
let cmds = ''
for (let a = 0; a < end; a += 64) {
  const cells = []
  for (let i = 0; i < 16; i++) cells.push((a + 4 * i).toString(16).toUpperCase() + ' ri')
  cmds += cells.join(' ') + ' ?d' + ' zp'.repeat(16) + '\n'
}
const bytes = Buffer.alloc(Math.ceil(end / 64) * 64)
b4iRun(cmds).forEach((cells, line) => cells.forEach((v, i) => bytes.writeInt32LE(v | 0, line * 64 + i * 4)))

const git = args => spawnSync('git', ['-C', B4, ...args], { encoding: 'utf8' }).stdout.trim()
const image = {
  about: 'implish for b4: b4a/pre.b4a (from b4), b4/mm.b4a and b4/imp.b4a, assembled by b4/mkimage.mjs',
  b4commit: git(['rev-parse', 'HEAD']) + (git(['status', '--porcelain', 'b4a/pre.b4a']) ? ' (pre.b4a modified)' : ''),
  end, labels,
  ram: bytes.subarray(0, end).toString('base64'),
}
writeFileSync(out, JSON.stringify(image, null, 1) + '\n')
