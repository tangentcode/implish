import * as imp from './imp-core.mjs'
import {end, ImpAttrs, ImpP, ImpT, ImpVal, nil, TreeBuilder} from './imp-core.mjs'
import {impShow} from './imp-show.mjs'
import {read} from './imp-read.mjs'
import * as assert from "assert"

let impWords: Record<string, ImpVal<any>> = {
  'nil': nil,
  '+'   : imp.jdy((x,y)=>imp.int(x[2]+y[2])),
  '-'   : imp.jdy((x,y)=>imp.int(x[2]-y[2])),
  '*'   : imp.jdy((x,y)=>imp.int(x[2]*y[2])),
  '%'   : imp.jdy((x,y)=>imp.int(Math.floor(x[2]/y[2]))),
  'read': imp.jsf(x=>read(x), 1),
  'xmls': imp.jsf(x=>imp.str(toXml(x) as string), 1),
  'look': imp.jsf(x=>imp.str(impShow(impWords[x[2]] ?? nil)), 1),
  'eval': imp.jsf(x=>eval(x), 1),
  'part': imp.jsf(x=>imp.str(wordClass(x)), 1),
  'show': imp.jsf(x=>imp.str(impShow(x)), 1),
  'echo': imp.jsf(x=>(console.log(x[2]), nil), 1),
}

function xmlTag(tag:string, attrs:ImpAttrs, content?:string) {
  let attrStr = Object.entries(attrs).map(([k,v])=>`${k}="${v}"`).join(' ')
  if (content) return `<${tag} ${attrStr}>${content}</${tag}>`
  else return `<${tag} ${attrStr}/>`
}
function toXml(impv:ImpVal<any>) {
  let [t, a, v] = impv
  switch (t) {
    case ImpT.SEP:
    case ImpT.INT:
    case ImpT.STR:
      return xmlTag('imp:'+t.toLowerCase(),{v})
    case ImpT.NIL: return '<nil/>'
    case ImpT.SYM: return xmlTag('imp:sym', {v:`${v.description}`})
    case ImpT.TOP:
    case ImpT.LST:
      return xmlTag('imp:'+t.toLowerCase(), a,
        '\n  ' + v.map(toXml).join('\n  ') + '\n')
    default: }
}


function wordClass(x:ImpVal<any>) {
    let [xt, _xa, _xv] = x
    switch (xt) {
      case ImpT.TOP: return ImpP.N
      case ImpT.END: return ImpP.E
      case ImpT.INT: return ImpP.N
      case ImpT.STR: return ImpP.N
      case ImpT.MLS: return ImpP.N
      case ImpT.LST: return ImpP.N
      // -- resolved symbols:
      case ImpT.JSF: return ImpP.V
      case ImpT.NIL: return ImpP.N
      case ImpT.JDY: return ImpP.O
      default: throw "[wordClass] invalid argument:" + x }}

class ImpEvaluator {
  words: Record<string, ImpVal<any>> = impWords
  root: ImpVal<any>[]
  here: ImpVal<any>[]
  stack: [ImpVal<any>[], number, ImpP[]][] = []

  item: ImpVal<any> | undefined = undefined
  wc: ImpP | undefined = undefined
  pos: number = 0
  wcs: ImpP[] = [];

  constructor(root: ImpVal<any>[]) {
    this.here = this.root = root }

  enter = (xs:ImpVal<any>): void => {
    this.stack.push([this.here, this.pos, this.wcs])
    this.pos=0; this.here=xs[2]; this.wcs=[]}

  leave = (): void => {
    const popped = this.stack.pop();
    if (!popped) throw new Error("leave without matching enter");
    [this.here, this.pos, this.wcs] = popped;
  }
  atEnd = (): boolean => this.pos >= this.here.length

  /// sets this.item and this.wc
  nextItem = (): ImpVal<any> => {
    let x = (this.pos >= this.here.length) ? end : this.here[this.pos++]
    let [t, _a, v] = x
    if (t === ImpT.SYM) {
      switch (v.description[0]) {
        case '`': this.wc = ImpP.Q; break // TODO: literal word
        case '.': this.wc = ImpP.M; break // TODO: method
        case ':': this.wc = ImpP.G; break // getter
        default: {
          if (v.description.endsWith(':')) this.wc = ImpP.S
          else { // normal symbol, so look it up
            let w = this.words[v.description]
            if (w) x = w, this.wc = this.wordClass(w)
            else throw "undefined word: " + v.description }}}}
    else this.wc = this.wordClass(x)
    this.wcs.push(this.wc)
    return this.item = x}

  peek = (): {item: ImpVal<any>, wc: ImpP}|null => {
    if (this.atEnd()) return null
    let [item, wc, pos] = [this.item, this.wc, this.pos]
    this.nextItem()
    let [peekItem, peekWC] = [this.item, this.wc]
    // !! why does this give "TypeError: Cannot create property '2' on number '1'" ?!?
    // [this.item, this.wc, this.pos] = [item, wc, pos]
    this.item = item; this.wc = wc; this.pos = pos
    if (!peekItem || !peekWC) return null
    return {item: peekItem, wc: peekWC}}

  modifyNoun = (x: ImpVal<any>): ImpVal<any> => {
    // if next token is infix operator (dyad), apply it to x and next noun
    let res = x
    while (this.peek()?.wc === ImpP.O) {
      let op = this.nextItem()
      let arg = this.nextItem()
      res = op[2].apply(this, [res, arg]) }
    return res }

  nextNoun = (): ImpVal<any> => {
    // read a noun, after applying chains of infix operators
    let res = this.nextItem()
    if (this.wc === ImpP.N) res = this.modifyNoun(res)
    else throw "expected a noun, got: " + res
    // todo: collect multiple numbers or quoted symbols into a vector
    // todo: if it's a symbol that starts with ., that's also infix (it's a method)
    return res }

  wordClass = (x: ImpVal<any>): ImpP => wordClass(x)

  // keep the peeked-at item
  keep = (p: {item: ImpVal<any>, wc: ImpP}): void => { this.item = p.item; this.wc = p.wc; this.pos++ }

  modifyVerb = (v0: ImpVal<any>): ImpVal<any> => {
    let p, res = v0
    while (true) {
      p = this.peek()
      if (!p) break
      if (![ImpP.V, ImpP.A, ImpP.P].includes(p.wc)) break
      this.keep(p)
      switch (p.wc) {
        case ImpP.V: // TODO: composition (v u)
          assert.ok(res[1].arity===1, "oh no")
          let u = res[2]
          let v = p.item[2]
          res = imp.jsf((x)=>u(v(x)), 1)
          break
        case ImpP.A: // TODO: adverb (v/)
        case ImpP.P: // TODO: preposition (v -arg)
        case ImpP.C: // TODO: conjunction (v &. u)
      }
    }
    return res
  }

  // evaluate a list
  evalList = (xs:ImpVal<any>): ImpVal<any>[] => {
    // walk from left to right, building up values to emit
    let done = false, tb: TreeBuilder<ImpVal<any>> = new TreeBuilder()
    this.enter(xs)
    while (!done) {
      // skip separators
      do {this.nextItem() } while (this.item && this.item[0] === ImpT.SEP && !this.atEnd())
      if (this.atEnd()) done = true
      let x = this.item!
      switch (this.wc) {
      case ImpP.V: // verb
          x = this.modifyVerb(x)
          let args = []
          for (let i = 0; i < x[1].arity; i++) { args.push(this.nextNoun()) }
          tb.emit(x[2].apply(this, args))
          break
        case ImpP.N:
          // process.stderr.write(`noun: ${impShow(x)}\n`)
          // if x[0] === T.LST {}
          x = this.eval(x)
          x = this.modifyNoun(x)
          tb.emit(x)
          break
        case ImpP.Q:
          tb.emit(x)
          break
        case ImpP.E:
          break
        default: throw "evalList: invalid word class: " + this.wc
      }}
    this.leave()
    return tb.root as ImpVal<any>[]}

  // evaluate a list but return last expression
  lastEval = (xs:ImpVal<any>): ImpVal<any> => {
    let res = this.evalList(xs)
    return res.length ? res.pop()! : nil }

  // project a function
  project = (sym:string, xs: ImpVal<any>[]): ImpVal<any> => {
    let f = this.words[sym]
    if (!f) throw "[project]: undefined word: " + sym
    let args = [], arg = imp.lst()
    for (let x of xs) {
      if (x[0] === ImpT.SEP) { args.push(arg); arg = imp.lst() }
      else imp.push(arg,x)}
    args.push(arg)
    return f[2].apply(this, args.map(this.lastEval))}

  // evaluate an expression
  eval = (x: ImpVal<any>): ImpVal<any> => {
    let [t, a, v] = x
    switch (t) {
      case ImpT.TOP: return this.lastEval(x)
      case ImpT.SEP: return nil
      case ImpT.NIL: return x
      case ImpT.INT: return x
      case ImpT.STR: return x
      case ImpT.MLS: return x
      case ImpT.SYM: return x
      case ImpT.LST:
        let m = a.open.match(/^(.+)([[({])$/)
        if (m) { let sym = m[1]; switch (m[2]) {
          case '[': return this.project(sym, v)
          // case '(': TODO
          // case '{': TODO
          default: return imp.lst(a, this.evalList(x))}}
        else return imp.lst(a, this.evalList(x))
      default: throw "invalid imp value:" + JSON.stringify(x) }}}

export let impEval = (x: ImpVal<any>): ImpVal<any> => new ImpEvaluator(x[2]).eval(x)
