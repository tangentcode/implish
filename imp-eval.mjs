import { T, nil, TreeBuilder } from './imp-core.mjs'
import { impShow } from './imp-show.mjs'

let impWords = {
  'nil': nil,
  'show': [T.JSF, {arity: 1}, x=>[T.STR, {}, impShow(x)] ],
  'echo': [T.JSF, {arity: 1}, x=>(console.log(x[2]), nil) ],
}

class ImpEvaluator {
  words = impWords
  stack = []
  lst = null
  pos = 0

  constructor(root) { this.here = this.root = root; this.stack = []; this.pos = 0 }

  // evaluate a list
  evalList = (xs)=> {
    let treeb = new TreeBuilder()
    for (let i = 0; i < xs.length; i++) {
      let x = xs[i], [xt, xa, xv] = x
      if (xt == T.SYM) {
          let w = this.words[xv.description]
          if (w) { let [wt, wa, wv] = w
            switch(wt) {
              case T.JSF:
                let args = this.evalList(xs.slice(i+1, i+1+wa.arity))
                i += wa.arity
                treeb.emit(wv.apply(this, args))
                break
              default: treeb.emit(w) }}
          else treeb.emit(this.eval(x))}
      else treeb.emit(this.eval(x)) }
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

export let impEval = (x)=> new ImpEvaluator().eval(x)