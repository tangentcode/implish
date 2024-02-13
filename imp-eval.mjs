import { T, P, nil, TreeBuilder } from './imp-core.mjs'
import { impShow } from './imp-show.mjs'

let impWords = {
  'nil': nil,
  'show': [T.JSF, {arity: 1}, x=>[T.STR, {}, impShow(x)] ],
  'echo': [T.JSF, {arity: 1}, x=>(console.log(x[2]), nil) ],
}

class ImpEvaluator {
  words = impWords
  stack = []
  item = {}
  wc = null
  lst = null
  pos = 0

  constructor(root) {
    this.root = root
    this.here = this.root
    this.stack = []; this.pos = 0 }

  enter = (xs)=> this.stack.push([this.here, this.pos], this.pos=0, this.here=xs[2])
  leave = (xs)=> {[this.here, this.pos] = this.stack.pop()}
  atEnd = ()=> this.pos >= this.here.length

  /// sets this.item and this.wc
  nextItem = ()=> {
    let x = this.here[this.pos++]
    let [t, a, v] = x
    if (t == T.SYM) {
      switch (v.description[0]) {
        case '`': this.wc = P.Q; break // TODO: literal word
        case '.': this.wc = P.M; break // TODO: method
        case ':': this.wc = P.G; break // getter
        default: {
          if (v.description[-1] == ':') this.wc = P.S
          else { // normal symbol, so look it up
            let w = this.words[v.description]
            if (w) x = w, this.wc = this.wordClass(w)
            else throw "undefined word: " + v.description }}}}
    else this.wc = this.wordClass(x)
    return this.item = x}

  nextNoun = ()=> {
    // expect a noun
    let res = this.nextItem()
    if (this.wc == P.N) return res
    else if (this.wc == P.O) return res
    else throw "expected noun, got: " + res
    // TODO: if next token is infix operator, read next arg


    // todo: collect multiple numbers or quoted symbols into a vector
    // todo: if it's a symbol that starts with ., that's also infix (it's a method)
  }

  wordClass = (x)=> {
    let [xt, xa, xv] = x
    switch (xt) {
      case T.TOP: return P.N
      case T.INT: return P.N
      case T.STR: return P.N
      case T.MLS: return P.N
      case T.LST: return P.N
      // -- resolved symbols:
      case T.JSF: return P.V
      case T.NIL: return P.N
      default: throw "[wordClass] invalid argument:" + x }}

  // evaluate a list
  evalList = (xs)=> {
    this.enter(xs)
    let treeb = new TreeBuilder()
    while (!this.atEnd()) {
      // skip separators
      do { this.nextItem() } while (this.item[0] == T.SEP && !this.atEnd())
      if (this.item[0] == T.SEP) break
      let x = this.item
      switch (this.wc) {
        /*
          V0 -> look ahead for optional arguments
          V0 -> execute V (V0 = verb with arity 0)
          Vx N -> N is first argument
          V A ->

        */
        case P.V: // verb
          let args = []
          // todo: look ahead for adverbs/prepositions
          for (let i = 0; i < x[1].arity; i++) { args.push(this.nextNoun()) }
          treeb.emit(x[2].apply(this, args))
          break
        case P.N:
        case P.Q:
          treeb.emit(x); break
        default: throw "evalList: invalid word class: " + this.wc
      }}
    this.leave()
    return treeb.root}

  // evaluate a list but return last expression
  lastEval = (xs)=> {
    let res = this.evalList(xs)
    return res.length ? res.pop() : nil }

  // evaluate an expression
  eval = ()=> {
    let x = this.here, [t, a, v] = x
    switch (t) {
      case T.TOP: return this.lastEval(x)
      case T.SEP: return nil
      case T.INT: return x
      case T.STR: return x
      case T.MLS: return x
      case T.SYM: return x
      case T.LST: return [T.LST, a, this.evalList(x)]
      default: throw "invalid imp value:" + x }}}

export let impEval = (x)=> new ImpEvaluator(x).eval()