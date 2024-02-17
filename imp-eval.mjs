import { T, P, nil, end, TreeBuilder } from './imp-core.mjs'
import * as imp from './imp-core.mjs'
import { impShow } from './imp-show.mjs'
import * as assert from "assert"

let impWords = {
  'nil': nil,
  '+'   : imp.jdy((x,y)=>imp.int(x[2]+y[2])),
  '-'   : imp.jdy((x,y)=>imp.int(x[2]-y[2])),
  '*'   : imp.jdy((x,y)=>imp.int(x[2]*y[2])),
  '%'   : imp.jdy((x,y)=>imp.int(Math.floor(x[2]/y[2]))),
  'show': imp.jsf(x=>imp.str(impShow(x)), 1),
  'echo': imp.jsf(x=>(console.log(x[2]), nil), 1),
}

class ImpEvaluator {
  words = impWords
  stack = []

  item = []; wc = null; pos = 0; wcs = [];

  constructor(root) {
    this.root = root
    this.here = this.root
    this.stack = []; this.pos = 0 }

  enter = (xs)=> {
    this.stack.push([this.here, this.pos, this.wcs])
    this.pos=0; this.here=xs[2]; this.wcs=[]}

  leave = (xs)=> {[this.here, this.pos, this.wcs] = this.stack.pop()}
  atEnd = ()=> this.pos >= this.here.length

  /// sets this.item and this.wc
  nextItem = ()=> {
    let x = (this.pos >= this.here.length) ? end : this.here[this.pos++]
    let [t, a, v] = x
    if (t === T.SYM) {
      switch (v.description[0]) {
        case '`': this.wc = P.Q; break // TODO: literal word
        case '.': this.wc = P.M; break // TODO: method
        case ':': this.wc = P.G; break // getter
        default: {
          if (v.description[-1] === ':') this.wc = P.S
          else { // normal symbol, so look it up
            let w = this.words[v.description]
            if (w) x = w, this.wc = this.wordClass(w)
            else throw "undefined word: " + v.description }}}}
    else this.wc = this.wordClass(x)
    this.wcs.push(this.wc)
    return this.item = x}

  peek = ()=> {
    if (this.atEnd()) return {item:null, wc:null}
    let [item, wc, pos] = [this.item, this.wc, this.pos]
    this.nextItem()
    let [peekItem, peekWC] = [this.item, this.wc]
    // !! why does this give "TypeError: Cannot create property '2' on number '1'" ?!?
    // [this.item, this.wc, this.pos] = [item, wc, pos]
    this.item = item; this.wc = wc; this.pos = pos
    let res = {'item':peekItem, 'wc':peekWC}
    return res}

  modifyNoun = (x)=> {
    // if next token is infix operator (dyad), apply it to x and next noun
    let p, res = x
    while ((p = this.peek()).wc === P.O) {
      let op = this.nextItem()
      let arg = this.nextItem()
      res = op[2].apply(this, [res, arg]) }
    return res }

  nextNoun = ()=> {
    // read a noun, after applying chains of infix operators
    let res = this.nextItem()
    if (this.wc === P.N) res = this.modifyNoun(res)
    else throw "expected a noun, got: " + res
    // todo: collect multiple numbers or quoted symbols into a vector
    // todo: if it's a symbol that starts with ., that's also infix (it's a method)
    return res }

  wordClass = (x)=> {
    let [xt, xa, xv] = x
    switch (xt) {
      case T.TOP: return P.N
      case T.END: return P.E
      case T.INT: return P.N
      case T.STR: return P.N
      case T.MLS: return P.N
      case T.LST: return P.N
      // -- resolved symbols:
      case T.JSF: return P.V
      case T.NIL: return P.N
      case T.JDY: return P.O
      default: throw "[wordClass] invalid argument:" + x }}

  // keep the peeked-at item
  keep = (p)=> { this.item=p.item; this.wc=p.wc; this.pos++ }

  modifyVerb = (v0) => {
    let p, res = v0
    while ([P.V, P.A, P.P].includes((p = this.peek()).wc)) {
      this.keep(p)
      switch (p.wc) {
        case P.V: // TODO: composition (v u)
          assert.ok(res[1].arity===1, "oh no")
          let u = res[2]
          let v = p.item[2]
          res = imp.jsf((x)=>u(v(x)), 1)
          break
        case P.A: // TODO: adverb (v/)
        case P.P: // TODO: preposition (v -arg)
        case P.C: // TODO: conjunction (v &. u)
      }
    }
    return res
  }

  // evaluate a list
  evalList = (xs)=> {
    // walk from left to right, building up values to emit
    let tmp = [],  done = false, tb = new TreeBuilder()
    this.enter(xs)
    while (!done) {
      // skip separators
      do {this.nextItem() } while (this.item[0] === T.SEP && !this.atEnd())
      if (this.atEnd()) done = true
      let x = this.item
      // console.log({wcs: this.wcs, x})
      switch (this.wc) {
      case P.V: // verb
          x = this.modifyVerb(x)
          let args = []
          for (let i = 0; i < x[1].arity; i++) { args.push(this.nextNoun()) }
          tb.emit(x[2].apply(this, args))
          break
        case P.N:
          x = this.modifyNoun(x)
          tb.emit(x)
          break
        case P.Q:
          tb.emit(x)
          break
        case P.E:
          break
        default: throw "evalList: invalid word class: " + this.wc
      }}
    this.leave()
    return tb.root}

  // evaluate a list but return last expression
  lastEval = (xs)=> {
    let res = this.evalList(xs)
    return res.length ? res.pop() : nil }

  // project a function
  project = (sym, xs)=> {
    console.log("projecting: ", sym, xs)
    let f = this.words[sym]
    if (!f) throw "[project]: undefined word: " + sym
    let args = [], arg = imp.lst()
    for (let x of xs) {
      if (x[0] === T.SEP) { args.push(arg); arg = imp.lst() }
      else arg.push(x)}
    args.push(arg)

    if (f) return f[2].apply(this, args.map(this.lastEval))
    else throw "undefined word: " + sym }

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
      case T.LST: return imp.lst(a, this.evalList(x))
        console.log("opener is: ", a.open, "and closer is: ", a.close)
        let m = a.open.match(/^(.+)([[({])$/)
        if (m) { let sym = m[1]; switch (m[2]) {
          case '[': return this.project(sym, this.evalList(x))
          // case '(': TODO
          // case '{': TODO
          default: return imp.lst(a, this.evalList(x))}}
        else return imp.lst(a, this.evalList(x))
      default: throw "invalid imp value:" + JSON.stringify(x) }}}

export let impEval = (x)=> new ImpEvaluator(x).eval()
