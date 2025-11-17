import * as imp from './imp-core.mjs'
import {
  ImpT,
  ImpVal,
  NIL,
  SymT,
  ImpJsf,
  ImpC,
  ImpQ,
  ImpLst,
  ImpLstA,
} from './imp-core.mjs'
import {impShow} from './imp-show.mjs'
import {load} from './imp-load.mjs'
import {imparse} from './im-parse.mjs'
import {toNativePath} from './lib-file.mjs'

// Import ImpEvaluator type - we need this for 'this' context
import type {ImpEvaluator} from './imp-eval.mjs'

// Node.js modules - only available in Node.js environment
let fs: any = null
let https: any = null
let http: any = null
let readline: any = null

// Try to import Node.js modules if available
try {
  if (typeof process !== 'undefined' && process.versions?.node) {
    fs = await import('fs')
    https = await import('https')
    http = await import('http')
    readline = await import('readline')
  }
} catch (e) {
  // Running in browser or environment without Node.js modules
}

// Output provider abstraction - can be customized for different environments
export interface OutputProvider {
  writeLine(text: string): void
}

// Default console output provider
class ConsoleOutputProvider implements OutputProvider {
  writeLine(text: string): void {
    console.log(text)
  }
}

// Global output provider
let globalOutputProvider: OutputProvider = new ConsoleOutputProvider()

export function setOutputProvider(provider: OutputProvider) {
  globalOutputProvider = provider
}

// Input provider abstraction - can be implemented for Node.js, browser, or other contexts
export interface InputProvider {
  readLine(): Promise<string>
}

// Default Node.js readline-based input provider
class NodeReadlineProvider implements InputProvider {
  constructor(private rl: any) {}

  async readLine(): Promise<string> {
    return new Promise((resolve) => {
      // Use once('line') instead of question() to properly integrate with the async iterator
      this.rl.once('line', (line: string) => {
        resolve(line)
      })
    })
  }
}

// Fallback provider for non-interactive contexts (piped input, etc.)
class NodeStdinProvider implements InputProvider {
  async readLine(): Promise<string> {
    if (!readline) throw 'readline not available'
    return new Promise((resolve) => {
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        terminal: false
      })

      rl.once('line', (line: string) => {
        rl.close()
        resolve(line)
      })
    })
  }
}

// Global input provider (set by REPL or external code)
let globalInputProvider: InputProvider | null = null

export function setInputProvider(provider: InputProvider | null) {
  globalInputProvider = provider
}

// Convenience function for Node.js readline interface
export function setReadlineInterface(rl: any | null) {
  if (rl) {
    globalInputProvider = new NodeReadlineProvider(rl)
  } else {
    globalInputProvider = null
  }
}

// Helper: read a line from the configured input provider
async function readLine(): Promise<string> {
  // If we have a global input provider, use it
  if (globalInputProvider) {
    return await globalInputProvider.readLine()
  }

  // Otherwise, fall back to Node.js stdin
  const fallback = new NodeStdinProvider()
  return await fallback.readLine()
}

// Helper: read file or URL content as string (async)
async function readContent(x: ImpVal): Promise<string> {
  // Check if it's a FILE symbol
  if (ImpQ.isSym(x) && x[1].kind === SymT.FILE) {
    if (!fs) throw 'File reading not available in browser environment'
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

    // In browser, use fetch API
    if (!http && !https) {
      try {
        const response = await fetch(url)
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        return await response.text()
      } catch (e: any) {
        throw `Failed to fetch URL: ${url} - ${e.message}`
      }
    }

    // In Node.js, use http/https modules
    return new Promise((resolve, reject) => {
      let protocol = url.startsWith('https:') ? https : http
      protocol.get(url, (res: any) => {
        let data = ''
        res.on('data', (chunk: any) => data += chunk)
        res.on('end', () => resolve(data))
      }).on('error', (e: any) => reject(`Failed to fetch URL: ${url} - ${e.message}`))
    })
  }
  // String fallback (treat as filepath)
  else if (x[0] === ImpT.STR) {
    if (!fs) throw 'File reading not available in browser environment'
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
  // Handle dictionaries
  if (ImpQ.isDct(x)) {
    const dct = x[2] as Map<string, ImpVal>
    const entries: string[] = []
    for (const [key, val] of dct.entries()) {
      entries.push(`\n  <entry k="${key}">${toXml(val)}</entry>`)
    }
    return `<imp:dct>${entries.join('')}\n</imp:dct>`
  }
  // For other types (SEP, INT, STR, MLS, JSF, JDY, END), treat as simple values
  return xmlTag('imp:' + x[0].toLowerCase(), {v: (x[2]??'').toString()})}

function xmlTag(tag:string, attrs:Record<string, string>, content?:string) {
  let attrStr = Object.entries(attrs).map(([k,v])=>`${k}="${v}"`).join(' ')
  if (content) return `<${tag} ${attrStr}>${content}</${tag}>`
  else return `<${tag} ${attrStr}/>`
}

// Get word class for a value
function wordClass(x:ImpVal) {
    let [xt, _xa, _xv] = x
    const ImpP = imp.ImpP
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
      case ImpT.DCT: return ImpP.N
      case ImpT.INTs: return ImpP.N
      case ImpT.NUMs: return ImpP.N
      case ImpT.SYMs: return ImpP.N
      // -- resolved symbols:
      case ImpT.JSF: return ImpP.V
      case ImpT.IFN: return ImpP.V
      case ImpT.NIL: return ImpP.N
      default: throw "[wordClass] invalid argument:" + x }}

// Export the word definitions
export function createImpWords(): Record<string, ImpVal> {
  const words: Record<string, ImpVal> = {
    'nil': NIL,
    'ok': imp.jsf(() => NIL, 0),

    // Control flow (these receive unevaluated LST/TOP arguments for lazy evaluation)
    'ite': imp.jsf(async function(this: ImpEvaluator, cond: ImpVal, thenBranch: ImpVal, elseBranch: ImpVal) {
      // Type check: ensure we got LST or TOP values
      if (!ImpQ.isLst(cond) && !ImpQ.isTop(cond)) {
        throw "ite: condition must be an unevaluated expression (LST or TOP)"
      }
      if (!ImpQ.isLst(thenBranch) && !ImpQ.isTop(thenBranch)) {
        throw "ite: then branch must be an unevaluated expression (LST or TOP)"
      }
      if (!ImpQ.isLst(elseBranch) && !ImpQ.isTop(elseBranch)) {
        throw "ite: else branch must be an unevaluated expression (LST or TOP)"
      }
      // Evaluate condition
      let condResult = await this.lastEval(cond)
      // Check if truthy (non-zero, non-nil, non-empty)
      let isTruthy = false
      if (condResult[0] === ImpT.INT || condResult[0] === ImpT.NUM) {
        isTruthy = (condResult[2] as number) !== 0
      } else if (condResult[0] === ImpT.NIL) {
        isTruthy = false
      } else {
        isTruthy = true  // Everything else is truthy
      }
      // Evaluate and return appropriate branch
      if (isTruthy) {
        return await this.lastEval(thenBranch)
      } else {
        return await this.lastEval(elseBranch)
      }
    }, 3),

    'while': imp.jsf(async function(this: ImpEvaluator, cond: ImpVal, body: ImpVal) {
      // Type check: ensure we got LST or TOP values
      if (!ImpQ.isLst(cond) && !ImpQ.isTop(cond)) {
        throw "while: condition must be an unevaluated expression (LST or TOP)"
      }
      if (!ImpQ.isLst(body) && !ImpQ.isTop(body)) {
        throw "while: body must be an unevaluated expression (LST or TOP)"
      }
      // Repeatedly evaluate condition and body
      while (true) {
        let condResult = await this.lastEval(cond)
        // Check if truthy
        let isTruthy = false
        if (condResult[0] === ImpT.INT || condResult[0] === ImpT.NUM) {
          isTruthy = (condResult[2] as number) !== 0
        } else if (condResult[0] === ImpT.NIL) {
          isTruthy = false
        } else {
          isTruthy = true
        }
        if (!isTruthy) break
        await this.lastEval(body)
      }
      return NIL
    }, 2),

    // Variable access
    'get': imp.jsf(function(this: ImpEvaluator, x: ImpVal) {
      // get[`word] - look up a quoted symbol, return value or fault
      // Also handles symbol vectors
      if (ImpQ.isSym(x)) {
        const varName = x[2].description!
        const value = this.words[varName]
        if (value !== undefined) {
          return value
        }
        // Return fault symbol (?word)
        return ImpC.sym(x[2], SymT.ERR)
      } else if (x[0] === ImpT.SYMs) {
        // Handle symbol vector - map get over each symbol
        const syms = x[2] as symbol[]
        const results: ImpVal[] = []
        for (const sym of syms) {
          const varName = sym.description!
          const value = this.words[varName]
          if (value !== undefined) {
            results.push(value)
          } else {
            results.push(ImpC.sym(sym, SymT.ERR))
          }
        }
        // Return as list
        return imp.lst(undefined, results)
      }
      throw "get expects a symbol or symbol vector"
    }, 1),

    'set': imp.jsf(function(this: ImpEvaluator, x: ImpVal, y: ImpVal) {
      // set[`word; value] - bind word to value, return value
      // Also handles parallel assignment with symbol vectors
      if (ImpQ.isSym(x)) {
        const varName = x[2].description!
        // Unwrap single-element lists created by imparse (e.g., [2 +])
        if (ImpQ.isLst(y)) {
          const yList = y as ImpLst
          const attrs = yList[1] as ImpLstA
          if (yList[2].length === 1 && attrs.open === '[' && attrs.close === ']') {
            y = yList[2][0]
          }
        }
        this.words[varName] = y
        return y
      } else if (x[0] === ImpT.SYMs) {
        // Parallel assignment: set[`a `b `c; values]
        const syms = x[2] as symbol[]

        // If y is a list, distribute values
        if (ImpQ.isLst(y)) {
          const values = y[2] as ImpVal[]
          for (let i = 0; i < syms.length; i++) {
            const varName = syms[i].description!
            const value = i < values.length ? values[i] : NIL
            this.words[varName] = value
          }
          return y
        } else if (y[0] === ImpT.INTs || y[0] === ImpT.NUMs || y[0] === ImpT.SYMs) {
          // Vector values - distribute to each variable
          const values = y[2] as (number[] | symbol[])
          const results: ImpVal[] = []
          for (let i = 0; i < syms.length; i++) {
            const varName = syms[i].description!
            let value: ImpVal
            if (i < values.length) {
              if (y[0] === ImpT.INTs) value = ImpC.int(values[i] as number)
              else if (y[0] === ImpT.NUMs) value = ImpC.num(values[i] as number)
              else value = ImpC.sym(values[i] as symbol, SymT.RAW)
            } else {
              value = NIL
            }
            this.words[varName] = value
            results.push(value)
          }
          return y
        } else {
          // Scalar value - assign to all variables
          for (const sym of syms) {
            const varName = sym.description!
            this.words[varName] = y
          }
          return y
        }
      }
      throw "set expects a symbol or symbol vector as first argument"
    }, 2),

    '+'   : imp.jsf((x,y)=>elemWise((a,b)=>a+b, x, y), 2),
    '-'   : imp.jsf((x,y)=>elemWise((a,b)=>a-b, x, y), 2),
    '*'   : imp.jsf((x,y)=>elemWise((a,b)=>a*b, x, y), 2),
    '%'   : imp.jsf((x,y)=>elemWise((a,b)=>Math.floor(a/b), x, y), 2),
    '^'   : imp.jsf((x,y)=>elemWise((a,b)=>Math.pow(a,b), x, y), 2),
    'min' : imp.jsf((x,y)=>elemWise((a,b)=>Math.min(a,b), x, y), 2),
    'max' : imp.jsf((x,y)=>elemWise((a,b)=>Math.max(a,b), x, y), 2),
    '<'   : imp.jsf((x,y)=>elemWise((a,b)=>a<b ? 1 : 0, x, y), 2),
    '>'   : imp.jsf((x,y)=>elemWise((a,b)=>a>b ? 1 : 0, x, y), 2),
    '<='  : imp.jsf((x,y)=>elemWise((a,b)=>a<=b ? 1 : 0, x, y), 2),
    '>='  : imp.jsf((x,y)=>elemWise((a,b)=>a>=b ? 1 : 0, x, y), 2),
    '='   : imp.jsf((x,y)=>elemWise((a,b)=>a===b ? 1 : 0, x, y), 2),
    '~='  : imp.jsf((x,y)=>elemWise((a,b)=>a!==b ? 1 : 0, x, y), 2),
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
        const yList = y as ImpLst
        let vals = yList[2] as ImpVal[]
        if (vals.length === 0) {
          throw "tk cannot take from empty list"
        }
        let result: ImpVal[] = []
        for (let i = 0; i < count; i++) {
          result.push(vals[i % vals.length])
        }
        return imp.lst(yList[1], result)
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
        const xList = x as ImpLst
        return imp.lst(xList[1], [...xList[2]].reverse())
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
    'rln': imp.jsf(async ()=>ImpC.str(await readLine()), 0),
    'wr': imp.jsf(async (file, content)=>{
      if (!fs) throw 'File writing not available in browser environment'

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
      if (!fs) throw 'File operations not available in browser environment'

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
      if (!fs) throw 'File operations not available in browser environment'

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
      return load(x as any)}, 1),
    'xmls': imp.jsf(x=>ImpC.str(toXml(x) as string), 1),
    'look': imp.jsf(x=>ImpC.str(impShow(words[(x[2] as string)] ?? NIL)), 1),
    'eval': imp.jsf(x=>eval(x[2] as string), 1),
    'part': imp.jsf(x=>{
      // If x is a string or symbol, look up the word in impWords
      let val = x
      if (x[0] === ImpT.STR) {
        val = words[x[2] as string] ?? x
      } else if (ImpQ.isSym(x)) {
        val = words[(x[2] as symbol).description ?? ''] ?? x
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
      let output: string
      if (x[0] === ImpT.INTs || x[0] === ImpT.NUMs || x[0] === ImpT.SYMs) {
        output = impShow(x)
      } else {
        output = String(x[2])
      }
      globalOutputProvider.writeLine(output)
      return NIL
    }, 1),
    'words': imp.jsf(()=>{
      // Return all defined word names as a SYMs vector
      return ImpC.syms(Object.keys(words).map(w => Symbol(w)))
    }, 0),
    'imparse': imp.jsf((x) => imparse(x, words), 1),

    // Dictionary operations
    'keys': imp.jsf(x => {
      if (!ImpQ.isDct(x)) throw "keys expects a dictionary"
      const dct = x[2] as Map<string, ImpVal>
      return ImpC.syms(Array.from(dct.keys()).map(k => Symbol(k)))
    }, 1),

    'vals': imp.jsf(x => {
      if (!ImpQ.isDct(x)) throw "vals expects a dictionary"
      const dct = x[2] as Map<string, ImpVal>
      return imp.lst(undefined, Array.from(dct.values()))
    }, 1),

    'at': imp.jsf((d, k) => {
      if (!ImpQ.isDct(d)) throw "at expects dictionary as first argument"
      if (!ImpQ.isSym(k)) throw "at expects symbol as second argument"
      const dct = d[2] as Map<string, ImpVal>
      const keyName = k[2].description || ''
      return dct.get(keyName) || NIL
    }, 2),

    'put': imp.jsf((d, k, v) => {
      if (!ImpQ.isDct(d)) throw "put expects dictionary as first argument"
      if (!ImpQ.isSym(k)) throw "put expects symbol as second argument"
      const dct = d[2] as Map<string, ImpVal>
      const keyName = k[2].description || ''
      // Create new dictionary with updated value (immutable)
      const newMap = new Map(dct)
      newMap.set(keyName, v)
      return imp.dct(newMap)
    }, 3),
  }

  // Add sourceName to all JSF entries for better display in partial applications
  for (const [name, value] of Object.entries(words)) {
    if (value[0] === ImpT.JSF) {
      (value as ImpJsf)[1].sourceName = name
    }
  }

  return words
}
