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
  JSF,
  ImpJsf,
  ImpJsfA,
  ImpIfn,
  ImpIfnA,
  ImpStr, ImpC, ImpTop, ImpErr, ImpLst
} from './imp-core.mjs'
import {impShow} from './imp-show.mjs'
import {load} from './imp-load.mjs'
import {toNativePath} from './lib-file.mjs'
import * as assert from "assert"
import * as fs from "fs"
import * as https from "https"
import * as http from "http"

// Helper: read file or URL content as string (async)
async function readContent(x: ImpVal): Promise<string> {
  // Check if it's a FILE symbol
  if (ImpQ.isSym(x) && x[1].kind === SymT.FILE) {
    let filepath = toNativePath(x[2].description!)

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

// Identity values for fold operations (for empty arrays)
const foldIdentities: Record<string, number> = {
  '+': 0,
  '*': 1,
  'min': Infinity,
  'max': -Infinity,
}

export let impWords: Record<string, ImpVal> = {
  'nil': NIL,
  '+'   : imp.jsf((x,y)=>elemWise((a,b)=>a+b, x, y), 2),
  '-'   : imp.jsf((x,y)=>elemWise((a,b)=>a-b, x, y), 2),
  '*'   : imp.jsf((x,y)=>elemWise((a,b)=>a*b, x, y), 2),
  '%'   : imp.jsf((x,y)=>elemWise((a,b)=>Math.floor(a/b), x, y), 2),
  '^'   : imp.jsf((x,y)=>elemWise((a,b)=>Math.pow(a,b), x, y), 2),
  'min' : imp.jsf((x,y)=>elemWise((a,b)=>Math.min(a,b), x, y), 2),
  'max' : imp.jsf((x,y)=>elemWise((a,b)=>Math.max(a,b), x, y), 2),
  'tk'  : imp.jsf((x,y)=> {
    // x tk y: take x items from y, with repeats/cycling
    // x must be a scalar integer
    if (x[0] !== ImpT.INT) {
      throw "tk left argument must be an integer"
    }
    let count = x[2] as number

    // Handle y as string - cycle through characters
    if (y[0] === ImpT.STR) {
      let str = y[2] as string
      if (str.length === 0) {
        throw "tk cannot take from empty string"
      }
      let result = ""
      for (let i = 0; i < count; i++) {
        result += str[i % str.length]
      }
      return ImpC.str(result)
    }

    // Handle y as list - cycle through elements
    if (y[0] === ImpT.LST) {
      let vals = y[2] as ImpVal[]
      if (vals.length === 0) {
        throw "tk cannot take from empty list"
      }
      let result: ImpVal[] = []
      for (let i = 0; i < count; i++) {
        result.push(vals[i % vals.length])
      }
      return imp.lst(y[1], result)
    }

    // Handle y as numeric scalar - repeat it
    if (y[0] === ImpT.INT) {
      let val = y[2] as number
      return ImpC.ints(Array(count).fill(val))
    }
    if (y[0] === ImpT.NUM) {
      let val = y[2] as number
      return ImpC.nums(Array(count).fill(val))
    }

    // Handle y as numeric vector
    if (y[0] === ImpT.INTs) {
      let vals = y[2] as number[]
      if (vals.length === 0) {
        throw "tk cannot take from empty array"
      }
      let result: number[] = []
      for (let i = 0; i < count; i++) {
        result.push(vals[i % vals.length])
      }
      return ImpC.ints(result)
    }
    if (y[0] === ImpT.NUMs) {
      let vals = y[2] as number[]
      if (vals.length === 0) {
        throw "tk cannot take from empty array"
      }
      let result: number[] = []
      for (let i = 0; i < count; i++) {
        result.push(vals[i % vals.length])
      }
      return ImpC.nums(result)
    }

    // For any other scalar type, repeat it in a list
    let result: ImpVal[] = []
    for (let i = 0; i < count; i++) {
      result.push(y)
    }
    return imp.lst(undefined, result)
  }, 2),
  'rev': imp.jsf(x => {
    if (x[0] === ImpT.INTs) {
      let nums = x[2] as number[]
      return ImpC.ints([...nums].reverse())
    }
    if (x[0] === ImpT.NUMs) {
      let nums = x[2] as number[]
      return ImpC.nums([...nums].reverse())
    }
    if (x[0] === ImpT.SYMs) {
      let syms = x[2] as symbol[]
      return ImpC.syms([...syms].reverse())
    }
    if (ImpQ.isLst(x)) {
      return imp.lst(x[1], [...x[2]].reverse())
    }
    throw "rev expects a vector (INTs, NUMs, SYMs) or list (LST)"
  }, 1),
  'len': imp.jsf(x => {
    if (x[0] === ImpT.INTs || x[0] === ImpT.NUMs || x[0] === ImpT.SYMs) {
      return ImpC.int((x[2] as any[]).length)
    }
    if (ImpQ.isLst(x)) {
      return ImpC.int(x[2].length)
    }
    if (x[0] === ImpT.STR) {
      return ImpC.int((x[2] as string).length)
    }
    // Scalars have length 1
    if (x[0] === ImpT.INT || x[0] === ImpT.NUM || x[0] === ImpT.SYM) {
      return ImpC.int(1)
    }
    throw "len expects a number, symbol, vector, list, or string"
  }, 1),
  '!'   : imp.jsf(x=>{
    let n = x[2] as number
    if (n < 0) throw "! requires non-negative integer"
    if (n === 0) return ImpC.nums([])
    return ImpC.nums(Array.from({length: n}, (_, i) => i))
  }, 1),
  'rd': imp.jsf(async x=>ImpC.str(await readContent(x)), 1),
  'wr': imp.jsf(async (file, content)=>{
    // file should be a FILE symbol or string
    let filepath: string
    if (ImpQ.isSym(file) && file[1].kind === SymT.FILE) {
      filepath = toNativePath(file[2].description!)
    } else if (file[0] === ImpT.STR) {
      filepath = toNativePath(file[2] as string)
    } else {
      throw 'wr expects a %file or string filepath as first argument'
    }

    // content should be a string
    if (content[0] !== ImpT.STR) {
      throw 'wr expects a string as second argument'
    }
    let text = content[2] as string

    try {
      fs.writeFileSync(filepath, text, 'utf8')
      return NIL
    } catch (e: any) {
      throw `Failed to write file: ${filepath} - ${e.message}`
    }
  }, 2),
  'e?': imp.jsf(x=>{
    // file should be a FILE symbol or string
    let filepath: string
    if (ImpQ.isSym(x) && x[1].kind === SymT.FILE) {
      filepath = toNativePath(x[2].description!)
    } else if (x[0] === ImpT.STR) {
      filepath = toNativePath(x[2] as string)
    } else {
      throw 'e? expects a %file or string filepath'
    }

    try {
      fs.accessSync(filepath, fs.constants.F_OK)
      return ImpC.int(1)
    } catch (e) {
      return ImpC.int(0)
    }
  }, 1),
  'rm': imp.jsf(x=>{
    // file should be a FILE symbol or string
    let filepath: string
    if (ImpQ.isSym(x) && x[1].kind === SymT.FILE) {
      filepath = toNativePath(x[2].description!)
    } else if (x[0] === ImpT.STR) {
      filepath = toNativePath(x[2] as string)
    } else {
      throw 'rm expects a %file or string filepath'
    }

    try {
      fs.unlinkSync(filepath)
      return NIL
    } catch (e: any) {
      throw `Failed to remove file: ${filepath} - ${e.message}`
    }
  }, 1),
  'load': imp.jsf(async x=>{
    // If x is a FILE symbol, read it first (load %path == load rd %path)
    if (ImpQ.isSym(x) && x[1].kind === SymT.FILE) {
      x = ImpC.str(await readContent(x))}
    return load(x as ImpStr)}, 1),
  'xmls': imp.jsf(x=>ImpC.str(toXml(x) as string), 1),
  'look': imp.jsf(x=>ImpC.str(impShow(impWords[(x[2] as string)] ?? NIL)), 1),
  'eval': imp.jsf(x=>eval(x[2] as string), 1),
  'part': imp.jsf(x=>{
    // If x is a string or symbol, look up the word in impWords
    let val = x
    if (x[0] === ImpT.STR) {
      val = impWords[x[2] as string] ?? x
    } else if (ImpQ.isSym(x)) {
      val = impWords[(x[2] as symbol).description ?? ''] ?? x
    }
    return ImpC.str(wordClass(val))
  }, 1),
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
  'words': imp.jsf(()=>{
    // Return all defined word names as a SYMs vector
    return ImpC.syms(Object.keys(impWords).map(w => Symbol(w)))
  }, 0),
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

// Scan AST for implicit parameters x, y, z to determine function arity
// Does NOT scan inside nested curly brace functions
function scanArity(body: ImpVal[]): number {
  let hasZ = false, hasY = false, hasX = false

  function scan(x: ImpVal): void {
    // If it's a RAW symbol, check if it's x, y, or z
    if (ImpQ.isSym(x) && x[1].kind === SymT.RAW) {
      let name = x[2].description!
      if (name === 'z') hasZ = true
      else if (name === 'y') hasY = true
      else if (name === 'x') hasX = true
    }
    // If it's a GET symbol (:x, :y, :z), also count those
    else if (ImpQ.isSym(x) && x[1].kind === SymT.GET) {
      let name = x[2].description!
      if (name === 'z') hasZ = true
      else if (name === 'y') hasY = true
      else if (name === 'x') hasX = true
    }
    // Recursively scan lists, but NOT curly brace lists (nested functions)
    else if (ImpQ.isLst(x)) {
      // Skip if this is a curly brace list (nested function)
      if (x[1].open === '{') return
      // Otherwise scan the contents
      for (let item of x[2]) scan(item)
    }
    // Also scan TOP nodes
    else if (ImpQ.isTop(x)) {
      for (let item of x[2]) scan(item)
    }
  }

  for (let item of body) scan(item)

  if (hasZ) return 3
  if (hasY) return 2
  if (hasX) return 1
  return 0
}

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
      case ImpT.SYM: return ImpP.N
      case ImpT.LST: return ImpP.N
      case ImpT.INTs: return ImpP.N
      case ImpT.NUMs: return ImpP.N
      case ImpT.SYMs: return ImpP.N
      // -- resolved symbols:
      case ImpT.JSF: return ImpP.V
      case ImpT.IFN: return ImpP.V
      case ImpT.NIL: return ImpP.N
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
          let name = x[2].description!
          let w = this.words[name]

          // If not found and ends with '/' or '\', try to create a fold/scan operator
          if (!w && (name.endsWith('/') || name.endsWith('\\'))) {
            let baseName = name.slice(0, -1)
            let baseOp = this.words[baseName]

            if (baseOp && (baseOp[0] === ImpT.JSF && baseOp[1].arity === 2)) {
              // Create and cache the fold or scan operator
              if (name.endsWith('/')) {
                w = this.createFoldOperator(baseName, baseOp)
              } else {
                w = this.createScanOperator(baseName, baseOp)
              }
              this.words[name] = w
            }
          }

          if (w) x = w, this.wc = this.wordClass(w)
          else throw "undefined word: " + name
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
    // Check if next token is an arity-2 verb (works as infix operator)
    let res = x
    while (true) {
      let p = this.peek()
      if (!p || p.wc !== ImpP.V) break

      // Check if it's an arity-2 verb (can be used infix)
      let arity = 0
      if (p.item[0] === ImpT.JSF) {
        arity = (p.item as ImpJsf)[1].arity
      } else if (p.item[0] === ImpT.IFN) {
        arity = (p.item as ImpIfn)[1].arity
      }

      if (arity !== 2) break  // Not an arity-2 verb, stop

      // Consume the verb
      let op = this.nextItem()

      // Collect the right operand - could be a noun/strand or a verb application
      let arg: ImpVal
      let p2 = this.peek()
      if (p2?.wc === ImpP.V) {
        // Handle verb application (e.g., in "2 ^ ! 4", the "! 4" part)
        let v = this.nextItem()
        if (v[0] === ImpT.JSF) {
          v = this.modifyVerb(v as ImpJsf)
        }
        let args = []
        let vArity = (v[1] as ImpJsfA | ImpIfnA).arity
        for (let i = 0; i < vArity; i++) {
          args.push(await this.nextNoun())
        }
        if (v[0] === ImpT.IFN) {
          arg = await this.applyIfn(v as ImpIfn, args)
        } else {
          arg = await (v as ImpJsf)[2].apply(this, args)
        }
      } else {
        // Handle simple noun/strand
        arg = await this.collectStrand()
      }

      // Apply the arity-2 verb
      if (op[0] === ImpT.IFN) {
        res = await this.applyIfn(op as ImpIfn, [res, arg])
      } else {
        res = await (op as ImpJsf)[2].apply(this, [res, arg])
      }
    }
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
    // Skip separators (commas are used to separate function arguments)
    while (res[0] === ImpT.SEP && res[2] === ',') {
      res = this.nextItem()
    }
    // Check for END (ran out of input)
    if (res[0] === ImpT.END) {
      throw "unexpected end of input (missing argument?)"
    }
    // Handle different word classes
    if (this.wc === ImpP.S) {
      // Assignment - evaluate and return the assigned value
      return await this.doAssign(res)
    } else if (this.wc === ImpP.G) {
      // Get-word - look up and evaluate the variable
      if (!ImpQ.isSym(res)) throw "get-word must be a symbol"
      let varName = res[2].description!
      let value = this.words[varName]
      if (!value) throw "undefined word: " + varName
      return await this.eval(value)
    } else if (this.wc === ImpP.V) {
      // Handle verb directly (e.g., `{x * 2} ! 10`)
      if (res[0] === ImpT.JSF) {
        res = this.modifyVerb(res as ImpJsf)
      }
      let args = []
      // Get arity from function metadata
      let arity = (res[1] as ImpJsfA | ImpIfnA).arity
      // Collect arguments, stopping if we hit END
      for (let i = 0; i < arity; i++) {
        if (this.atEnd()) break
        try {
          args.push(await this.nextNoun())
        } catch (e) {
          // If we can't get an argument (e.g., hit END), stop collecting
          if (String(e).includes("unexpected end of input")) break
          throw e
        }
      }
      // Handle partial application
      if (res[0] === ImpT.IFN) {
        return await this.applyIfn(res as ImpIfn, args)
      } else {
        // JSF - check if we need partial application
        if (args.length < arity) {
          // Create partial application
          let partialArity = arity - args.length
          let capturedArgs = args
          let originalFn = res as ImpJsf
          return [ImpT.JSF, {
            arity: partialArity,
            sourceIfn: originalFn,
            capturedArgs: capturedArgs
          }, async (...remainingArgs: ImpVal[]) => {
            return await originalFn[2].apply(this, [...capturedArgs, ...remainingArgs])
          }]
        } else {
          return await (res as ImpJsf)[2].apply(this, args)
        }
      }
    } else if (this.wc !== ImpP.N && this.wc !== ImpP.Q) {
      throw "expected a noun, got: " + impShow(res)
    }
    // Evaluate the noun first, then check for strands
    res = await this.eval(res)
    return await this.extendStrand(res, true)
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
    } else if (this.wc === ImpP.G) {
      // Get-word - look up value without evaluation
      if (!ImpQ.isSym(nextX)) throw "get-word must be a symbol"
      let getVarName = nextX[2].description!
      value = this.words[getVarName]
      if (!value) throw "undefined word: " + getVarName
    } else if (this.wc === ImpP.N) {
      value = await this.eval(nextX)
      // Collect any following strand items, then apply infix operators
      value = await this.extendStrand(value, true)
      value = await this.modifyNoun(value)
    } else if (this.wc === ImpP.V) {
      // Apply verb modifiers (composition, etc.) only to JSF for now
      if (nextX[0] === ImpT.JSF) {
        nextX = this.modifyVerb(nextX as ImpJsf)
      }
      let args = []
      // Get arity from function metadata
      let arity = (nextX[1] as ImpJsfA | ImpIfnA).arity
      // Collect arguments, stopping if we hit END
      for (let i = 0; i < arity; i++) {
        if (this.atEnd()) break
        try {
          args.push(await this.nextNoun())
        } catch (e) {
          // If we can't get an argument (e.g., hit END), stop collecting
          if (String(e).includes("unexpected end of input")) break
          throw e
        }
      }
      // Handle partial application
      if (nextX[0] === ImpT.IFN) {
        value = await this.applyIfn(nextX as ImpIfn, args)
      } else {
        // JSF - check if we need partial application
        if (args.length < arity) {
          // Create partial application
          let partialArity = arity - args.length
          let capturedArgs = args
          let originalFn = nextX as ImpJsf
          value = [ImpT.JSF, {
            arity: partialArity,
            sourceIfn: originalFn,
            capturedArgs: capturedArgs
          }, async (...remainingArgs: ImpVal[]) => {
            return await originalFn[2].apply(this, [...capturedArgs, ...remainingArgs])
          }]
        } else {
          value = await (nextX as ImpJsf)[2].apply(this, args)
        }
      }
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

  // Execute an IFN with bound parameters
  applyIfn = async (fn: ImpIfn, args: ImpVal[]): Promise<ImpVal> => {
    // If fewer args than arity, return a partial application
    if (args.length < fn[1].arity) {
      // Create a new function that captures the provided args
      let partialArity = fn[1].arity - args.length
      let capturedArgs = args
      let originalFn = fn

      // Wrap the original function with partial application logic
      let jsf: ImpJsf = [ImpT.JSF, {
        arity: partialArity,
        sourceIfn: originalFn,
        capturedArgs: capturedArgs
      }, async (...remainingArgs: ImpVal[]) => {
        return await this.applyIfn(originalFn, [...capturedArgs, ...remainingArgs])
      }]
      return jsf
    }

    if (args.length !== fn[1].arity) {
      throw `IFN arity mismatch: expected ${fn[1].arity}, got ${args.length}`
    }

    // Save current word bindings for x, y, z
    let savedX = this.words['x']
    let savedY = this.words['y']
    let savedZ = this.words['z']

    // Bind parameters
    if (args.length >= 1) this.words['x'] = args[0]
    if (args.length >= 2) this.words['y'] = args[1]
    if (args.length >= 3) this.words['z'] = args[2]

    // Execute body
    let body: ImpLst = imp.lst({open: '{', close: '}'}, fn[2])
    let result = await this.lastEval(body)

    // Restore word bindings
    if (savedX !== undefined) this.words['x'] = savedX
    else delete this.words['x']
    if (savedY !== undefined) this.words['y'] = savedY
    else delete this.words['y']
    if (savedZ !== undefined) this.words['z'] = savedZ
    else delete this.words['z']

    return result
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

  // Create a fold operator from a dyadic function (JSF with arity 2 or JDY)
  createFoldOperator = (baseName: string, baseOp: ImpVal): ImpVal => {
    return imp.jsf(async x => {
      // Handle scalar input - just return it
      if (x[0] === ImpT.INT || x[0] === ImpT.NUM) {
        return x
      }

      // Extract the numeric array based on type
      if (x[0] !== ImpT.INTs && x[0] !== ImpT.NUMs) {
        throw `${baseName}/ expects a numeric value or vector (INT, NUM, INTs, or NUMs)`
      }

      let nums = x[2] as number[]
      let isInts = x[0] === ImpT.INTs

      // Handle empty array - return identity value if defined
      if (nums.length === 0) {
        let identity = foldIdentities[baseName]
        if (identity === undefined) {
          throw `${baseName}/ has no identity value for empty arrays`
        }
        return isInts ? ImpC.int(identity) : ImpC.num(identity)
      }

      // Handle single element
      if (nums.length === 1) {
        return x
      }

      // Get the dyadic function (JSF with arity 2)
      if (baseOp[0] !== ImpT.JSF || baseOp[1].arity !== 2) {
        throw `${baseName}/ requires a JSF with arity 2`
      }
      let dyadicFn = baseOp[2] as (x: ImpVal, y: ImpVal) => ImpVal | Promise<ImpVal>

      // Perform the fold operation
      let result = nums[0]
      for (let i = 1; i < nums.length; i++) {
        let xVal = isInts ? ImpC.int(result) : ImpC.num(result)
        let yVal = isInts ? ImpC.int(nums[i]) : ImpC.num(nums[i])
        let folded = dyadicFn(xVal, yVal)

        // Handle async operations
        if (folded instanceof Promise) {
          folded = await folded as ImpVal
        }

        // Extract the numeric result
        if (folded[0] === ImpT.INT) {
          result = folded[2] as number
        } else if (folded[0] === ImpT.NUM) {
          result = folded[2] as number
          isInts = false  // If we get a NUM, result should be NUM
        } else {
          throw `${baseName}/ produced non-numeric result`
        }
      }

      return isInts ? ImpC.int(result) : ImpC.num(result)
    }, 1)
  }

  // Create a scan operator from a dyadic function (JSF with arity 2 or JDY)
  // Returns all intermediate results of the fold operation
  createScanOperator = (baseName: string, baseOp: ImpVal): ImpVal => {
    return imp.jsf(async x => {
      // Handle scalar input - return as single-element vector
      if (x[0] === ImpT.INT) {
        return ImpC.ints([x[2] as number])
      }
      if (x[0] === ImpT.NUM) {
        return ImpC.nums([x[2] as number])
      }

      // Extract the numeric array based on type
      if (x[0] !== ImpT.INTs && x[0] !== ImpT.NUMs) {
        throw `${baseName}\\ expects a numeric value or vector (INT, NUM, INTs, or NUMs)`
      }

      let nums = x[2] as number[]
      let isInts = x[0] === ImpT.INTs

      // Handle empty array - return empty array or identity value
      if (nums.length === 0) {
        let identity = foldIdentities[baseName]
        if (identity === undefined) {
          return x  // Return empty array as-is
        }
        return isInts ? ImpC.ints([identity]) : ImpC.nums([identity])
      }

      // Handle single element - return as-is
      if (nums.length === 1) {
        return x
      }

      // Get the dyadic function (JSF with arity 2)
      if (baseOp[0] !== ImpT.JSF || baseOp[1].arity !== 2) {
        throw `${baseName}\\ requires a JSF with arity 2`
      }
      let dyadicFn = baseOp[2] as (x: ImpVal, y: ImpVal) => ImpVal | Promise<ImpVal>

      // Perform the scan operation - collect all intermediate results
      let results: number[] = [nums[0]]
      let result = nums[0]

      for (let i = 1; i < nums.length; i++) {
        let xVal = isInts ? ImpC.int(result) : ImpC.num(result)
        let yVal = isInts ? ImpC.int(nums[i]) : ImpC.num(nums[i])
        let folded = dyadicFn(xVal, yVal)

        // Handle async operations
        if (folded instanceof Promise) {
          folded = await folded as ImpVal
        }

        // Extract the numeric result
        if (folded[0] === ImpT.INT) {
          result = folded[2] as number
        } else if (folded[0] === ImpT.NUM) {
          result = folded[2] as number
          isInts = false  // If we get a NUM, result should be NUM
        } else {
          throw `${baseName}\\ produced non-numeric result`
        }

        results.push(result)
      }

      return isInts ? ImpC.ints(results) : ImpC.nums(results)
    }, 1)
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
          // Apply verb modifiers (composition, etc.) only to JSF for now
          if (x[0] === ImpT.JSF) {
            x = this.modifyVerb(x as ImpJsf)
          }
          let args = []
          // Get arity from function metadata
          let arity = (x[1] as ImpJsfA | ImpIfnA).arity
          // Collect arguments, stopping if we hit END
          for (let i = 0; i < arity; i++) {
            if (this.atEnd()) break
            try {
              args.push(await this.nextNoun())
            } catch (e) {
              // If we can't get an argument (e.g., hit END), stop collecting
              if (String(e).includes("unexpected end of input")) break
              throw e
            }
          }
          // Handle partial application for IFN
          if (x[0] === ImpT.IFN) {
            tb.emit(await this.applyIfn(x as ImpIfn, args))
          } else {
            // JSF - check if we need partial application
            if (args.length < arity) {
              // Create partial application
              let partialArity = arity - args.length
              let capturedArgs = args
              let originalFn = x as ImpJsf
              let jsf: ImpJsf = [ImpT.JSF, {
                arity: partialArity,
                sourceIfn: originalFn,
                capturedArgs: capturedArgs
              }, async (...remainingArgs: ImpVal[]) => {
                return await originalFn[2].apply(this, [...capturedArgs, ...remainingArgs])
              }]
              tb.emit(jsf)
            } else {
              tb.emit(await (x as ImpJsf)[2].apply(this, args))
            }
          }
          break
        case ImpP.N:
          // Evaluate the noun, collect any following strand, then apply operators
          x = await this.eval(x)
          // Check if evaluation produced a verb (e.g., {x * 2} → IFN)
          if (this.wordClass(x) === ImpP.V) {
            // Apply verb modifiers (composition, etc.) only to JSF for now
            if (x[0] === ImpT.JSF) {
              x = this.modifyVerb(x as ImpJsf)
            }
            let args = []
            // Get arity from function metadata
            let arity = (x[1] as ImpJsfA | ImpIfnA).arity
            for (let i = 0; i < arity; i++) { args.push(await this.nextNoun()) }
            if (x[0] === ImpT.IFN) {
              tb.emit(await this.applyIfn(x as ImpIfn, args))
            } else {
              tb.emit(await (x as ImpJsf)[2].apply(this, args))
            }
          } else {
            x = await this.extendStrand(x, true)
            x = await this.modifyNoun(x)
            tb.emit(x)
          }
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
        case ImpP.G: // get-word (return value without evaluation)
          if (!ImpQ.isSym(x)) throw "get-word must be a symbol"
          let varName = x[2].description!
          let value = this.words[varName]
          if (!value) throw "undefined word: " + varName
          tb.emit(value)
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
    let f: ImpVal | undefined = this.words[sym]
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
    // Check if it's a user-defined function (IFN) or JavaScript function (JSF)
    if (f[0] === ImpT.IFN) {
      return await this.applyIfn(f as ImpIfn, evaluatedArgs)
    } else if (f[0] === ImpT.JSF) {
      return await (f as ImpJsf)[2].apply(this, evaluatedArgs)
    } else {
      throw "[project]: not a function: " + sym
    }
  }

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
        // Handle curly braces as function definitions
        if (opener === '{') {
          let arity = scanArity(v)
          return ImpC.ifn(arity, v)
        }
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
        else {
          // For parentheses, return the last evaluated value (not wrapped in a list)
          if (opener === '(') {
            return await this.lastEval(x)
          }
          return imp.lst(a, await this.evalList(x))
        }
      default: throw "invalid imp value:" + JSON.stringify(x) }}}

export let impEval = async (x: ImpTop | ImpErr): Promise<ImpVal> =>
  ImpQ.isTop(x) ? await new ImpEvaluator(x[2]).eval(x) : x
