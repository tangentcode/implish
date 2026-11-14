// Tests for the embedding API (impEval on token trees made in JavaScript).
// The org tests can only type text into the REPL, so they cannot put a
// function value into a token tree. Run: node test/api-tests.mjs
import assert from 'node:assert/strict'
import {impEval, impWords, resetWords} from '../dist/imp-eval.mjs'
import {ImpC} from '../dist/imp-core.mjs'
import {load} from '../dist/imp-load.mjs'
import {impShow} from '../dist/imp-show.mjs'

const tests = []
const test = (name, fn) => tests.push([name, fn])
const run = async (tree) => impShow(await impEval(tree))

// issue 21, Codex round 8: a JSF or IFN value in a token tree is a verb.
test('function-value-prefix', async () => {
  assert.equal(await run(ImpC.top([impWords.rev, ImpC.ints([1, 2, 3])])), '3 2 1')
})

test('function-value-infix', async () => {
  assert.equal(await run(ImpC.top([ImpC.ints([1, 2, 3]), impWords['+'], ImpC.ints([10, 20, 30])])), '11 22 33')
})

test('ifn-value', async () => {
  const f = await impEval(load(ImpC.str('{x * 2}')))
  assert.equal(await run(ImpC.top([f, ImpC.int(21)])), '42')
})

test('function-value-from-unquote', async () => {
  const q = await impEval(load(ImpC.str('r: :rev  `[,r 1 2 3]')))
  assert.equal(await run(ImpC.top(q[2])), '3 2 1')
})

let failed = 0
for (const [name, fn] of tests) {
  resetWords()
  try { await fn(); console.log('ok   ' + name) }
  catch (e) { failed++; console.log('FAIL ' + name + '\n  ' + (e?.message ?? e)) }
}
console.log(`${tests.length - failed}/${tests.length} api tests passed`)
process.exit(failed ? 1 : 0)
