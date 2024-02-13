import { T, nil } from './imp-core.mjs'

export class ImpEvaluator {

  // evaluate a list
  evalList = (xs)=> xs.map(this.eval)

  // evaluate a list but return last expression
  lastEval = (xs)=> {
    let res = this.evalList(xs)
    return res.length ? res.pop() : nil }

  // evaluate an expression
  eval = (x)=> {
    let [t, a, v] = x
    switch (t) {
      case T.TOP: return this.lastEval(v)
      case T.SEP: return nil
      case T.INT: return x
      case T.STR: return x
      case T.NIL: return x
      case T.MLS: return x
      case T.SYM: return x
      case T.LST: return [T.LST, a, this.evalList(v)]
      default: throw "invalid imp value:" + x }}}
