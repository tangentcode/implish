import * as imp from './imp-core.mjs'
import {
  ImpT,
  ImpVal,
  NIL,
  SymT,
  ImpJsf,
  ImpIfn,
  ImpC,
  ImpQ,
  ImpLst,
  ImpLstA,
} from './imp-core.mjs'
import {impShow} from './imp-show.mjs'
import {load} from './imp-load.mjs'
import {impEval} from './imp-eval.mjs'
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

// Helper function to get numeric value from INT, NUM, STR (as char codes), or vector types
function getNum(x: ImpVal): number | number[] {
  if (x[0] === ImpT.INT || x[0] === ImpT.NUM) return x[2] as number
  if (x[0] === ImpT.INTs || x[0] === ImpT.NUMs) return x[2] as number[]
  // Handle strings as character code vectors (K behavior)
  if (x[0] === ImpT.STR) {
    const str = x[2] as string
    return str.split('').map(c => c.charCodeAt(0))
  }
  throw "expected number or vector, got: " + x[0]
}

// Helper function to apply binary operation element-wise (fully atomic)
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

// Helper for right-atomic operations (monadic functions applied element-wise to right arg)
function rightAtomic(op: (a: number) => number, x: ImpVal): ImpVal {
  let xVal = getNum(x)

  // Scalar
  if (typeof xVal === 'number') {
    return ImpC.int(op(xVal))
  }

  // Vector - apply to each element
  if (Array.isArray(xVal)) {
    return ImpC.ints(xVal.map(a => op(a)))
  }

  throw "invalid operand"
}

// Helper for left-atomic operations (dyadic function applied element-wise to left arg)
function leftAtomic(op: (a: number, b: any) => any, x: ImpVal, y: ImpVal): ImpVal {
  let xVal = getNum(x)

  // x is scalar
  if (typeof xVal === 'number') {
    return op(xVal, y)
  }

  // x is vector - apply to each element
  if (Array.isArray(xVal)) {
    const results: any[] = []
    for (const a of xVal) {
      results.push(op(a, y))
    }
    // Return results as appropriate type
    if (results.every(r => typeof r === 'number')) {
      return ImpC.ints(results as number[])
    }
    // Otherwise return as list
    return imp.lst(undefined, results)
  }

  throw "invalid operands"
}

// Helper to convert a value to an array representation
// Returns [elements, isString] where isString indicates if we should convert back to string
function toArray(x: ImpVal): [ImpVal[], boolean] {
  if (x[0] === ImpT.STR) {
    const str = x[2] as string
    const chars = str.split('').map(c => ImpC.str(c))
    return [chars, true]
  }
  if (ImpQ.isLst(x)) {
    return [x[2] as ImpVal[], false]
  }
  if (x[0] === ImpT.INTs) {
    const nums = x[2] as number[]
    return [nums.map(n => ImpC.int(n)), false]
  }
  if (x[0] === ImpT.NUMs) {
    const nums = x[2] as number[]
    return [nums.map(n => ImpC.num(n)), false]
  }
  if (x[0] === ImpT.SYMs) {
    const syms = x[2] as symbol[]
    return [syms.map(s => ImpC.sym(s, SymT.BQT)), false]
  }
  throw "toArray expects list, vector, or string"
}

// Helper to convert array back to appropriate type
function fromArray(items: ImpVal[], wasString: boolean, attrs?: any): ImpVal {
  if (wasString) {
    // Convert back to string
    const str = items.map(item => {
      if (item[0] === ImpT.STR) return item[2] as string
      if (item[0] === ImpT.INT || item[0] === ImpT.NUM) return String.fromCharCode(item[2] as number)
      return String(item[2])
    }).join('')
    return ImpC.str(str)
  }

  // Try to preserve vector types
  const allInts = items.every(item => item[0] === ImpT.INT)
  const allNums = items.every(item => item[0] === ImpT.NUM)
  const allSyms = items.every(item => item[0] === ImpT.SYM)

  if (allInts) {
    return ImpC.ints(items.map(item => item[2] as number))
  }
  if (allNums) {
    return ImpC.nums(items.map(item => item[2] as number))
  }
  if (allSyms) {
    return ImpC.syms(items.map(item => item[2] as symbol))
  }

  // Return as general list
  return imp.lst(attrs, items)
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
      const [items, wasString] = toArray(x)
      return fromArray([...items].reverse(), wasString, ImpQ.isLst(x) ? x[1] : undefined)
    }, 1),
    'len': imp.jsf(x => {
      // Scalars have length 1
      if (x[0] === ImpT.INT || x[0] === ImpT.NUM || x[0] === ImpT.SYM) {
        return ImpC.int(1)
      }
      const [items, _] = toArray(x)
      return ImpC.int(items.length)
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

    'at': imp.jsf(async function(this: any, x: ImpVal, y: ImpVal): Promise<ImpVal> {
      // Apply function with single argument
      if (x[0] === ImpT.JSF || ImpQ.isIfn(x)) {
        // Check arity
        const arity = x[1].arity
        if (arity !== 1) throw `at with function expects arity 1, got ${arity}`

        if (x[0] === ImpT.JSF) {
          const fn = x[2] as any
          return await fn.call(this, y)
        } else {
          // IFN - implish function
          const body = x[2] as ImpVal[]
          // Need to evaluate the function body with y as argument
          // This would require access to the evaluator context
          throw "at with implish function not yet implemented"
        }
      }

      // Index into dictionary with symbol
      if (ImpQ.isDct(x)) {
        if (!ImpQ.isSym(y)) throw "at with dictionary expects symbol as index"
        const dct = x[2] as Map<string, ImpVal>
        const keyName = y[2].description || ''
        return dct.get(keyName) || NIL
      }

      // Index into list or vector
      const indexOne = (source: ImpVal, idx: number): ImpVal => {
        if (ImpQ.isLst(source)) {
          const items = source[2] as ImpVal[]
          if (idx < 0 || idx >= items.length) return ImpC.int(imp.NULL_INT)
          return items[idx]
        }
        if (source[0] === ImpT.INTs || source[0] === ImpT.NUMs) {
          const nums = source[2] as number[]
          if (idx < 0 || idx >= nums.length) return ImpC.int(imp.NULL_INT)
          return source[0] === ImpT.INTs ? ImpC.int(nums[idx]) : ImpC.num(nums[idx])
        }
        if (source[0] === ImpT.SYMs) {
          const syms = source[2] as symbol[]
          if (idx < 0 || idx >= syms.length) return ImpC.int(imp.NULL_INT)
          return ImpC.sym(syms[idx], SymT.BQT)
        }
        if (source[0] === ImpT.STR) {
          const str = source[2] as string
          if (idx < 0 || idx >= str.length) return ImpC.int(imp.NULL_INT)
          return ImpC.str(str[idx])
        }
        throw "at expects list, vector, string, or dictionary"
      }

      // Right atomic - apply index to each element of index list/vector
      if (y[0] === ImpT.INTs || y[0] === ImpT.NUMs) {
        const indices = y[2] as number[]
        const results: ImpVal[] = []
        for (const idx of indices) {
          results.push(indexOne(x, idx))
        }
        // Try to return as vector if all results are same type
        const allInts = results.every(r => r[0] === ImpT.INT)
        if (allInts) {
          return ImpC.ints(results.map(r => r[2] as number))
        }
        return imp.lst(undefined, results)
      }

      if (ImpQ.isLst(y)) {
        const items = y[2] as ImpVal[]
        const results: ImpVal[] = []
        for (const item of items) {
          if (item[0] === ImpT.INT || item[0] === ImpT.NUM) {
            results.push(indexOne(x, item[2] as number))
          } else {
            throw "at index list must contain only integers"
          }
        }
        return imp.lst(undefined, results)
      }

      // Single index
      if (y[0] === ImpT.INT || y[0] === ImpT.NUM) {
        return indexOne(x, y[2] as number)
      }

      throw "at expects integer or list of integers as index"
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

    // K Primitives - Phase 1: Foundation
    // (English names for K operators)

    // Arithmetic operators - English names
    'plus': imp.jsf((x,y)=>elemWise((a,b)=>a+b, x, y), 2),
    'minus': imp.jsf((x,y)=>elemWise((a,b)=>a-b, x, y), 2),
    'times': imp.jsf((x,y)=>elemWise((a,b)=>a*b, x, y), 2),
    'divide': imp.jsf((x,y)=>elemWise((a,b)=>a/b, x, y), 2),

    // Comparison operators - English names
    'less': imp.jsf((x,y)=>elemWise((a,b)=>a<b ? 1 : 0, x, y), 2),
    'more': imp.jsf((x,y)=>elemWise((a,b)=>a>b ? 1 : 0, x, y), 2),
    'equal': imp.jsf((x,y)=>elemWise((a,b)=>a===b ? 1 : 0, x, y), 2),

    // negate (monadic -:) - flip sign, right atomic
    'negate': imp.jsf(x => rightAtomic(a => -a, x), 1),

    // sqrt (monadic %:) - square root, right atomic
    'sqrt': imp.jsf(x => rightAtomic(a => Math.sqrt(a), x), 1),

    // first (monadic *:) - extract first element
    'first': imp.jsf(x => {
      // Handle dictionaries - return first value
      if (ImpQ.isDct(x)) {
        const dct = x[2] as Map<string, ImpVal>
        const firstVal = dct.values().next().value
        return firstVal !== undefined ? firstVal : NIL
      }
      // Handle lists
      if (ImpQ.isLst(x)) {
        const items = x[2] as ImpVal[]
        return items.length > 0 ? items[0] : NIL
      }
      // Handle vectors
      if (x[0] === ImpT.INTs || x[0] === ImpT.NUMs) {
        const nums = x[2] as number[]
        return nums.length > 0 ? ImpC.int(nums[0]) : NIL
      }
      if (x[0] === ImpT.SYMs) {
        const syms = x[2] as symbol[]
        return syms.length > 0 ? ImpC.sym(syms[0], SymT.BQT) : NIL
      }
      // Handle strings
      if (x[0] === ImpT.STR) {
        const str = x[2] as string
        return str.length > 0 ? ImpC.str(str[0]) : NIL
      }
      // Scalar - return itself
      return x
    }, 1),

    // floor (monadic _:) - floor function, right atomic (also handles lowercase for chars)
    'floor': imp.jsf(x => {
      // Handle strings - convert to lowercase
      if (x[0] === ImpT.STR) {
        return ImpC.str((x[2] as string).toLowerCase())
      }
      // Handle numbers - floor
      return rightAtomic(a => Math.floor(a), x)
    }, 1),

    // string (monadic $:) - convert atoms to strings, right atomic
    'string': imp.jsf(x => {
      // Handle scalars
      if (x[0] === ImpT.INT || x[0] === ImpT.NUM) {
        return ImpC.str(x[2].toString())
      }
      if (ImpQ.isSym(x)) {
        return ImpC.str(x[2].description || '')
      }
      // Handle vectors - apply to each element
      if (x[0] === ImpT.INTs || x[0] === ImpT.NUMs) {
        const nums = x[2] as number[]
        return imp.lst(undefined, nums.map(n => ImpC.str(n.toString())))
      }
      if (x[0] === ImpT.SYMs) {
        const syms = x[2] as symbol[]
        return imp.lst(undefined, syms.map(s => ImpC.str(s.description || '')))
      }
      throw "string expects atom or vector"
    }, 1),

    // type (monadic @:) - return type magic number
    'type': imp.jsf(x => {
      // K type codes: negative for atoms, positive for lists, 0 for general
      const typeMap: Record<string, number> = {
        [ImpT.NIL]: 0,
        [ImpT.INT]: -6,   // integer atom
        [ImpT.NUM]: -9,   // float atom
        [ImpT.STR]: -10,  // char (treating string as char)
        [ImpT.SYM]: -11,  // symbol atom
        [ImpT.INTs]: 6,   // integer vector
        [ImpT.NUMs]: 9,   // float vector
        [ImpT.SYMs]: 11,  // symbol vector
        [ImpT.LST]: 0,    // general list
        [ImpT.DCT]: 99,   // dictionary
        [ImpT.JSF]: 100,  // function
        [ImpT.IFN]: 100,  // function
      }
      const typeCode = typeMap[x[0]] !== undefined ? typeMap[x[0]] : 0
      return ImpC.int(typeCode)
    }, 1),

    // not (monadic ~:) - logical not, right atomic
    'not': imp.jsf(function(this: any, x: ImpVal): ImpVal {
      // Handle dictionaries - apply to values
      if (ImpQ.isDct(x)) {
        const dct = x[2] as Map<string, ImpVal>
        const newMap = new Map<string, ImpVal>()
        for (const [k, v] of dct.entries()) {
          // Recursively apply not to value
          const notFn = this.words?.['not'] || words['not']
          if (notFn && notFn[0] === ImpT.JSF) {
            newMap.set(k, (notFn[2] as any)(v))
          } else {
            // Fallback - apply right atomic directly
            newMap.set(k, rightAtomic(a => a === 0 ? 1 : 0, v))
          }
        }
        return imp.dct(newMap)
      }

      // Handle lists - apply recursively to each element
      if (ImpQ.isLst(x)) {
        const items = x[2] as ImpVal[]
        const notFn = this.words?.['not'] || words['not']
        const result: ImpVal[] = []
        for (const item of items) {
          if (notFn && notFn[0] === ImpT.JSF) {
            result.push((notFn[2] as any)(item))
          } else {
            result.push(rightAtomic(a => a === 0 ? 1 : 0, item))
          }
        }
        return imp.lst(x[1], result)
      }

      // Numbers: 0 becomes 1, non-zero becomes 0
      return rightAtomic(a => a === 0 ? 1 : 0, x)
    }, 1),

    // flip (monadic +:) - transpose/flip matrices
    'flip': imp.jsf(x => {
      if (!ImpQ.isLst(x)) throw "flip expects a list"
      const items = x[2] as ImpVal[]
      if (items.length === 0) return x

      // Get max length from all items
      let maxLen = 0
      for (const item of items) {
        if (ImpQ.isLst(item)) {
          maxLen = Math.max(maxLen, (item[2] as ImpVal[]).length)
        } else if (item[0] === ImpT.INTs || item[0] === ImpT.NUMs) {
          maxLen = Math.max(maxLen, (item[2] as number[]).length)
        } else {
          // Scalar - will be spread
          maxLen = Math.max(maxLen, 1)
        }
      }

      // Build transposed result
      const result: ImpVal[] = []
      for (let i = 0; i < maxLen; i++) {
        const row: ImpVal[] = []
        for (const item of items) {
          if (ImpQ.isLst(item)) {
            const itemList = item[2] as ImpVal[]
            row.push(i < itemList.length ? itemList[i] : itemList[0])
          } else if (item[0] === ImpT.INTs) {
            const nums = item[2] as number[]
            row.push(ImpC.int(i < nums.length ? nums[i] : nums[0]))
          } else if (item[0] === ImpT.NUMs) {
            const nums = item[2] as number[]
            row.push(ImpC.num(i < nums.length ? nums[i] : nums[0]))
          } else {
            // Scalar - repeat it
            row.push(item)
          }
        }
        result.push(imp.lst(undefined, row))
      }
      return imp.lst(x[1], result)
    }, 1),

    // concat (dyadic ,) - join lists/atoms
    'concat': imp.jsf((x, y) => {
      // Handle NIL - concatenating with nil just returns the other value
      if (x[0] === ImpT.NIL) return y
      if (y[0] === ImpT.NIL) return x

      // Handle dictionaries - merge them (y takes precedence)
      if (ImpQ.isDct(x) && ImpQ.isDct(y)) {
        const xMap = x[2] as Map<string, ImpVal>
        const yMap = y[2] as Map<string, ImpVal>
        const merged = new Map(xMap)
        for (const [k, v] of yMap.entries()) {
          merged.set(k, v)
        }
        return imp.dct(merged)
      }

      // Helper to check if value is or contains only integers
      const isIntType = (v: ImpVal): boolean => {
        return v[0] === ImpT.INT || v[0] === ImpT.INTs
      }
      const isNumType = (v: ImpVal): boolean => {
        return v[0] === ImpT.NUM || v[0] === ImpT.NUMs
      }
      const isSymType = (v: ImpVal): boolean => {
        return v[0] === ImpT.SYM || v[0] === ImpT.SYMs
      }

      // If both are integers (scalar or vector), return INTs vector
      if (isIntType(x) && isIntType(y)) {
        const xNums: number[] = x[0] === ImpT.INT ? [x[2] as number] : x[2] as number[]
        const yNums: number[] = y[0] === ImpT.INT ? [y[2] as number] : y[2] as number[]
        return ImpC.ints([...xNums, ...yNums])
      }

      // If both are numbers (scalar or vector), return NUMs vector
      if ((isIntType(x) || isNumType(x)) && (isIntType(y) || isNumType(y))) {
        const xNums: number[] = (x[0] === ImpT.INT || x[0] === ImpT.NUM) ? [x[2] as number] : x[2] as number[]
        const yNums: number[] = (y[0] === ImpT.INT || y[0] === ImpT.NUM) ? [y[2] as number] : y[2] as number[]
        return ImpC.nums([...xNums, ...yNums])
      }

      // If both are symbols (scalar or vector), return SYMs vector
      if (isSymType(x) && isSymType(y)) {
        const xSyms: symbol[] = x[0] === ImpT.SYM ? [x[2] as symbol] : x[2] as symbol[]
        const ySyms: symbol[] = y[0] === ImpT.SYM ? [y[2] as symbol] : y[2] as symbol[]
        return ImpC.syms([...xSyms, ...ySyms])
      }

      // Otherwise, convert to general lists
      const toList = (v: ImpVal): ImpVal[] => {
        if (ImpQ.isLst(v)) return v[2] as ImpVal[]
        if (v[0] === ImpT.INTs) return (v[2] as number[]).map(n => ImpC.int(n))
        if (v[0] === ImpT.NUMs) return (v[2] as number[]).map(n => ImpC.num(n))
        if (v[0] === ImpT.SYMs) return (v[2] as symbol[]).map(s => ImpC.sym(s, SymT.BQT))
        return [v]  // Wrap scalar
      }

      const xList = toList(x)
      const yList = toList(y)
      return imp.lst(undefined, [...xList, ...yList])
    }, 2),

    // enlist (monadic ,:) - wrap in 1-length list
    'enlist': imp.jsf(x => imp.lst(undefined, [x]), 1),

    // count (monadic #:) - count elements
    'count': imp.jsf(x => {
      if (ImpQ.isDct(x)) {
        return ImpC.int((x[2] as Map<string, ImpVal>).size)
      }
      // Atoms have count 1
      if (x[0] === ImpT.INT || x[0] === ImpT.NUM || x[0] === ImpT.SYM) {
        return ImpC.int(1)
      }
      const [items, _] = toArray(x)
      return ImpC.int(items.length)
    }, 1),

    // null? (monadic ^:) - test if null
    'null?': imp.jsf(x => {
      // Check if a single value is null
      const isNull = (val: ImpVal): boolean => {
        if (val[0] === ImpT.INT) return val[2] === imp.NULL_INT
        if (val[0] === ImpT.NUM) return isNaN(val[2] as number)
        if (val[0] === ImpT.SYM && val[1].kind === SymT.BQT) {
          // Bare backtick symbol (null symbol)
          return (val[2].description ?? '') === ''
        }
        return false
      }

      // Handle lists
      if (ImpQ.isLst(x)) {
        const items = x[2] as ImpVal[]
        const result = items.map(item => isNull(item) ? 1 : 0)
        return ImpC.ints(result)
      }

      // Handle vectors
      if (x[0] === ImpT.INTs || x[0] === ImpT.NUMs) {
        return rightAtomic(a => (a === imp.NULL_INT || isNaN(a)) ? 1 : 0, x)
      }

      // Handle single values
      return ImpC.int(isNull(x) ? 1 : 0)
    }, 1),

    // distinct (monadic ?:) - unique elements
    'distinct': imp.jsf(x => {
      // Scalar - already unique
      if (x[0] === ImpT.INT || x[0] === ImpT.NUM || x[0] === ImpT.SYM) {
        return x
      }
      const [items, wasString] = toArray(x)
      const seen = new Set<string>()
      const result: ImpVal[] = []
      for (const item of items) {
        const key = impShow(item)
        if (!seen.has(key)) {
          seen.add(key)
          result.push(item)
        }
      }
      return fromArray(result, wasString, ImpQ.isLst(x) ? x[1] : undefined)
    }, 1),

    // lowercase (monadic _: for characters) - already handled in 'floor'
    'lowercase': imp.jsf(x => {
      if (x[0] === ImpT.STR) {
        return ImpC.str((x[2] as string).toLowerCase())
      }
      throw "lowercase expects a string"
    }, 1),

    // K Primitives - Phase 2: Core List Operations

    // take (dyadic #) - truncate/repeat to length, negative takes from end
    'take': imp.jsf((x, y) => {
      if (x[0] !== ImpT.INT) throw "take expects integer count"
      let count = x[2] as number

      // Handle negative count - take from end
      const fromEnd = count < 0
      if (fromEnd) count = -count

      const [items, wasString] = toArray(y)
      if (items.length === 0) throw "cannot take from empty sequence"

      let result: ImpVal[]
      if (fromEnd) {
        // Take from end
        const start = Math.max(0, items.length - count)
        result = items.slice(start)
      } else {
        // Take from start, cycling if needed
        result = []
        for (let i = 0; i < count; i++) {
          result.push(items[i % items.length])
        }
      }

      return fromArray(result, wasString, ImpQ.isLst(y) ? y[1] : undefined)
    }, 2),

    // reshape (dyadic # with list shape) - create multi-dimensional array
    'reshape': imp.jsf((shape, data) => {
      // Determine the source data type
      type SourceType = 'int' | 'num' | 'sym' | 'str' | 'mixed'
      let sourceType: SourceType = 'mixed'

      if (data[0] === ImpT.INT) sourceType = 'int'
      else if (data[0] === ImpT.INTs) sourceType = 'int'
      else if (data[0] === ImpT.NUM) sourceType = 'num'
      else if (data[0] === ImpT.NUMs) sourceType = 'num'
      else if (data[0] === ImpT.SYM) sourceType = 'sym'
      else if (data[0] === ImpT.SYMs) sourceType = 'sym'
      else if (data[0] === ImpT.STR) sourceType = 'str'

      // Helper to flatten data into arrays based on type
      const flattenData = (val: ImpVal): number[] | symbol[] | string[] | ImpVal[] => {
        if (val[0] === ImpT.INT) {
          return [val[2] as number]
        } else if (val[0] === ImpT.INTs) {
          return val[2] as number[]
        } else if (val[0] === ImpT.NUM) {
          return [val[2] as number]
        } else if (val[0] === ImpT.NUMs) {
          return val[2] as number[]
        } else if (val[0] === ImpT.SYM) {
          return [val[2] as symbol]
        } else if (val[0] === ImpT.SYMs) {
          return val[2] as symbol[]
        } else if (val[0] === ImpT.STR) {
          return (val[2] as string).split('')
        } else if (ImpQ.isLst(val)) {
          return val[2] as ImpVal[]
        } else {
          return [val]
        }
      }

      // Get shape dimensions
      let dims: number[]
      if (shape[0] === ImpT.INT) {
        dims = [shape[2] as number]
      } else if (shape[0] === ImpT.INTs) {
        dims = shape[2] as number[]
      } else if (ImpQ.isLst(shape)) {
        const items = shape[2] as ImpVal[]
        dims = items.map(item => {
          if (item[0] === ImpT.INT) return item[2] as number
          throw "reshape shape must contain only integers"
        })
      } else {
        throw "reshape expects integer or list of integers as shape"
      }

      // Flatten data source
      const source = flattenData(data)
      if (source.length === 0) throw "reshape cannot work with empty data"

      // Handle 0N (maximal dimension) in shape
      if (dims.length === 2) {
        if (dims[0] === imp.NULL_INT) {
          const cols = dims[1]
          if (cols <= 0) throw "reshape column count must be positive"
          const rows = Math.ceil(source.length / cols)
          dims = [rows, cols]
        } else if (dims[1] === imp.NULL_INT) {
          const rows = dims[0]
          if (rows <= 0) throw "reshape row count must be positive"
          const cols = Math.ceil(source.length / rows)
          dims = [rows, cols]
        }
      } else if (dims.includes(imp.NULL_INT)) {
        throw "reshape 0N only supported for 2-dimensional shapes"
      }

      // Build the reshaped result based on source type
      if (sourceType === 'int' || sourceType === 'num') {
        const nums = source as number[]
        const buildNumShape = (dims: number[], sourceIdx: number): [ImpVal, number] => {
          if (dims.length === 1) {
            const count = dims[0]
            const result: number[] = []
            for (let i = 0; i < count; i++) {
              result.push(nums[sourceIdx % nums.length])
              sourceIdx++
            }
            return [sourceType === 'int' ? ImpC.ints(result) : ImpC.nums(result), sourceIdx]
          } else {
            const outerCount = dims[0]
            const innerDims = dims.slice(1)
            const result: ImpVal[] = []
            for (let i = 0; i < outerCount; i++) {
              const [inner, newIdx] = buildNumShape(innerDims, sourceIdx)
              result.push(inner)
              sourceIdx = newIdx
            }
            return [imp.lst(undefined, result), sourceIdx]
          }
        }
        const [result, _] = buildNumShape(dims, 0)
        return result
      } else if (sourceType === 'sym') {
        const syms = source as symbol[]
        const buildSymShape = (dims: number[], sourceIdx: number): [ImpVal, number] => {
          if (dims.length === 1) {
            const count = dims[0]
            const result: symbol[] = []
            for (let i = 0; i < count; i++) {
              result.push(syms[sourceIdx % syms.length])
              sourceIdx++
            }
            return [ImpC.syms(result), sourceIdx]
          } else {
            const outerCount = dims[0]
            const innerDims = dims.slice(1)
            const result: ImpVal[] = []
            for (let i = 0; i < outerCount; i++) {
              const [inner, newIdx] = buildSymShape(innerDims, sourceIdx)
              result.push(inner)
              sourceIdx = newIdx
            }
            return [imp.lst(undefined, result), sourceIdx]
          }
        }
        const [result, _] = buildSymShape(dims, 0)
        return result
      } else if (sourceType === 'str') {
        const chars = source as string[]
        const buildStrShape = (dims: number[], sourceIdx: number): [ImpVal, number] => {
          if (dims.length === 1) {
            const count = dims[0]
            const result: string[] = []
            for (let i = 0; i < count; i++) {
              result.push(chars[sourceIdx % chars.length])
              sourceIdx++
            }
            return [ImpC.str(result.join('')), sourceIdx]
          } else {
            const outerCount = dims[0]
            const innerDims = dims.slice(1)
            const result: ImpVal[] = []
            for (let i = 0; i < outerCount; i++) {
              const [inner, newIdx] = buildStrShape(innerDims, sourceIdx)
              result.push(inner)
              sourceIdx = newIdx
            }
            return [imp.lst(undefined, result), sourceIdx]
          }
        }
        const [result, _] = buildStrShape(dims, 0)
        return result
      } else {
        // Mixed type - use lists
        const vals = source as ImpVal[]
        const buildMixedShape = (dims: number[], sourceIdx: number): [ImpVal, number] => {
          if (dims.length === 1) {
            const count = dims[0]
            const result: ImpVal[] = []
            for (let i = 0; i < count; i++) {
              result.push(vals[sourceIdx % vals.length])
              sourceIdx++
            }
            return [imp.lst(undefined, result), sourceIdx]
          } else {
            const outerCount = dims[0]
            const innerDims = dims.slice(1)
            const result: ImpVal[] = []
            for (let i = 0; i < outerCount; i++) {
              const [inner, newIdx] = buildMixedShape(innerDims, sourceIdx)
              result.push(inner)
              sourceIdx = newIdx
            }
            return [imp.lst(undefined, result), sourceIdx]
          }
        }
        const [result, _] = buildMixedShape(dims, 0)
        return result
      }
    }, 2),

    // drop (dyadic _) - remove elements from start/end
    'drop': imp.jsf((x, y) => {
      if (x[0] !== ImpT.INT) throw "drop expects integer count"
      let count = x[2] as number

      const [items, wasString] = toArray(y)
      const result = count >= 0 ? items.slice(count) : items.slice(0, items.length + count)
      return fromArray(result, wasString, ImpQ.isLst(y) ? y[1] : undefined)
    }, 2),

    // cut (dyadic _ with list of indices) - split at indices
    'cut': imp.jsf((x, y) => {
      // x should be a list of indices (or vector)
      let indices: number[]
      if (x[0] === ImpT.INTs || x[0] === ImpT.NUMs) {
        indices = x[2] as number[]
      } else if (ImpQ.isLst(x)) {
        const items = x[2] as ImpVal[]
        indices = items.map(item => {
          if (item[0] === ImpT.INT || item[0] === ImpT.NUM) {
            return item[2] as number
          }
          throw "cut indices must be integers"
        })
      } else {
        throw "cut expects list of indices as first argument"
      }

      const [items, wasString] = toArray(y)
      const result: ImpVal[][] = []
      for (let i = 0; i < indices.length; i++) {
        const start = indices[i]
        const end = i < indices.length - 1 ? indices[i + 1] : items.length
        result.push(items.slice(start, end))
      }

      // Convert each slice back to appropriate type
      return imp.lst(undefined, result.map(arr => fromArray(arr, wasString, ImpQ.isLst(y) ? y[1] : undefined)))
    }, 2),

    // except (dyadic ^) - remove all instances of y from x
    'except': imp.jsf((x, y) => {
      // Get items to remove
      const toRemove = new Set<string>()
      if (ImpQ.isLst(y) || y[0] === ImpT.INTs || y[0] === ImpT.NUMs || y[0] === ImpT.SYMs || y[0] === ImpT.STR) {
        const [yItems, _] = toArray(y)
        for (const item of yItems) {
          toRemove.add(impShow(item))
        }
      } else {
        toRemove.add(impShow(y))
      }

      // Filter x
      const [items, wasString] = toArray(x)
      const result: ImpVal[] = []
      for (const item of items) {
        if (!toRemove.has(impShow(item))) {
          result.push(item)
        }
      }
      return fromArray(result, wasString, ImpQ.isLst(x) ? x[1] : undefined)
    }, 2),

    // fill (dyadic ^ with atom left) - replace nulls with x
    'fill': imp.jsf((x, y) => {
      // Helper to check if a value is null
      const isNull = (val: ImpVal): boolean => {
        if (val[0] === ImpT.NIL) return true
        if (val[0] === ImpT.INT && val[2] === imp.NULL_INT) return true
        if (val[0] === ImpT.NUM && isNaN(val[2] as number)) return true
        if (val[0] === ImpT.SYM && val[1].kind === SymT.BQT) {
          return (val[2].description ?? '') === ''
        }
        return false
      }

      if (ImpQ.isLst(y)) {
        const result: ImpVal[] = []
        for (const item of y[2] as ImpVal[]) {
          result.push(isNull(item) ? x : item)
        }
        return imp.lst(y[1], result)
      }

      if (y[0] === ImpT.INTs || y[0] === ImpT.NUMs) {
        const nums = y[2] as number[]
        const fillVal = x[2]
        const result = nums.map(n =>
          (n === imp.NULL_INT || isNaN(n)) ? fillVal : n
        )
        return y[0] === ImpT.INTs ? ImpC.ints(result as number[]) : ImpC.nums(result as number[])
      }

      if (y[0] === ImpT.SYMs) {
        const syms = y[2] as symbol[]
        const fillSym = x[0] === ImpT.SYM ? x[2] as symbol : Symbol(x[2] as string)
        const result = syms.map(s =>
          (s.description ?? '') === '' ? fillSym : s
        )
        return ImpC.syms(result)
      }

      return y
    }, 2),

    // find (dyadic ?) - index of y in x, returns 0N if not found
    'find': imp.jsf((x, y) => {
      // For dictionaries, find value and return key (right atomic)
      if (ImpQ.isDct(x)) {
        const map = x[2] as Map<string, ImpVal>

        const findKey = (searchFor: ImpVal): ImpVal => {
          for (const [key, val] of map.entries()) {
            if (impShow(val) === impShow(searchFor)) {
              return ImpC.sym(Symbol(key), SymT.BQT)
            }
          }
          return ImpC.sym(Symbol(''), SymT.BQT) // null symbol for not found
        }

        // Right atomic for multiple values
        if (y[0] === ImpT.INTs || y[0] === ImpT.NUMs) {
          const results: symbol[] = []
          for (const n of y[2] as number[]) {
            const key = findKey(ImpC.int(n))
            results.push(key[2] as symbol)
          }
          return ImpC.syms(results)
        }

        if (y[0] === ImpT.SYMs) {
          const results: symbol[] = []
          for (const sym of y[2] as symbol[]) {
            const key = findKey(ImpC.sym(sym, SymT.BQT))
            results.push(key[2] as symbol)
          }
          return ImpC.syms(results)
        }

        if (ImpQ.isLst(y)) {
          const results: symbol[] = []
          for (const item of y[2] as ImpVal[]) {
            const key = findKey(item)
            results.push(key[2] as symbol)
          }
          return ImpC.syms(results)
        }

        return findKey(y)
      }

      // Right atomic - apply to each element of y
      const findOne = (searchIn: ImpVal, searchFor: ImpVal): number => {
        if (ImpQ.isLst(searchIn)) {
          const items = searchIn[2] as ImpVal[]
          for (let i = 0; i < items.length; i++) {
            if (impShow(items[i]) === impShow(searchFor)) {
              return i
            }
          }
          return imp.NULL_INT
        }

        if (searchIn[0] === ImpT.INTs || searchIn[0] === ImpT.NUMs) {
          const nums = searchIn[2] as number[]
          if (searchFor[0] === ImpT.INT || searchFor[0] === ImpT.NUM) {
            const target = searchFor[2] as number
            const idx = nums.indexOf(target)
            return idx >= 0 ? idx : imp.NULL_INT
          }
          return imp.NULL_INT
        }

        if (searchIn[0] === ImpT.STR && searchFor[0] === ImpT.STR) {
          const str = searchIn[2] as string
          const char = (searchFor[2] as string)[0]
          const idx = str.indexOf(char)
          return idx >= 0 ? idx : imp.NULL_INT
        }

        return imp.NULL_INT
      }

      // Handle strings as character arrays (right atomic over characters)
      if (x[0] === ImpT.STR && y[0] === ImpT.STR) {
        const searchStr = x[2] as string
        const targetStr = y[2] as string
        const results: number[] = []
        for (const char of targetStr) {
          const idx = searchStr.indexOf(char)
          results.push(idx >= 0 ? idx : imp.NULL_INT)
        }
        return ImpC.ints(results)
      }

      // Handle right atomic behavior
      if (y[0] === ImpT.INTs || y[0] === ImpT.NUMs) {
        const results: number[] = []
        for (const n of y[2] as number[]) {
          results.push(findOne(x, ImpC.int(n)))
        }
        return ImpC.ints(results)
      }

      if (ImpQ.isLst(y)) {
        const results: number[] = []
        for (const item of y[2] as ImpVal[]) {
          results.push(findOne(x, item))
        }
        return ImpC.ints(results)
      }

      return ImpC.int(findOne(x, y))
    }, 2),

    // match (dyadic ~) - recursive equality test
    'match': imp.jsf((x, y) => {
      const matches = impShow(x) === impShow(y)
      return ImpC.int(matches ? 1 : 0)
    }, 2),

    // pad (dyadic $) - adjust string length
    'pad': imp.jsf((x, y) => {
      if (y[0] !== ImpT.STR) throw "pad expects string as second argument"

      const padAmount = (xVal: number, str: string): string => {
        if (xVal >= 0) {
          // Right pad or truncate
          if (str.length < xVal) {
            return str + ' '.repeat(xVal - str.length)
          } else {
            return str.slice(0, xVal)
          }
        } else {
          // Left pad or truncate
          const absX = -xVal
          if (str.length < absX) {
            return ' '.repeat(absX - str.length) + str
          } else {
            return str.slice(str.length - absX)
          }
        }
      }

      const str = y[2] as string

      // Handle vector of pad amounts
      if (x[0] === ImpT.INTs || x[0] === ImpT.NUMs) {
        const amounts = x[2] as number[]
        const result: ImpVal[] = []
        for (const amt of amounts) {
          result.push(ImpC.str(padAmount(amt, str)))
        }
        return imp.lst(undefined, result)
      }

      if (x[0] === ImpT.INT || x[0] === ImpT.NUM) {
        return ImpC.str(padAmount(x[2] as number, str))
      }

      throw "pad expects number or number vector as first argument"
    }, 2),

    // K Primitives - Phase 3: Sorting & Type Operations

    // asc (monadic <:) - grade up (ascending sort indices)
    'asc': imp.jsf(x => {
      // Handle dictionaries - sort keys by values
      if (ImpQ.isDct(x)) {
        const dct = x[2] as Map<string, ImpVal>
        const entries = Array.from(dct.entries())
        entries.sort((a, b) => {
          const aVal = impShow(a[1])
          const bVal = impShow(b[1])
          return aVal < bVal ? -1 : aVal > bVal ? 1 : 0
        })
        return ImpC.syms(entries.map(([k, _]) => Symbol(k)))
      }

      const [items, _] = toArray(x)
      const indices = items.map((_, i) => i)
      indices.sort((a, b) => {
        const aStr = impShow(items[a])
        const bStr = impShow(items[b])
        return aStr < bStr ? -1 : aStr > bStr ? 1 : 0
      })
      return ImpC.ints(indices)
    }, 1),

    // desc (monadic >:) - grade down (descending sort indices)
    'desc': imp.jsf(x => {
      // Handle dictionaries - sort keys by values (descending)
      if (ImpQ.isDct(x)) {
        const dct = x[2] as Map<string, ImpVal>
        const entries = Array.from(dct.entries())
        entries.sort((a, b) => {
          const aVal = impShow(a[1])
          const bVal = impShow(b[1])
          return aVal > bVal ? -1 : aVal < bVal ? 1 : 0
        })
        return ImpC.syms(entries.map(([k, _]) => Symbol(k)))
      }

      const [items, _] = toArray(x)
      const indices = items.map((_, i) => i)
      indices.sort((a, b) => {
        const aStr = impShow(items[a])
        const bStr = impShow(items[b])
        return aStr > bStr ? -1 : aStr < bStr ? 1 : 0
      })
      return ImpC.ints(indices)
    }, 1),

    // where (monadic &:) - replicate indices or gather nonzero
    'where': imp.jsf(x => {
      // Handle dictionaries - replicate keys by their values
      if (ImpQ.isDct(x)) {
        const dct = x[2] as Map<string, ImpVal>
        const result: symbol[] = []
        for (const [key, val] of dct.entries()) {
          let count = 0
          if (val[0] === ImpT.INT || val[0] === ImpT.NUM) {
            count = val[2] as number
          }
          for (let j = 0; j < count; j++) {
            result.push(Symbol(key))
          }
        }
        return ImpC.syms(result)
      }

      if (x[0] === ImpT.INTs || x[0] === ImpT.NUMs) {
        const nums = x[2] as number[]
        const result: number[] = []
        for (let i = 0; i < nums.length; i++) {
          const count = nums[i]
          for (let j = 0; j < count; j++) {
            result.push(i)
          }
        }
        return ImpC.ints(result)
      }

      if (ImpQ.isLst(x)) {
        const items = x[2] as ImpVal[]
        const result: number[] = []
        for (let i = 0; i < items.length; i++) {
          const item = items[i]
          let count = 0
          if (item[0] === ImpT.INT || item[0] === ImpT.NUM) {
            count = item[2] as number
          }
          for (let j = 0; j < count; j++) {
            result.push(i)
          }
        }
        return ImpC.ints(result)
      }

      throw "where expects vector, list, or dictionary"
    }, 1),

    // reverse (monadic |:) - reverse a list
    'reverse': imp.jsf(x => {
      // Handle dictionaries - reverse order of keys and values
      if (ImpQ.isDct(x)) {
        const dct = x[2] as Map<string, ImpVal>
        const entries = Array.from(dct.entries()).reverse()
        const newMap = new Map<string, ImpVal>()
        for (const [k, v] of entries) {
          newMap.set(k, v)
        }
        return imp.dct(newMap)
      }

      // Scalar - return as is
      if (x[0] === ImpT.INT || x[0] === ImpT.NUM || x[0] === ImpT.SYM) {
        return x
      }

      const [items, wasString] = toArray(x)
      return fromArray([...items].reverse(), wasString, ImpQ.isLst(x) ? x[1] : undefined)
    }, 1),

    // K Primitives - Phase 4: Special Forms & Dict Ops

    // mod (dyadic !) - modulo, right atomic
    'mod': imp.jsf((x, y) => {
      if (x[0] !== ImpT.INT && x[0] !== ImpT.NUM) throw "mod expects number as first argument"
      const modulus = Math.abs(x[2] as number)
      return rightAtomic(a => a % modulus, y)
    }, 2),

    // div (dyadic ! with negative left) - divide and truncate, right atomic
    'div': imp.jsf((x, y) => {
      if (x[0] !== ImpT.INT && x[0] !== ImpT.NUM) throw "div expects number as first argument"
      const divisor = Math.abs(x[2] as number)
      return rightAtomic(a => Math.floor(a / divisor), y)
    }, 2),

    // int (monadic !:) - range from 0 to N (or odometer for lists)
    // Already implemented as '!' in base implish, but add as 'int' for K compatibility
    'int': imp.jsf(x => {
      if (x[0] === ImpT.INT) {
        const n = x[2] as number
        if (n >= 0) {
          return ImpC.ints(Array.from({length: n}, (_, i) => i))
        } else {
          return ImpC.ints(Array.from({length: -n}, (_, i) => n + i))
        }
      }

      // Handle odometer (cartesian product) for lists/vectors
      if (x[0] === ImpT.INTs || x[0] === ImpT.NUMs) {
        const dims = x[2] as number[]
        if (dims.length === 0) return ImpC.ints([])

        // Calculate total number of combinations
        let total = 1
        for (const dim of dims) {
          total *= dim
        }

        // Generate each dimension's values
        const result: number[][] = []
        for (let d = 0; d < dims.length; d++) {
          const dimension: number[] = []
          const dim = dims[d]
          const repeatCount = dims.slice(d + 1).reduce((a, b) => a * b, 1)
          const cycleLength = dim * repeatCount

          for (let i = 0; i < total; i++) {
            dimension.push(Math.floor((i % cycleLength) / repeatCount))
          }
          result.push(dimension)
        }

        // Convert to list of vectors
        return imp.lst(undefined, result.map(r => ImpC.ints(r)))
      }

      throw "int expects integer or vector"
    }, 1),

    // group (monadic =:) - dictionary from items to indices
    'group': imp.jsf(x => {
      const groups = new Map<string, number[]>()
      const [items, _] = toArray(x)

      for (let i = 0; i < items.length; i++) {
        const key = impShow(items[i])
        if (!groups.has(key)) groups.set(key, [])
        groups.get(key)!.push(i)
      }

      // Convert to dictionary
      const result = new Map<string, ImpVal>()
      for (const [key, indices] of groups.entries()) {
        result.set(key, ImpC.ints(indices))
      }
      return imp.dct(result)
    }, 1),

    // identity-matrix (monadic =: for numbers) - NxN identity matrix
    'identity-matrix': imp.jsf(x => {
      if (x[0] !== ImpT.INT) throw "identity-matrix expects integer"
      const n = x[2] as number
      const result: ImpVal[] = []
      for (let i = 0; i < n; i++) {
        const row: number[] = []
        for (let j = 0; j < n; j++) {
          row.push(i === j ? 1 : 0)
        }
        result.push(ImpC.ints(row))
      }
      return imp.lst(undefined, result)
    }, 1),

    // map (dyadic !) - make dictionary from keys and values
    'map': imp.jsf((x, y) => {
      // x is keys, y is values
      const result = new Map<string, ImpVal>()

      // Handle symbol vectors as keys
      if (x[0] === ImpT.SYMs) {
        const keys = x[2] as symbol[]

        // Handle values as vector
        if (y[0] === ImpT.INTs || y[0] === ImpT.NUMs) {
          const vals = y[2] as number[]
          for (let i = 0; i < keys.length; i++) {
            const key = keys[i].description || ''
            const val = i < vals.length ? vals[i] : vals[vals.length - 1]
            result.set(key, y[0] === ImpT.INTs ? ImpC.int(val) : ImpC.num(val))
          }
        } else if (ImpQ.isLst(y)) {
          const vals = y[2] as ImpVal[]
          for (let i = 0; i < keys.length; i++) {
            const key = keys[i].description || ''
            const val = i < vals.length ? vals[i] : vals[vals.length - 1]
            result.set(key, val)
          }
        } else {
          // Scalar value - use for all keys
          for (const k of keys) {
            result.set(k.description || '', y)
          }
        }

        return imp.dct(result)
      }

      // For non-symbol keys, just return a special encoding (K behavior)
      // In K: 4 5!6 7 returns the dict-like structure "4 5!6 7"
      // For now, create a list representation
      return imp.lst(undefined, [x, ImpC.sym(Symbol('!'), SymT.RAW), y])
    }, 2),

    // K Primitives - Phase 5: Math & Random

    // sin (monadic) - sine, atomic
    'sin': imp.jsf(x => rightAtomic(a => Math.sin(a), x), 1),

    // cos (monadic) - cosine, atomic
    'cos': imp.jsf(x => rightAtomic(a => Math.cos(a), x), 1),

    // exp (monadic) - exponential, atomic
    'exp': imp.jsf(x => rightAtomic(a => Math.exp(a), x), 1),

    // log (monadic) - natural logarithm, atomic
    'log': imp.jsf(x => rightAtomic(a => Math.log(a), x), 1),

    // in (dyadic) - membership test, left atomic
    'in': imp.jsf((x, y) => {
      // Check if each element of x is in y
      const checkIn = (item: ImpVal, haystack: ImpVal): number => {
        const itemStr = impShow(item)

        if (ImpQ.isLst(haystack)) {
          for (const h of haystack[2] as ImpVal[]) {
            if (impShow(h) === itemStr) return 1
          }
          return 0
        }

        if (haystack[0] === ImpT.INTs || haystack[0] === ImpT.NUMs) {
          if (item[0] === ImpT.INT || item[0] === ImpT.NUM) {
            const nums = haystack[2] as number[]
            return nums.includes(item[2] as number) ? 1 : 0
          }
          return 0
        }

        return 0
      }

      // Left atomic
      if (x[0] === ImpT.INTs || x[0] === ImpT.NUMs) {
        const nums = x[2] as number[]
        const results: number[] = []
        for (const n of nums) {
          results.push(checkIn(ImpC.int(n), y))
        }
        return ImpC.ints(results)
      }

      if (ImpQ.isLst(x)) {
        const items = x[2] as ImpVal[]
        const results: number[] = []
        for (const item of items) {
          results.push(checkIn(item, y))
        }
        return ImpC.ints(results)
      }

      return ImpC.int(checkIn(x, y))
    }, 2),

    // cast (dyadic $ with symbol) - type conversion
    'cast': imp.jsf((typeSpec, value) => {
      // Single type conversion
      const convertOne = (typeSymbol: symbol, val: ImpVal): ImpVal => {
        const typeName = typeSymbol.description || ''

        switch (typeName) {
          case 'c': // to char (string)
            if (val[0] === ImpT.INT || val[0] === ImpT.NUM) {
              return ImpC.str(String.fromCharCode(val[2] as number))
            }
            throw "cast to char expects number"

          case 'i': // to int
            if (val[0] === ImpT.INT) return val
            if (val[0] === ImpT.NUM) return ImpC.int(Math.floor(val[2] as number))
            if (val[0] === ImpT.STR) {
              const str = val[2] as string
              return ImpC.int(str.charCodeAt(0))
            }
            throw "cast to int expects number or char"

          case 'f': // to float
            if (val[0] === ImpT.NUM) return val
            if (val[0] === ImpT.INT) return ImpC.num(val[2] as number)
            throw "cast to float expects number"

          case 'b': // to bool (0 or 1)
            if (val[0] === ImpT.INT || val[0] === ImpT.NUM) {
              return ImpC.int((val[2] as number) !== 0 ? 1 : 0)
            }
            throw "cast to bool expects number"

          default:
            throw `unknown cast type: ${typeName}`
        }
      }

      // Handle string to int vector
      if (ImpQ.isSym(typeSpec) && typeSpec[2].description === 'i' && value[0] === ImpT.STR) {
        const str = value[2] as string
        const codes = Array.from(str).map(c => c.charCodeAt(0))
        return ImpC.ints(codes)
      }

      // Handle int vector to string
      if (ImpQ.isSym(typeSpec) && typeSpec[2].description === 'c' && (value[0] === ImpT.INTs || value[0] === ImpT.NUMs)) {
        const nums = value[2] as number[]
        const str = nums.map(n => String.fromCharCode(n)).join('')
        return ImpC.str(str)
      }

      // Handle vector of type symbols applied to single value
      if (typeSpec[0] === ImpT.SYMs) {
        const types = typeSpec[2] as symbol[]
        const results: ImpVal[] = []
        for (const t of types) {
          results.push(convertOne(t, value))
        }
        // Return as vector if all same type
        const allInts = results.every(r => r[0] === ImpT.INT)
        const allNums = results.every(r => r[0] === ImpT.NUM)
        if (allInts) return ImpC.ints(results.map(r => r[2] as number))
        if (allNums) return ImpC.nums(results.map(r => r[2] as number))
        return imp.lst(undefined, results)
      }

      // Single type, single value
      if (ImpQ.isSym(typeSpec)) {
        return convertOne(typeSpec[2], value)
      }

      throw "cast expects symbol or symbol vector as first argument"
    }, 2),

    // value (monadic) - evaluate implish string or get dict values
    'value': imp.jsf(async x => {
      // For dictionaries, return the values
      if (ImpQ.isDct(x)) {
        const map = x[2] as Map<string, ImpVal>
        const values = Array.from(map.values())

        // Check if all values are the same type
        if (values.length === 0) return imp.lst(undefined, [])

        const firstType = values[0][0]
        if (firstType === ImpT.INT && values.every(v => v[0] === ImpT.INT)) {
          return ImpC.ints(values.map(v => v[2] as number))
        }
        if (firstType === ImpT.NUM && values.every(v => v[0] === ImpT.NUM)) {
          return ImpC.nums(values.map(v => v[2] as number))
        }
        if (firstType === ImpT.SYM && values.every(v => v[0] === ImpT.SYM)) {
          return ImpC.syms(values.map(v => v[2] as symbol))
        }

        // Mixed types, return as list
        return imp.lst(undefined, values)
      }

      // For strings, evaluate as implish code
      if (x[0] !== ImpT.STR) throw "value expects a string or dictionary"
      const str = x[2] as string
      const parsed = load(ImpC.str(str))
      return await impEval(parsed as any)
    }, 1),

    // prm (monadic) - generate all permutations
    'prm': imp.jsf(x => {
      // Helper to generate permutations
      const permute = <T,>(arr: T[]): T[][] => {
        if (arr.length <= 1) return [arr]
        const result: T[][] = []
        for (let i = 0; i < arr.length; i++) {
          const rest = [...arr.slice(0, i), ...arr.slice(i + 1)]
          const perms = permute(rest)
          for (const perm of perms) {
            result.push([arr[i], ...perm])
          }
        }
        return result
      }

      // Handle integer - generate permutations of int x
      if (x[0] === ImpT.INT) {
        const n = x[2] as number
        const indices = Array.from({length: n}, (_, i) => i)
        const perms = permute(indices)
        return imp.lst(undefined, perms.map(p => ImpC.ints(p)))
      }

      // Handle string - generate permutations of characters
      if (x[0] === ImpT.STR) {
        const str = x[2] as string
        const chars = str.split('')
        const perms = permute(chars)
        return imp.lst(undefined, perms.map(p => ImpC.str(p.join(''))))
      }

      // Handle list - generate permutations of elements
      if (ImpQ.isLst(x)) {
        const items = x[2] as ImpVal[]
        const perms = permute(items)
        return imp.lst(undefined, perms.map(p => imp.lst(x[1], p)))
      }

      throw "prm expects integer, string, or list"
    }, 1),

    // Adverbs (higher-order functions)
    'each': imp.jsf(async function(this: ImpEvaluator, f: ImpVal, x: ImpVal) {
      // each[f; x] - apply function f to each element of x
      // f must be a function (JSF or IFN)
      if (f[0] !== ImpT.JSF && f[0] !== ImpT.IFN) {
        throw "each: first argument must be a function"
      }

      // Handle atoms - apply directly
      if (x[0] === ImpT.INT || x[0] === ImpT.NUM || x[0] === ImpT.SYM || x[0] === ImpT.STR) {
        if (f[0] === ImpT.JSF) {
          return await (f as ImpJsf)[2].apply(this, [x])
        } else {
          return await this.applyIfn(f as ImpIfn, [x])
        }
      }

      // Handle vectors - map over each element
      if (x[0] === ImpT.INTs) {
        const vals = x[2] as number[]
        const results: number[] = []
        for (const val of vals) {
          const arg = ImpC.int(val)
          let result: ImpVal
          if (f[0] === ImpT.JSF) {
            result = await (f as ImpJsf)[2].apply(this, [arg])
          } else {
            result = await this.applyIfn(f as ImpIfn, [arg])
          }
          // Extract numeric result
          if (result[0] === ImpT.INT) {
            results.push(result[2] as number)
          } else if (result[0] === ImpT.NUM) {
            results.push(result[2] as number)
          } else {
            throw "each: function must return numeric values for numeric input"
          }
        }
        return ImpC.ints(results)
      }

      if (x[0] === ImpT.NUMs) {
        const vals = x[2] as number[]
        const results: number[] = []
        for (const val of vals) {
          const arg = ImpC.num(val)
          let result: ImpVal
          if (f[0] === ImpT.JSF) {
            result = await (f as ImpJsf)[2].apply(this, [arg])
          } else {
            result = await this.applyIfn(f as ImpIfn, [arg])
          }
          // Extract numeric result
          if (result[0] === ImpT.INT) {
            results.push(result[2] as number)
          } else if (result[0] === ImpT.NUM) {
            results.push(result[2] as number)
          } else {
            throw "each: function must return numeric values for numeric input"
          }
        }
        return ImpC.nums(results)
      }

      // Handle general lists - map over elements
      if (ImpQ.isLst(x)) {
        const items = x[2] as ImpVal[]
        const results: ImpVal[] = []
        for (const item of items) {
          let result: ImpVal
          if (f[0] === ImpT.JSF) {
            result = await (f as ImpJsf)[2].apply(this, [item])
          } else {
            result = await this.applyIfn(f as ImpIfn, [item])
          }
          results.push(result)
        }
        return imp.lst(x[1], results)
      }

      throw "each: second argument must be a list, vector, or atom"
    }, 2),

    'each2': imp.jsf(async function(this: ImpEvaluator, f: ImpVal, x: ImpVal, y: ImpVal) {
      // each2[f; x; y] - apply dyadic function f pairwise to x and y
      // f must be a function (JSF or IFN)
      if (f[0] !== ImpT.JSF && f[0] !== ImpT.IFN) {
        throw "each2: first argument must be a function"
      }

      // Helper to get length of a value
      const getLength = (v: ImpVal): number => {
        if (v[0] === ImpT.INTs || v[0] === ImpT.NUMs || v[0] === ImpT.SYMs) {
          return (v[2] as any[]).length
        }
        if (ImpQ.isLst(v)) {
          return (v[2] as ImpVal[]).length
        }
        return 1  // Atoms have length 1
      }

      // Helper to get element at index (with atom spreading)
      const getAt = (v: ImpVal, i: number): ImpVal => {
        if (v[0] === ImpT.INTs) {
          const vals = v[2] as number[]
          return ImpC.int(vals.length === 1 ? vals[0] : vals[i])
        }
        if (v[0] === ImpT.NUMs) {
          const vals = v[2] as number[]
          return ImpC.num(vals.length === 1 ? vals[0] : vals[i])
        }
        if (v[0] === ImpT.SYMs) {
          const vals = v[2] as symbol[]
          return ImpC.sym(vals.length === 1 ? vals[0] : vals[i], SymT.RAW)
        }
        if (ImpQ.isLst(v)) {
          const vals = v[2] as ImpVal[]
          return vals.length === 1 ? vals[0] : vals[i]
        }
        // Atom - always return itself
        return v
      }

      // Determine result length (max of x and y lengths, or 1 if both atoms)
      const xLen = getLength(x)
      const yLen = getLength(y)
      const resultLen = Math.max(xLen, yLen)

      // Build result list
      const results: ImpVal[] = []
      for (let i = 0; i < resultLen; i++) {
        const xArg = getAt(x, i)
        const yArg = getAt(y, i)
        let result: ImpVal
        if (f[0] === ImpT.JSF) {
          result = await (f as ImpJsf)[2].apply(this, [xArg, yArg])
        } else {
          result = await this.applyIfn(f as ImpIfn, [xArg, yArg])
        }
        results.push(result)
      }

      // Return as list (or single value if only one result)
      if (results.length === 1) {
        return results[0]
      }
      return imp.lst(undefined, results)
    }, 3),

    'over': imp.jsf(async function(this: ImpEvaluator, f: ImpVal, x: ImpVal) {
      // over[f; x] - reduce/fold x with dyadic function f
      // In K: +/ is "sum", */ is "product", etc.
      // f must be a dyadic function (JSF or IFN with arity 2)
      if (f[0] !== ImpT.JSF && f[0] !== ImpT.IFN) {
        throw "over: first argument must be a function"
      }

      // Check arity
      const arity = f[1].arity
      if (arity !== 2) {
        throw `over: function must have arity 2, got ${arity}`
      }

      // Convert to array
      const [items, _] = toArray(x)

      if (items.length === 0) {
        throw "over: cannot reduce empty sequence"
      }

      if (items.length === 1) {
        return items[0]
      }

      // Reduce from left to right
      let accumulator = items[0]
      for (let i = 1; i < items.length; i++) {
        if (f[0] === ImpT.JSF) {
          accumulator = await (f as ImpJsf)[2].apply(this, [accumulator, items[i]])
        } else {
          accumulator = await this.applyIfn(f as ImpIfn, [accumulator, items[i]])
        }
      }

      return accumulator
    }, 2),

    'scan': imp.jsf(async function(this: ImpEvaluator, f: ImpVal, x: ImpVal) {
      // scan[f; x] - like over but returns all intermediate results
      // In K: +\ is "running sum", *\ is "running product", etc.
      // f must be a dyadic function (JSF or IFN with arity 2)
      if (f[0] !== ImpT.JSF && f[0] !== ImpT.IFN) {
        throw "scan: first argument must be a function"
      }

      // Check arity
      const arity = f[1].arity
      if (arity !== 2) {
        throw `scan: function must have arity 2, got ${arity}`
      }

      // Convert to array
      const [items, wasString] = toArray(x)

      if (items.length === 0) {
        throw "scan: cannot scan empty sequence"
      }

      if (items.length === 1) {
        return fromArray([items[0]], wasString, ImpQ.isLst(x) ? x[1] : undefined)
      }

      // Scan from left to right, collecting all intermediate results
      const results: ImpVal[] = [items[0]]
      let accumulator = items[0]

      for (let i = 1; i < items.length; i++) {
        if (f[0] === ImpT.JSF) {
          accumulator = await (f as ImpJsf)[2].apply(this, [accumulator, items[i]])
        } else {
          accumulator = await this.applyIfn(f as ImpIfn, [accumulator, items[i]])
        }
        results.push(accumulator)
      }

      return fromArray(results, wasString, ImpQ.isLst(x) ? x[1] : undefined)
    }, 2),

    'bin': imp.jsf((x: ImpVal, y: ImpVal) => {
      // bin[x; y] - binary search for y in sorted list x
      // x must be a sorted list/vector
      // y can be an atom or list (right atomic)
      // Returns the index where y would be inserted to maintain sort order
      // -1 if y < first element, count if y > last element

      // Helper function to perform binary search on a sorted array
      // Returns the index of the largest element <= target
      const binarySearch = (arr: number[], target: number): number => {
        // If target is less than first element, return -1
        if (arr.length === 0 || target < arr[0]) {
          return -1
        }

        let left = 0
        let right = arr.length - 1

        while (left < right) {
          // Use mid biased toward right to find largest element <= target
          const mid = Math.floor((left + right + 1) / 2)
          if (arr[mid] <= target) {
            left = mid
          } else {
            right = mid - 1
          }
        }

        return left
      }

      // Extract numeric array from x
      let arr: number[]
      if (x[0] === ImpT.INTs || x[0] === ImpT.NUMs) {
        arr = x[2] as number[]
      } else if (ImpQ.isLst(x)) {
        // Try to extract numbers from list
        const items = x[2] as ImpVal[]
        arr = []
        for (const item of items) {
          if (item[0] === ImpT.INT || item[0] === ImpT.NUM) {
            arr.push(item[2] as number)
          } else {
            throw "bin: left argument must be a sorted numeric list"
          }
        }
      } else {
        throw "bin: left argument must be a sorted numeric list"
      }

      // Handle right-atomic behavior
      if (y[0] === ImpT.INT || y[0] === ImpT.NUM) {
        const target = y[2] as number
        return ImpC.int(binarySearch(arr, target))
      } else if (y[0] === ImpT.INTs || y[0] === ImpT.NUMs) {
        const targets = y[2] as number[]
        const results = targets.map(t => binarySearch(arr, t))
        return ImpC.ints(results)
      } else if (ImpQ.isLst(y)) {
        const items = y[2] as ImpVal[]
        const results: number[] = []
        for (const item of items) {
          if (item[0] === ImpT.INT || item[0] === ImpT.NUM) {
            results.push(binarySearch(arr, item[2] as number))
          } else {
            throw "bin: right argument must be numeric"
          }
        }
        return ImpC.ints(results)
      } else {
        throw "bin: right argument must be numeric"
      }
    }, 2),

    'join': imp.jsf((x: ImpVal, y: ImpVal) => {
      // join[sep; list] - join strings with separator
      // x is the separator (string or character)
      // y is a list of strings to join

      // Extract separator
      let sep: string
      if (x[0] === ImpT.STR) {
        sep = x[2] as string
      } else {
        throw "join: left argument (separator) must be a string"
      }

      // Extract strings from y
      if (!ImpQ.isLst(y)) {
        throw "join: right argument must be a list of strings"
      }

      const items = y[2] as ImpVal[]
      const strings: string[] = []

      for (const item of items) {
        if (item[0] === ImpT.STR) {
          strings.push(item[2] as string)
        } else {
          throw "join: right argument must be a list of strings"
        }
      }

      return ImpC.str(strings.join(sep))
    }, 2),

    'encode': imp.jsf((x: ImpVal, y: ImpVal) => {
      // encode[base; digits] - combine digits in base to single value
      // x is the base(s) - can be a single number or list of bases
      // y is the digits

      // Extract bases
      let bases: number[]
      if (x[0] === ImpT.INT || x[0] === ImpT.NUM) {
        // Single base - will be repeated
        const base = x[2] as number
        bases = []
      } else if (x[0] === ImpT.INTs || x[0] === ImpT.NUMs) {
        bases = x[2] as number[]
      } else {
        throw "encode: left argument must be numeric"
      }

      // Extract digits
      let digits: number[]
      if (y[0] === ImpT.INT || y[0] === ImpT.NUM) {
        digits = [y[2] as number]
      } else if (y[0] === ImpT.INTs || y[0] === ImpT.NUMs) {
        digits = y[2] as number[]
      } else {
        throw "encode: right argument must be numeric"
      }

      // If x is a single number, repeat it for all digits
      if (x[0] === ImpT.INT || x[0] === ImpT.NUM) {
        const base = x[2] as number
        bases = new Array(digits.length).fill(base)
      }

      // Encode from right to left
      let result = 0
      let multiplier = 1

      for (let i = digits.length - 1; i >= 0; i--) {
        result += digits[i] * multiplier
        if (i > 0) {
          multiplier *= bases[i]
        }
      }

      return ImpC.int(result)
    }, 2),

    'split': imp.jsf((x: ImpVal, y: ImpVal) => {
      // split[sep; str] - split string at separator
      // x is the separator (string or character)
      // y is the string to split

      // Extract separator
      let sep: string
      if (x[0] === ImpT.STR) {
        sep = x[2] as string
      } else {
        throw "split: left argument (separator) must be a string"
      }

      // Extract string to split
      let str: string
      if (y[0] === ImpT.STR) {
        str = y[2] as string
      } else {
        throw "split: right argument must be a string"
      }

      // Split and convert to list of strings
      const parts = str.split(sep)
      const result: ImpVal[] = parts.map(s => ImpC.str(s))

      return imp.lst(undefined, result)
    }, 2),

    'decode': imp.jsf((x: ImpVal, y: ImpVal) => {
      // decode[base; value] - split value into base representation
      // x is the base(s) - can be a single number or list of bases
      // y is the value to decode

      // Extract bases
      let bases: number[]
      if (x[0] === ImpT.INT || x[0] === ImpT.NUM) {
        // Single base - will be used for all positions
        const base = x[2] as number
        bases = [base] // Will be extended as needed
      } else if (x[0] === ImpT.INTs || x[0] === ImpT.NUMs) {
        bases = x[2] as number[]
      } else {
        throw "decode: left argument must be numeric"
      }

      // Extract value
      let value: number
      if (y[0] === ImpT.INT || y[0] === ImpT.NUM) {
        value = y[2] as number
      } else {
        throw "decode: right argument must be a number"
      }

      // If single base, extend to match number of digits needed
      const singleBase = (x[0] === ImpT.INT || x[0] === ImpT.NUM) ? (x[2] as number) : null

      if (singleBase !== null) {
        // Determine how many digits we need
        const numDigits = bases.length
        const digits: number[] = []
        let remaining = value

        for (let i = numDigits - 1; i >= 0; i--) {
          digits.unshift(remaining % singleBase)
          remaining = Math.floor(remaining / singleBase)
        }

        return ImpC.ints(digits)
      } else {
        // Use provided bases from right to left
        const digits: number[] = []
        let remaining = value

        for (let i = bases.length - 1; i >= 0; i--) {
          digits.unshift(remaining % bases[i])
          remaining = Math.floor(remaining / bases[i])
        }

        return ImpC.ints(digits)
      }
    }, 2),

    'window': imp.jsf((x: ImpVal, y: ImpVal) => {
      // window[size; list] - create sliding windows of size from list
      // x is the window size
      // y is the list to window

      // Extract window size
      let size: number
      if (x[0] === ImpT.INT) {
        size = x[2] as number
      } else {
        throw "window: left argument (window size) must be an integer"
      }

      // Handle special cases
      if (size < 0) {
        throw "window: negative window sizes not yet implemented"
      }
      if (size === 0) {
        throw "window: zero window size not yet implemented"
      }

      const [elements, wasString] = toArray(y)

      // Create sliding windows
      const windows: ImpVal[] = []

      for (let i = 0; i <= elements.length - size; i++) {
        const windowItems = elements.slice(i, i + size)
        windows.push(fromArray(windowItems, wasString, ImpQ.isLst(y) ? y[1] : undefined))
      }

      return imp.lst(undefined, windows)
    }, 2),

    // Special Forms
    'splice': imp.jsf(async function(this: any, list: ImpVal, interval: ImpVal, value: ImpVal) {
      // splice[list; [start end]; value] - replaces elements in interval with value
      // splice[list; [start end]; fn] - applies fn to interval elements
      // Examples:
      //   splice[1 2 3; 1 1; 4] → 1 4 2 3
      //   splice["test"; 1 3; "u"] → "tut"
      //   splice["hello world"; 0 5; "goodbye"] → "goodbye world"
      //   splice[2 7 9; 1 2; {times[2; x]}] → 2 14 9
      //   splice["a look back"; 2 6; reverse] → "a kool back"

      // Extract interval bounds
      if (!ImpQ.isLst(interval) && interval[0] !== ImpT.INTs) {
        throw "splice: interval must be a list [start end]"
      }

      let start: number, end: number
      if (interval[0] === ImpT.INTs) {
        const bounds = interval[2] as number[]
        if (bounds.length !== 2) {
          throw "splice: interval must have exactly 2 elements [start end]"
        }
        start = bounds[0]
        end = bounds[1]
      } else if (ImpQ.isLst(interval)) {
        const bounds = interval[2] as ImpVal[]
        if (bounds.length !== 2) {
          throw "splice: interval must have exactly 2 elements [start end]"
        }
        if (bounds[0][0] !== ImpT.INT || bounds[1][0] !== ImpT.INT) {
          throw "splice: interval elements must be integers"
        }
        start = bounds[0][2] as number
        end = bounds[1][2] as number
      } else {
        throw "splice: invalid interval format"
      }

      // Check if value is a function
      const isFunction = value[0] === ImpT.JSF || ImpQ.isIfn(value)

      // Handle string splicing
      if (list[0] === ImpT.STR) {
        const str = list[2] as string
        if (isFunction) {
          // Apply function to the substring
          const substring = ImpC.str(str.slice(start, end))
          let transformedVal: ImpVal
          if (value[0] === ImpT.JSF) {
            const fn = value[2] as any
            transformedVal = await fn.call(this, substring)
          } else {
            // IFN - need to implement
            throw "splice with implish function not yet implemented"
          }
          const newStr = transformedVal[0] === ImpT.STR ? (transformedVal[2] as string) : String(transformedVal[2])
          const result = str.slice(0, start) + newStr + str.slice(end)
          return ImpC.str(result)
        } else {
          const newStr = value[0] === ImpT.STR ? (value[2] as string) : String(value[2])
          const result = str.slice(0, start) + newStr + str.slice(end)
          return ImpC.str(result)
        }
      }

      // Handle list/vector splicing
      let elements: ImpVal[]
      if (list[0] === ImpT.INTs) {
        const nums = list[2] as number[]
        elements = nums.map(n => ImpC.int(n))
      } else if (list[0] === ImpT.NUMs) {
        const nums = list[2] as number[]
        elements = nums.map(n => ImpC.num(n))
      } else if (ImpQ.isLst(list)) {
        elements = list[2] as ImpVal[]
      } else {
        throw "splice: first argument must be a list or string"
      }

      // Build the result by replacing the interval
      let result: ImpVal[]

      if (isFunction) {
        // Apply function to the interval elements
        const intervalElements = elements.slice(start, end)

        // Create appropriate input for the function
        let fnInput: ImpVal
        if (list[0] === ImpT.INTs) {
          fnInput = ImpC.ints(intervalElements.map(x => x[2] as number))
        } else if (list[0] === ImpT.NUMs) {
          fnInput = ImpC.nums(intervalElements.map(x => x[2] as number))
        } else {
          fnInput = imp.lst(undefined, intervalElements)
        }

        if (value[0] === ImpT.JSF) {
          const fn = value[2] as any
          const transformedVal = await fn.call(this, fnInput)

          // Convert result back to elements array
          let replacementElements: ImpVal[]
          if (transformedVal[0] === ImpT.INTs) {
            const nums = transformedVal[2] as number[]
            replacementElements = nums.map(n => ImpC.int(n))
          } else if (transformedVal[0] === ImpT.NUMs) {
            const nums = transformedVal[2] as number[]
            replacementElements = nums.map(n => ImpC.num(n))
          } else if (ImpQ.isLst(transformedVal)) {
            replacementElements = transformedVal[2] as ImpVal[]
          } else {
            // Single element result
            replacementElements = [transformedVal]
          }

          result = [
            ...elements.slice(0, start),
            ...replacementElements,
            ...elements.slice(end)
          ]
        } else {
          // IFN - need to implement
          throw "splice with implish function not yet implemented"
        }
      } else {
        // Simple replacement with value
        result = [
          ...elements.slice(0, start),
          value,
          ...elements.slice(end)
        ]
      }

      // Try to preserve strand type
      if (list[0] === ImpT.INTs && result.every(x => x[0] === ImpT.INT)) {
        return ImpC.ints(result.map(x => x[2] as number))
      } else if (list[0] === ImpT.NUMs && result.every(x => x[0] === ImpT.NUM)) {
        return ImpC.nums(result.map(x => x[2] as number))
      }

      return imp.lst(undefined, result)
    }, 3),

    'try': imp.jsf(async function(this: any, fn: ImpVal, args: ImpVal) {
      // try[fn; args] - calls fn with args, catches errors
      // Returns [0; result] on success, [1; error-message] on failure
      // Examples:
      //   try[{plus[1; x]}; (1)] → [0 2]
      //   try[{plus[1; x]}; (`a)] → [1; ?type]

      try {
        // Apply function to arguments
        let result: ImpVal

        if (fn[0] === ImpT.JSF) {
          // For JSF, need to extract arguments from the list/tuple
          let argList: ImpVal[]
          if (ImpQ.isLst(args)) {
            argList = args[2] as ImpVal[]
          } else {
            argList = [args]
          }

          const jsfn = fn[2] as any
          result = await jsfn.call(this, ...argList)
        } else if (ImpQ.isIfn(fn)) {
          // For implish functions, use the same pattern as 'at'
          const arity = fn[1].arity
          if (arity !== 1) throw `try with implish function expects arity 1, got ${arity}`

          const body = fn[2] as ImpVal[]
          throw "try with implish function not yet implemented"
        } else {
          throw "try: first argument must be a function"
        }

        // Success: return [0; result]
        return imp.lst(undefined, [ImpC.int(0), result])
      } catch (error) {
        // Failure: return [1; error-message]
        const errorMsg = error instanceof Error ? error.message : String(error)
        return imp.lst(undefined, [ImpC.int(1), ImpC.str(errorMsg)])
      }
    }, 2),

    'cond': imp.jsf(async function(this: ImpEvaluator, ...args: ImpVal[]) {
      // cond[condition1; value1; condition2; value2; ...; default]
      // Like Lisp cond: evaluates conditions in pairs, returns first matching value
      // If no conditions match, returns final value
      // Examples:
      //   cond[1; "A"; 0; "B"; "C"] → "A"
      //   cond[0; "A"; 0; "B"; "C"] → "C"

      if (args.length < 3) {
        throw "cond: requires at least 3 arguments (condition, value, default)"
      }

      // Process pairs of (condition, value)
      for (let i = 0; i < args.length - 1; i += 2) {
        const condArg = args[i]
        const valueArg = args[i + 1]

        // Evaluate condition if it's an expression
        let condResult: ImpVal
        if (ImpQ.isLst(condArg) || ImpQ.isTop(condArg)) {
          condResult = await this.lastEval(condArg)
        } else {
          condResult = condArg
        }

        // Check if truthy (K semantics: 0, 0x00, nil are falsy)
        let isTruthy = false
        if (condResult[0] === ImpT.INT || condResult[0] === ImpT.NUM) {
          isTruthy = (condResult[2] as number) !== 0
        } else if (condResult[0] === ImpT.NIL) {
          isTruthy = false
        } else if (condResult[0] === ImpT.STR && condResult[2] === "\x00") {
          isTruthy = false
        } else {
          isTruthy = true
        }

        // If truthy, evaluate and return the value
        if (isTruthy) {
          if (ImpQ.isLst(valueArg) || ImpQ.isTop(valueArg)) {
            return await this.lastEval(valueArg)
          } else {
            return valueArg
          }
        }
      }

      // No conditions matched, return default (last argument)
      const defaultArg = args[args.length - 1]
      if (ImpQ.isLst(defaultArg) || ImpQ.isTop(defaultArg)) {
        return await this.lastEval(defaultArg)
      } else {
        return defaultArg
      }
    }, -1),  // -1 indicates variadic
  }

  // Add sourceName to all JSF entries for better display in partial applications
  for (const [name, value] of Object.entries(words)) {
    if (value[0] === ImpT.JSF) {
      (value as ImpJsf)[1].sourceName = name
    }
  }

  return words
}
