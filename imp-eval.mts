import * as imp from './imp-core.mjs'
import {
  END,
  ImpLstA,
  ImpP,
  ImpT,
  ImpVal,
  ImpQ,
  NIL,
  SymT,
  TreeBuilder,
  ImpJdy,
  JDY,
  JSF,
  ImpJsf,
  ImpStr, ImpC, ImpTop, ImpErr, ImpLst
} from './imp-core.mjs'
import {impShow} from './imp-show.mjs'
import {load} from './imp-read.mjs'
import * as assert from "assert"
import * as fs from "fs"
import * as https from "https"
import * as http from "http"

// Helper: read file or URL content as string (async)
async function readContent(x: ImpVal): Promise<string> {
  // Check if it's a FILE symbol
  if (ImpQ.isSym(x) && x[1].kind === SymT.FILE) {
    let filepath = x[2].description!

    // On Windows, convert %/d/path to d:/path
    if (process.platform === 'win32') {
      let driveMatch = filepath.match(/^\/([a-zA-Z])\/(.*)/)
      if (driveMatch) {
        filepath = driveMatch[1] + ':/' + driveMatch[2]
      }
    }

    try {
      return fs.readFileSync(filepath, 'utf8')
    } catch (e: any) {
      throw `Failed to read file: ${filepath} - ${e.message}`
    }
  }
  // Check if it's a URL symbol
  else if (ImpQ.isSym(x) && x[1].kind === SymT.URL) {
    let url = x[2].description!
    return new Promise((resolve, reject) => {
      let protocol = url.startsWith('https:') ? https : http
      protocol.get(url, (res) => {
        let data = ''
        res.on('data', chunk => data += chunk)
        res.on('end', () => resolve(data))
      }).on('error', (e) => reject(`Failed to fetch URL: ${url} - ${e.message}`))
    })
  }
  // String fallback (treat as filepath)
  else if (x[0] === ImpT.STR) {
    let filepath = x[2] as string
    try {
      return fs.readFileSync(filepath, 'utf8')
    } catch (e: any) {
      throw `Failed to read file: ${filepath} - ${e.message}`
    }
  }
  else {
    throw 'read expects a %file, URL, or string filepath'
  }
}

export let impWords: Record<string, ImpVal> = {
  'nil': NIL,
  '+'   : imp.jdy((x,y)=>ImpC.int((x[2] as number) + (y[2] as number))),
  '-'   : imp.jdy((x,y)=>ImpC.int((x[2] as number) - (y[2] as number))),
  '*'   : imp.jdy((x,y)=>ImpC.int((x[2] as number) * (y[2] as number))),
  '%'   : imp.jdy((x,y)=>ImpC.int(Math.floor((x[2] as number ) / (y[2] as number)))),
  'rd': imp.jsf(async x=>ImpC.str(await readContent(x)), 1),
  'load': imp.jsf(x=>load(x as ImpStr), 1),
  'xmls': imp.jsf(x=>ImpC.str(toXml(x) as string), 1),
  'look': imp.jsf(x=>ImpC.str(impShow(impWords[(x[2] as string)] ?? NIL)), 1),
  'eval': imp.jsf(x=>eval(x[2] as string), 1),
  'part': imp.jsf(x=>ImpC.str(wordClass(x)), 1),
  'show': imp.jsf(x=>ImpC.str(impShow(x)), 1),
  'echo': imp.jsf(x=>(console.log(x[2]), NIL), 1),
}

function xmlTag(tag:string, attrs:Record<string, string>, content?:string) {
  let attrStr = Object.entries(attrs).map(([k,v])=>`${k}="${v}"`).join(' ')
  if (content) return `<${tag} ${attrStr}>${content}</${tag}>`
  else return `<${tag} ${attrStr}/>`
}

// Type-safe toXml using utility object for syntactic sugar
function toXml(x: ImpVal): string {
  if (x[0] === ImpT.NIL) return '<nil/>';
  if (ImpQ.isSym(x)) {
    const attrs: Record<string, string> = {}
    // Only add 'k' attribute if not RAW (add first for consistent ordering)
    if (x[1].kind !== SymT.RAW) {
      const kindNames = ['raw', 'set', 'get', 'lit', 'refn', 'ish', 'path', 'file', 'url', 'bqt', 'typ', 'ann', 'msg', 'kw', 'msg2', 'kw2']
      attrs.k = kindNames[x[1].kind]
    }
    attrs.v = `${x[2].description}`
    return xmlTag('imp:sym', attrs)
  }
  if (ImpQ.isLst(x) || x[0] === ImpT.TOP) {
    return xmlTag('imp:' + x[0].toLowerCase(), x[1]??{},
      '\n  ' + x[2].map(toXml).join('\n  ') + '\n')}
  // For other types (SEP, INT, STR, MLS, JSF, JDY, END), treat as simple values
  return xmlTag('imp:' + x[0].toLowerCase(), {v: (x[2]??'').toString()})}

function wordClass(x:ImpVal) {
    let [xt, _xa, _xv] = x
    switch (xt) {
      case ImpT.TOP: return ImpP.N
      case ImpT.END: return ImpP.E
      case ImpT.INT: return ImpP.N
      case ImpT.NUM: return ImpP.N
      case ImpT.STR: return ImpP.N
      case ImpT.MLS: return ImpP.N
      case ImpT.LST: return ImpP.N
      // -- resolved symbols:
      case ImpT.JSF: return ImpP.V
      case ImpT.NIL: return ImpP.N
      case ImpT.JDY: return ImpP.O
      default: throw "[wordClass] invalid argument:" + x }}

class ImpEvaluator {
  words: Record<string, ImpVal> = impWords
  root: ImpVal[]
  here: ImpVal[]
  stack: [ImpVal[], number, ImpP[]][] = []

  item: ImpVal | undefined = undefined
  wc: ImpP | undefined = undefined
  pos: number = 0
  wcs: ImpP[] = [];

  constructor(root: ImpVal[]) {
    this.here = this.root = root }

  enter = (xs:ImpLst|ImpTop): void => {
    this.stack.push([this.here, this.pos, this.wcs])
    this.pos=0; this.here=xs[2]; this.wcs=[]}

  leave = (): void => {
    const popped = this.stack.pop();
    if (!popped) throw new Error("leave without matching enter");
    [this.here, this.pos, this.wcs] = popped;
  }
  atEnd = (): boolean => this.pos >= this.here.length

  /// sets this.item and this.wc
  nextItem = (): ImpVal => {
    let x = (this.pos >= this.here.length) ? END : this.here[this.pos++]
    if (ImpQ.isSym(x)) {
      // Check symbol kind - only RAW symbols are looked up
      switch (x[1].kind) {
        case SymT.RAW: {
          // Normal symbol, so look it up
          let w = this.words[x[2].description!]
          if (w) x = w, this.wc = this.wordClass(w)
          else throw "undefined word: " + x[2].description
          break
        }
        case SymT.SET:  this.wc = ImpP.S; break  // set-word
        case SymT.GET:  this.wc = ImpP.G; break  // get-word
        case SymT.LIT:  this.wc = ImpP.Q; break  // lit-word (quote)
        case SymT.BQT:  this.wc = ImpP.Q; break  // backtick (quote)
        case SymT.MSG:  this.wc = ImpP.M; break  // message
        case SymT.KW:   this.wc = ImpP.M; break  // keyword (treat as message)
        case SymT.MSG2: this.wc = ImpP.M; break  // message2
        case SymT.KW2:  this.wc = ImpP.M; break  // keyword2 (treat as message)
        default: this.wc = ImpP.N; break  // other types are nouns
      }
    }
    else this.wc = this.wordClass(x)
    this.wcs.push(this.wc)
    return this.item = x}

  peek = (): {item: ImpVal, wc: ImpP}|null => {
    if (this.atEnd()) return null
    let [item, wc, pos] = [this.item, this.wc, this.pos]
    this.nextItem()
    let [peekItem, peekWC] = [this.item, this.wc]
    // !! why does this give "TypeError: Cannot create property '2' on number '1'" ?!?
    // [this.item, this.wc, this.pos] = [item, wc, pos]
    this.item = item; this.wc = wc; this.pos = pos
    if (!peekItem || !peekWC) return null
    return {item: peekItem, wc: peekWC}}

  modifyNoun = async (x: ImpVal): Promise<ImpVal> => {
    // if next token is infix operator (dyad), apply it to x and next noun
    let res = x
    while (this.peek()?.wc === ImpP.O) {
      let op = this.nextItem() as ImpJdy
      let arg = this.nextItem()
      res = await op[2].apply(this, [res, arg]) }
    return res }

  // Handle assignment - recursively processes chained assignments
  doAssign = async (sym: ImpVal): Promise<ImpVal> => {
    if (!ImpQ.isSym(sym)) throw "set-word must be a symbol"
    let varName = sym[2].description!
    let nextX = this.nextItem()
    let value: ImpVal
    // Handle based on word class
    if (this.wc === ImpP.S) {
      // Another set-word - recurse (enables a: b: 123)
      value = await this.doAssign(nextX)
    } else if (this.wc === ImpP.N) {
      value = await this.eval(nextX)
      value = await this.modifyNoun(value)
    } else if (this.wc === ImpP.V) {
      nextX = this.modifyVerb(nextX as ImpJsf)
      let args = []
      for (let i = 0; i < nextX[1].arity; i++) { args.push(await this.nextNoun()) }
      value = await nextX[2].apply(this, args)
    } else if (this.wc === ImpP.Q) {
      value = nextX
    } else {
      throw "invalid expression after set-word"
    }
    this.words[varName] = value
    return value
  }

  nextNoun = async (): Promise<ImpVal> => {
    // read a noun, after applying chains of infix operators
    let res = this.nextItem()
    if (this.wc === ImpP.N) res = await this.modifyNoun(res)
    else throw "expected a noun, got: " + res
    // todo: collect multiple numbers or quoted symbols into a vector
    // todo: if it's a symbol that starts with ., that's also infix (it's a method)
    return res }

  wordClass = (x: ImpVal): ImpP => wordClass(x)

  // keep the peeked-at item
  keep = (p: {item: ImpVal, wc: ImpP}): void => { this.item = p.item; this.wc = p.wc; this.pos++ }

  modifyVerb = (v0: ImpJsf): ImpJsf => {
    let p, res = v0
    while (true) {
      p = this.peek()
      if (!p) break
      if (![ImpP.V, ImpP.A, ImpP.P].includes(p.wc)) break
      this.keep(p)
      switch (p.wc) {
        case ImpP.V: // composition (v u) - handle async
          assert.ok(res[1].arity as number ===1, "oh no")
          let u = res[2] as JSF
          let v = p.item[2] as JSF
          res = imp.jsf(async (x) => {
            let vResult = v(x)
            // If v returns a Promise, await it
            if (vResult instanceof Promise) vResult = await vResult
            let uResult = u(vResult)
            // If u returns a Promise, await it
            if (uResult instanceof Promise) uResult = await uResult
            return uResult
          }, 1)
          break
        case ImpP.A: // TODO: adverb (v/)
        case ImpP.P: // TODO: preposition (v -arg)
        case ImpP.C: // TODO: conjunction (v &. u)
      }
    }
    return res
  }

  // evaluate a list
  evalList = async (xs:ImpLst|ImpTop): Promise<ImpVal[]> => {
    // walk from left to right, building up values to emit
    let done = false, tb: TreeBuilder<ImpVal> = new TreeBuilder()
    this.enter(xs)
    while (!done) {
      // skip separators
      do {this.nextItem() } while (this.item && this.item[0] === ImpT.SEP && !this.atEnd())
      if (this.atEnd()) done = true
      let x = this.item!
      switch (this.wc) {
      case ImpP.V: // verb
          x = this.modifyVerb(x as ImpJsf)
          let args = []
          for (let i = 0; i < x[1].arity; i++) { args.push(await this.nextNoun()) }
          tb.emit(await x[2].apply(this, args))
          break
        case ImpP.N:
          // process.stderr.write(`noun: ${impShow(x)}\n`)
          // if x[0] === T.LST {}
          x = await this.eval(x)
          x = await this.modifyNoun(x)
          tb.emit(x)
          break
        case ImpP.Q:
          tb.emit(x)
          break
        case ImpP.S: // set-word (assignment)
          tb.emit(await this.doAssign(x))
          break
        case ImpP.E:
          break
        default: throw "evalList: invalid word class: " + this.wc
      }}
    this.leave()
    return tb.root as ImpVal[]}

  // evaluate a list but return last expression
  lastEval = async (xs:ImpLst|ImpTop): Promise<ImpVal> => {
    let res = await this.evalList(xs)
    return res.length ? res.pop()! : NIL }

  // project a function
  project = async (sym:string, xs: ImpVal[]): Promise<ImpVal> => {
    let f: imp.ImpJsf | undefined = this.words[sym] as ImpJsf
    if (!f) throw "[project]: undefined word: " + sym
    let args = [], arg = imp.lst()
    for (let x of xs) {
      if (x[0] === ImpT.SEP) { args.push(arg); arg = imp.lst() }
      else imp.push(arg,x)}
    args.push(arg)
    // Need to evaluate all args first, then apply
    let evaluatedArgs = []
    for (let a of args) {
      evaluatedArgs.push(await this.lastEval(a))
    }
    return await f[2].apply(this, evaluatedArgs)}

  // evaluate an expression
  eval = async (x: ImpVal): Promise<ImpVal> => {
    switch (x[0]) {
      case ImpT.TOP: return await this.lastEval(x)
      case ImpT.SEP: return NIL
      case ImpT.NIL: return x
      case ImpT.INT: return x
      case ImpT.NUM: return x
      case ImpT.STR: return x
      case ImpT.MLS: return x
      case ImpT.SYM: return x
      case ImpT.LST:
        let [_, a, v] = x
        let m = (a.open||'[').match(/^(.+)([[({])$/)
        if (m) { let sym = m[1]; switch (m[2]) {
          case '[': return await this.project(sym, v)
          // case '(': TODO
          // case '{': TODO
          default: return imp.lst(a, await this.evalList(x))}}
        else return imp.lst(a, await this.evalList(x))
      default: throw "invalid imp value:" + JSON.stringify(x) }}}

export let impEval = async (x: ImpTop | ImpErr): Promise<ImpVal> =>
  ImpQ.isTop(x) ? await new ImpEvaluator(x[2]).eval(x) : x
