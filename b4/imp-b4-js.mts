// imp-b4-js.mts : implish on b4's javascript vm, for the browser (web/b4.html)
// and for b4/test, which runs the b4 suites through it as well.
//
// The vm is b4's own (vendor/b4/b4.mts). Its assembler can't read
// imp.b4a, so the code arrives as a ram image (web/b4-image.json, made
// by b4/mkimage.mjs from the same files b4/imp-b4 loads). Each line
// goes through the same protocol as b4/imp-b4.mjs: the source bytes at
// $8000, nul-terminated, then imp-eval, then checks that the data stack
// is empty and mm has no blocks in use.

import { B4VM } from '../vendor/b4/b4.mjs'

export interface B4Image { end: number, labels: Record<string, number>, ram: string, b4commit: string }

export interface ImpResult {
  out: string | null      // the line imp-eval printed, or null if it printed nothing
  problems: string[]      // vm-level failures: dirty stack, memory still in use
}

const SRC_ADDR = 0x8000
export const MAX_LINE = 0x1000 - 1

function decode(b64: string): Uint8Array {
  const bin = atob(b64), bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}

export class ImpB4 {
  vm = new B4VM()
  labels: Record<string, number>

  constructor(image: B4Image) {
    this.labels = image.labels
    this.vm.ram = new Uint8Array(0x10000)   // b4i's 64k; the js vm defaults to 4k
    this.vm.ram.set(decode(image.ram))
    this.reset()
  }

  call(word: string): void { this.vm.imrun(this.labels[word]) }

  reset(): void {
    this.vm.reset()
    this.call('imp-reset')
  }

  eval(src: string): ImpResult {
    const vm = this.vm
    const bytes = new TextEncoder().encode(src)
    if (bytes.length > MAX_LINE) return { out: `Error: line longer than ${MAX_LINE} bytes`, problems: [] }
    if (bytes.includes(0)) return { out: 'Error: nul byte in source', problems: [] }
    vm.ram.set(bytes, SRC_ADDR)
    vm.ram[SRC_ADDR + bytes.length] = 0
    vm.ob = []
    vm.dput(SRC_ADDR)
    this.call('imp-eval')
    // as b4i shows io 'e output: control characters as spaces. imp.b4a
    // prints an empty result as a lone newline, so it shows as ' '.
    const text = vm.ob.map(c => c < ' ' ? ' ' : c).join('')
    vm.ob = []
    const problems: string[] = []
    if (vm.ds.length) {
      problems.push(`vm data stack not empty after eval: [${vm.ds.map(x => x.toString(16).toUpperCase()).join(' ')}]`)
      vm.ds = []
    }
    this.call('mm-count')
    const used = vm.dpop()
    if (used) problems.push(`vm has ${used} mm block(s) still in use after eval`)
    return { out: text === '' ? null : text === ' ' ? '' : text, problems }
  }
}
