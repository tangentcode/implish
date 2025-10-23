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
import {load} from './imp-load.mjs'
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

// Helper function to get numeric value from INT, NUM, or vector types
function getNum(x: ImpVal): number | number[] {
  if (x[0] === ImpT.INT || x[0] === ImpT.NUM) return x[2] as number
  if (x[0] === ImpT.INTs || x[0] === ImpT.NUMs) return x[2] as number[]
  throw "expected number or vector, got: " + x[0]
}

// Helper function to apply binary operation element-wise
function elemWise(op: (a: number, b: number) => number, x: ImpVal, y: ImpVal): ImpVal {
  let xVal = getNum(x)
  let yVal = getNum(y)

  // Both scalars
  if (typeof xVal === 'number' && typeof yVal === 'number') {
    return ImpC.int(op(xVal, yVal))
  }

  // x is scalar, y is vector
  if (typeof xVal === 'number' && Array.isArray(yVal)) {
    return ImpC.ints(yVal.map(b => op(xVal, b)))
  }

  // x is vector, y is scalar
  if (Array.isArray(xVal) && typeof yVal === 'number') {
    return ImpC.ints(xVal.map(a => op(a, yVal)))
  }

  // Both vectors - element-wise (must be same length)
  if (Array.isArray(xVal) && Array.isArray(yVal)) {
    if (xVal.length !== yVal.length) throw "vector length mismatch"
    return ImpC.ints(xVal.map((a, i) => op(a, yVal[i])))
  }

  throw "invalid operands"
}

export let impWords: Record<string, ImpVal> = {
  'nil': NIL,
  '+'   : imp.jdy((x,y)=>elemWise((a,b)=>a+b, x, y)),
  '-'   : imp.jdy((x,y)=>elemWise((a,b)=>a-b, x, y)),
  '*'   : imp.jdy((x,y)=>elemWise((a,b)=>a*b, x, y)),
  '%'   : imp.jdy((x,y)=>elemWise((a,b)=>Math.floor(a/b), x, y)),
  '!'   : imp.jsf(x=>{
    let n = x[2] as number
    if (n < 0) throw "! requires non-negative integer"
    if (n === 0) return ImpC.nums([])
    return ImpC.nums(Array.from({length: n}, (_, i) => i))
  }, 1),
  'rd': imp.jsf(async x=>ImpC.str(await readContent(x)), 1),
  'load': imp.jsf(async x=>{
    // If x is a FILE symbol, read it first (load %path == load rd %path)
    if (ImpQ.isSym(x) && x[1].kind === SymT.FILE) {
      x = ImpC.str(await readContent(x))}
    return load(x as ImpStr)}, 1),
  'xmls': imp.jsf(x=>ImpC.str(toXml(x) as string), 1),
  'look': imp.jsf(x=>ImpC.str(impShow(impWords[(x[2] as string)] ?? NIL)), 1),
  'eval': imp.jsf(x=>eval(x[2] as string), 1),
  'part': imp.jsf(x=>ImpC.str(wordClass(x)), 1),
  'type?': imp.jsf(x=>{
    // Map ImpT enum to type symbol name
    let typeName = x[0].toLowerCase()
    return ImpC.sym(Symbol(typeName), SymT.TYP)
  }, 1),
  'show': imp.jsf(x=>ImpC.str(impShow(x)), 1),
  'echo': imp.jsf(x=>{
    // For vectors/strands, use impShow; for other types, print the raw value
    if (x[0] === ImpT.INTs || x[0] === ImpT.NUMs || x[0] === ImpT.SYMs) {
      console.log(impShow(x))
    } else {
      console.log(x[2])
    }
    return NIL
  }, 1),
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
      const kindNames = ['raw', 'set', 'get', 'lit', 'refn', 'ish', 'path', 'file', 'url', 'bqt', 'typ', 'ann', 'msg', 'kw', 'msg2', 'kw2', 'err', 'unq']
      attrs.k = kindNames[x[1].kind]
    }
    attrs.v = `${x[2].description}`
    return xmlTag('imp:sym', attrs)
  }
  if (ImpQ.isLst(x) || x[0] === ImpT.TOP) {
    return xmlTag('imp:' + x[0].toLowerCase(), x[1]??{},
      '\n  ' + x[2].map(toXml).join('\n  ') + '\n')}
  // Handle vector types
  if (x[0] === ImpT.INTs || x[0] === ImpT.NUMs) {
    return xmlTag('imp:' + x[0].toLowerCase(), {v: (x[2] as number[]).join(' ')})
  }
  if (x[0] === ImpT.SYMs) {
    return xmlTag('imp:' + x[0].toLowerCase(), {v: (x[2] as symbol[]).map(s => s.description).join(' ')})
  }
  // For other types (SEP, INT, STR, MLS, JSF, JDY, END), treat as simple values
  return xmlTag('imp:' + x[0].toLowerCase(), {v: (x[2]??'').toString()})}

function wordClass(x:ImpVal) {
    let [xt, _xa, _xv] = x
    switch (xt) {
      case ImpT.TOP: return ImpP.N
      case ImpT.END: return ImpP.E
      case ImpT.SEP: return ImpP.E  // Treat separator as end-like (stops collection)
      case ImpT.INT: return ImpP.N
      case ImpT.NUM: return ImpP.N
      case ImpT.STR: return ImpP.N
      case ImpT.MLS: return ImpP.N
      case ImpT.LST: return ImpP.N
      case ImpT.INTs: return ImpP.N
      case ImpT.NUMs: return ImpP.N
      case ImpT.SYMs: return ImpP.N
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
    // if next token is infix operator (dyad), apply it to x and the next noun/strand
    let res = x
    while (this.peek()?.wc === ImpP.O) {
      let op = this.nextItem() as ImpJdy
      // Collect the right operand, which might be a strand
      let arg = await this.collectStrand()
      res = await op[2].apply(this, [res, arg]) }
    return res }

  // Helper: extend a value into a strand by collecting following items
  // - firstItem: the already-obtained first item (evaluated or raw)
  // - evaluated: if true, items are already evaluated; if false, call eval on each
  private extendStrand = async (firstItem: ImpVal, evaluated: boolean): Promise<ImpVal> => {
    let strand: ImpVal[] = [firstItem]
    let strandType: ImpT | null = null

    // Determine if we should collect a strand
    if (firstItem[0] === ImpT.INT) strandType = ImpT.INTs
    else if (firstItem[0] === ImpT.NUM) strandType = ImpT.NUMs
    else if (firstItem[0] === ImpT.SYM && (firstItem as any)[1].kind === SymT.BQT) strandType = ImpT.SYMs

    if (strandType) {
      // Keep collecting matching items until we hit a separator, operator, or end
      while (true) {
        let p = this.peek()
        if (!p || (p.wc !== ImpP.N && p.wc !== ImpP.Q)) break

        // Check if next item matches strand type
        let nextType = p.item[0]
        let matches = false
        if (strandType === ImpT.INTs && nextType === ImpT.INT && p.wc === ImpP.N) matches = true
        else if (strandType === ImpT.NUMs && (nextType === ImpT.NUM || nextType === ImpT.INT) && p.wc === ImpP.N) {
          // Allow mixing INT and NUM in a NUM strand
          matches = true
        }
        else if (strandType === ImpT.SYMs && nextType === ImpT.SYM &&
                 (p.item as any)[1].kind === SymT.BQT && p.wc === ImpP.Q) matches = true

        if (!matches) break

        // Add to strand
        this.keep(p)
        let item = evaluated ? await this.eval(p.item) : p.item
        strand.push(item)

        // If we found a NUM in an INT strand, upgrade to NUM strand
        if (strandType === ImpT.INTs && nextType === ImpT.NUM) strandType = ImpT.NUMs
      }

      // If we collected more than one item, return a vector
      if (strand.length > 1) {
        if (strandType === ImpT.INTs) {
          return ImpC.ints(strand.map(x => x[2] as number))
        } else if (strandType === ImpT.NUMs) {
          return ImpC.nums(strand.map(x => x[2] as number))
        } else if (strandType === ImpT.SYMs) {
          return ImpC.syms(strand.map(x => x[2] as symbol))
        }
      }
    }

    return firstItem
  }

  // Helper to collect a strand (number or symbol vector)
  collectStrand = async (): Promise<ImpVal> => {
    let res = this.nextItem()
    if (this.wc !== ImpP.N && this.wc !== ImpP.Q) throw "expected a noun, got: " + res
    return await this.extendStrand(res, false)
  }

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
      // Collect any following strand items, then apply infix operators
      value = await this.extendStrand(value, true)
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
    // Collect a strand, then apply any infix operators
    let res = await this.collectStrand()
    res = await this.modifyNoun(res)
    return res
  }

  wordClass = (x: ImpVal): ImpP => wordClass(x)

  // Evaluate quasiquoted expressions - walk the tree and evaluate unquoted items
  quasiquote = async (x: ImpVal): Promise<ImpVal> => {
    // If it's a symbol with UNQ kind, evaluate it
    if (ImpQ.isSym(x) && x[1].kind === SymT.UNQ) {
      // Look up the symbol (without the comma prefix)
      let w = this.words[x[2].description!]
      if (!w) throw "undefined word: " + x[2].description
      let result = await this.eval(w)
      // If the result is a LIT or BQT symbol, strip the quote marker
      if (ImpQ.isSym(result) && (result[1].kind === SymT.LIT || result[1].kind === SymT.BQT)) {
        return ImpC.sym(result[2], SymT.RAW)
      }
      return result
    }
    // If it's a list, recursively quasiquote its contents
    if (ImpQ.isLst(x)) {
      let results: ImpVal[] = []
      for (let item of x[2]) {
        results.push(await this.quasiquote(item))
      }
      // Strip the backtick from the opener to return an unquoted list
      let newOpen = x[1].open.startsWith('`') ? x[1].open.slice(1) : x[1].open
      return imp.lst({open: newOpen, close: x[1].close}, results)
    }
    // For all other values, return as-is
    return x
  }

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
          // Evaluate the noun, collect any following strand, then apply operators
          x = await this.eval(x)
          x = await this.extendStrand(x, true)
          x = await this.modifyNoun(x)
          tb.emit(x)
          break
        case ImpP.Q:
          // Collect strands of backtick symbols
          if (ImpQ.isSym(x) && (x as any)[1].kind === SymT.BQT) {
            let strand: ImpVal[] = [x]
            // Keep collecting matching backtick symbols
            while (true) {
              let p = this.peek()
              if (!p || p.wc !== ImpP.Q) break
              if (!ImpQ.isSym(p.item) || (p.item as any)[1].kind !== SymT.BQT) break

              // Add to strand
              this.keep(p)
              strand.push(p.item)
            }

            // If we collected more than one item, return a symbol vector
            if (strand.length > 1) {
              x = ImpC.syms(strand.map(s => s[2] as symbol))
            }
          }
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
      case ImpT.INTs: return x
      case ImpT.NUMs: return x
      case ImpT.SYMs: return x
      case ImpT.LST:
        let [_, a, v] = x
        // Check if list is quoted (starts with ' or `)
        let opener = a.open || '['
        if (opener.startsWith("`")) {
          // Backtick is quasiquotation - evaluate unquoted items
          return await this.quasiquote(x)
        }
        if (opener.startsWith("'")) {
          // Single quote strips one layer - return list with quote removed
          let newOpen = opener.slice(1)
          return imp.lst({open: newOpen, close: a.close}, v)
        }
        let m = opener.match(/^(.+)([[({])$/)
        if (m) { let sym = m[1]; switch (m[2]) {
          case '[': return await this.project(sym, v)
          // case '(': TODO
          // case '{': TODO
          default: return imp.lst(a, await this.evalList(x))}}
        else return imp.lst(a, await this.evalList(x))
      default: throw "invalid imp value:" + JSON.stringify(x) }}}

export let impEval = async (x: ImpTop | ImpErr): Promise<ImpVal> =>
  ImpQ.isTop(x) ? await new ImpEvaluator(x[2]).eval(x) : x
