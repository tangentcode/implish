import { T, nil, TreeBuilder } from './imp-core.mjs'

export class ImpEvaluator {

  // evaluate a list
  evalList = (xs)=> {
    let treeb = new TreeBuilder()
    for (let i = 0; i < xs.length; i++) {
      let [t, a, v] = xs[i]
      switch (t) {
        default: treeb.emit(this.eval(xs[i])) }}
    return treeb.root}

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
