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
  ImpStr, ImpC, ImpTop, ImpErr, ImpLst, ImpDct
} from './imp-core.mjs'
import {impShow} from './imp-show.mjs'
import {imparse} from './im-parse.mjs'
import {
  createImpWords,
  setInputProvider as setInputProviderDefs,
  setReadlineInterface as setReadlineInterfaceDefs,
  setOutputProvider as setOutputProviderDefs,
  type InputProvider,
  type OutputProvider
} from './imp-defs.mjs'

// Re-export the provider interfaces and functions
export type {InputProvider, OutputProvider}
export function setInputProvider(provider: InputProvider | null) {
  setInputProviderDefs(provider)
}
export function setReadlineInterface(rl: any | null) {
  setReadlineInterfaceDefs(rl)
}
export function setOutputProvider(provider: OutputProvider) {
  setOutputProviderDefs(provider)
}

// Identity values for fold operations (for empty arrays)
const foldIdentities: Record<string, number> = {
  '+': 0,
  '*': 1,
  'min': Infinity,
  'max': -Infinity,
}

// Create and export the word dictionary
export let impWords: Record<string, ImpVal> = createImpWords()

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
      case ImpT.DCT: return ImpP.N
      case ImpT.INTs: return ImpP.N
      case ImpT.NUMs: return ImpP.N
      case ImpT.SYMs: return ImpP.N
      // -- resolved symbols:
      case ImpT.JSF: return ImpP.V
      case ImpT.IFN: return ImpP.V
      case ImpT.NIL: return ImpP.N
      default: throw "[wordClass] invalid argument:" + x }}

export class ImpEvaluator {
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
              // Create the fold or scan operator (don't cache it)
              if (name.endsWith('/')) {
                w = this.createFoldOperator(baseName, baseOp)
              } else {
                w = this.createScanOperator(baseName, baseOp)
              }
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
    // NOTE: imparse() now handles prefix/infix/postfix/comma threading
    // This code ONLY runs for cases that imparse deliberately skipped:
    // - Special symbols (SET, GET, LIT): 1 + a: 10, 2, + x: 5
    //
    // For all other cases, imparse transforms to M-expressions (+[2; 3])
    // and the evaluator handles them via project() instead.
    //
    // TODO: Once imparse handles special symbols, this entire
    // function can be deleted and eval can just handle M-expressions.

    // Handle dictionary backtick indexing: d`key
    let res = x
    if (x[0] === ImpT.DCT) {
      // Check if next item is a backtick symbol (or strand of backtick symbols)
      while (true) {
        let p = this.peek()
        // Accept both single backtick symbols (ImpP.Q) and SYMs vectors (strands)
        if (!p || (p.wc !== ImpP.Q && p.item[0] !== ImpT.SYMs)) break

        let key = this.nextItem()

        // Handle single backtick symbol or strand of symbols
        const dct = (res as ImpDct)[2]
        if (ImpQ.isSym(key)) {
          const keyName = key[2].description || ''
          const value = dct.get(keyName)
          res = value !== undefined ? value : NIL
        } else if (key[0] === ImpT.SYMs) {
          // Vector of symbols - lookup each one
          const results: ImpVal[] = []
          for (const k of key[2]) {
            const keyName = k.description || ''
            const value = dct.get(keyName)
            results.push(value !== undefined ? value : NIL)
          }
          res = imp.lst(undefined, results)
        } else {
          throw "dictionary keys must be backtick symbols"
        }
      }
    }

    // Check if next token is an arity-2 verb (works as infix operator)
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

      // Collect the right operand
      // NOTE: imparse() prefix pass already transformed "a + ! b" → "+[a; ![b]]"
      // So we only see simple nouns here (verbs are already applied)
      let arg: ImpVal | null = null
      try {
        arg = await this.nextNounItem()
      } catch (e) {
        // If we can't get a right argument (e.g., hit END), create partial application
        if (String(e).includes("unexpected end of input")) {
          // Create partial application with left argument captured
          if (op[0] === ImpT.IFN) {
            return await this.applyIfn(op as ImpIfn, [res])
          } else {
            let originalFn = op as ImpJsf
            let capturedArgs = [res]
            return [ImpT.JSF, {
              arity: 1,
              sourceIfn: originalFn,
              capturedArgs: capturedArgs,
              sourceName: originalFn[1].sourceName
            }, async (...remainingArgs: ImpVal[]) => {
              return await originalFn[2].apply(this, [...capturedArgs, ...remainingArgs])
            }]
          }
        }
        throw e
      }

      // Apply the arity-2 verb
      if (op[0] === ImpT.IFN) {
        res = await this.applyIfn(op as ImpIfn, [res, arg])
      } else {
        res = await (op as ImpJsf)[2].apply(this, [res, arg])
      }
    }
    return res }


  // Collect next noun - handles assignments, get-words, verbs, and regular nouns
  private async nextNounItem(): Promise<ImpVal> {
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
      // For monadic (arity-1) functions, collect eagerly (no lookahead for infix ops)
      let eagerly = (arity === 1)
      for (let i = 0; i < arity; i++) {
        if (this.atEnd()) break
        try {
          args.push(await this.nextNoun(eagerly))
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
            capturedArgs: capturedArgs,
            sourceName: originalFn[1].sourceName
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
    // Evaluate the noun (strands are already formed by imparse())
    return await this.eval(res)
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
      // Apply infix operators (strands are already formed by imparse())
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
      // For monadic (arity-1) functions, collect eagerly (no lookahead for infix ops)
      let eagerly = (arity === 1)
      for (let i = 0; i < arity; i++) {
        if (this.atEnd()) break
        try {
          args.push(await this.nextNoun(eagerly))
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
            capturedArgs: capturedArgs,
            sourceName: originalFn[1].sourceName
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

  nextNoun = async (eagerly: boolean = false): Promise<ImpVal> => {
    // Get next noun item
    // If eagerly=true (for monadic functions), don't look ahead for infix operators
    // If eagerly=false (default), apply infix operators via modifyNoun
    let res = await this.nextNounItem()
    if (!eagerly) {
      res = await this.modifyNoun(res)
    }
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
    // If it's a list, parse it first to form strands, then recursively quasiquote
    if (ImpQ.isLst(x)) {
      // First parse to combine adjacent literals into strands
      // Pass this.words so imparse can do full transformations
      let refined = imparse(x, this.words)

      // imparse might return TOP or LST - extract items appropriately
      let items: ImpVal[]
      let attrs: any
      if (refined[0] === ImpT.TOP) {
        items = refined[2] as ImpVal[]
        attrs = x[1]  // Use original list's attrs (opener/closer)
      } else {
        items = refined[2] as ImpVal[]
        attrs = refined[1]
      }

      let results: ImpVal[] = []
      for (let item of items) {
        results.push(await this.quasiquote(item))
      }
      // Strip the backtick from the opener to return an unquoted list
      let newOpen = attrs.open.startsWith('`') ? attrs.open.slice(1) : attrs.open
      return imp.lst({open: newOpen, close: attrs.close}, results)
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
          if (res[1].arity as number !== 1) throw "composition requires arity 1"
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
      if (x[0] === ImpT.INT || x[0] === ImpT.NUM || x[0] === ImpT.SYM) {
        return x
      }

      // Try numeric-only path first for backward compatibility
      if (x[0] === ImpT.INTs || x[0] === ImpT.NUMs) {
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
      }

      // General case: use the 'over' adverb for lists, strings, etc.
      const overFn = this.words['over']
      if (!overFn) {
        throw `${baseName}/ requires 'over' adverb for non-numeric sequences`
      }

      // Apply over[baseOp; x]
      if (overFn[0] === ImpT.JSF) {
        return await (overFn as ImpJsf)[2].apply(this, [baseOp, x])
      }

      throw `${baseName}/ could not apply fold operation`
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
      if (x[0] === ImpT.SYM) {
        return ImpC.syms([x[2] as symbol])
      }

      // Try numeric-only path first for backward compatibility
      if (x[0] === ImpT.INTs || x[0] === ImpT.NUMs) {
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
      }

      // General case: use the 'scan' adverb for lists, strings, etc.
      const scanFn = this.words['scan']
      if (!scanFn) {
        throw `${baseName}\\ requires 'scan' adverb for non-numeric sequences`
      }

      // Apply scan[baseOp; x]
      if (scanFn[0] === ImpT.JSF) {
        return await (scanFn as ImpJsf)[2].apply(this, [baseOp, x])
      }

      throw `${baseName}\\ could not apply scan operation`
    }, 1)
  }

  // evaluate a list
  evalList = async (xs:ImpLst|ImpTop): Promise<ImpVal[]> => {
    // First, parse/normalize the tree (strands + M-expressions)
    xs = imparse(xs, this.words) as ImpLst|ImpTop
    // walk from left to right, building up values to emit
    let done = false, tb: TreeBuilder<ImpVal> = new TreeBuilder()
    this.enter(xs)
    while (!done) {
      // Handle separators - check for comma-verb sequencing
      this.nextItem()
      while (this.item && this.item[0] === ImpT.SEP && !this.atEnd()) {
        // NOTE: imparse() now handles comma threading for normal cases
        // This code ONLY runs when imparse skipped transformation:
        // - Special symbols (SET, GET, LIT): 2, + x: 10
        //
        // Check if this is a comma followed by a verb (sequencing operator)
        if (this.item[2] === ',') {
          let p = this.peek()
          if (p && p.wc === ImpP.V && tb.root.length > 0) {
            // Get the last emitted value
            let lastVal = (tb.root as ImpVal[]).pop()!
            // Consume the comma and get the verb
            let op = this.nextItem()
            let arity = 0
            if (op[0] === ImpT.JSF) {
              arity = (op as ImpJsf)[1].arity
            } else if (op[0] === ImpT.IFN) {
              arity = (op as ImpIfn)[1].arity
            }

            if (arity === 1) {
              // Arity-1: apply verb to last value
              if (op[0] === ImpT.IFN) {
                lastVal = await this.applyIfn(op as ImpIfn, [lastVal])
              } else {
                lastVal = await (op as ImpJsf)[2].apply(this, [lastVal])
              }
            } else if (arity === 2) {
              // Arity-2: collect right arg and apply
              let arg = await this.nextNoun()
              if (op[0] === ImpT.IFN) {
                lastVal = await this.applyIfn(op as ImpIfn, [lastVal, arg])
              } else {
                lastVal = await (op as ImpJsf)[2].apply(this, [lastVal, arg])
              }
            } else {
              throw `Comma-verb sequencing requires verb of arity 1 or 2, got arity ${arity}`
            }
            // Emit the modified value
            tb.emit(lastVal)
            // Continue with next item
            this.nextItem()
            continue
          }
        }
        // Regular separator, just skip it
        this.nextItem()
      }
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
          // Collect arguments, stopping if we hit END or separator
          // For monadic (arity-1) functions, collect eagerly (no lookahead for infix ops)
          let eagerly = (arity === 1)
          for (let i = 0; i < arity; i++) {
            if (this.atEnd()) break
            // Peek ahead to see if next is a separator - if so, stop collecting args
            let nextPos = this.pos
            if (nextPos < this.here.length && this.here[nextPos][0] === ImpT.SEP) break
            try {
              args.push(await this.nextNoun(eagerly))
            } catch (e) {
              // If we can't get an argument, stop collecting
              if (String(e).includes("unexpected end of input") ||
                  String(e).includes("expected a noun")) break
              throw e
            }
          }
          // Apply the verb and get result
          let result: ImpVal
          if (x[0] === ImpT.IFN) {
            result = await this.applyIfn(x as ImpIfn, args)
          } else {
            // JSF - check if we need partial application
            if (args.length < arity) {
              // Create partial application
              let partialArity = arity - args.length
              let capturedArgs = args
              let originalFn = x as ImpJsf
              result = [ImpT.JSF, {
                arity: partialArity,
                sourceIfn: originalFn,
                capturedArgs: capturedArgs,
                sourceName: originalFn[1].sourceName
              }, async (...remainingArgs: ImpVal[]) => {
                return await originalFn[2].apply(this, [...capturedArgs, ...remainingArgs])
              }]
            } else {
              result = await (x as ImpJsf)[2].apply(this, args)
            }
          }
          // Apply infix operators to the result (if any)
          result = await this.modifyNoun(result)
          tb.emit(result)
          break
        case ImpP.N:
          // Evaluate the noun, then apply operators (strands are already formed by imparse())
          x = await this.eval(x)
          // Check if evaluation produced a verb (e.g., {x * 2} → IFN)
          if (this.wordClass(x) === ImpP.V) {
            // Only try to apply if there are more items (don't fail at END)
            // This allows {x + 2} to return a function value instead of trying to collect args
            if (!this.atEnd()) {
              // Apply verb modifiers (composition, etc.) only to JSF for now
              if (x[0] === ImpT.JSF) {
                x = this.modifyVerb(x as ImpJsf)
              }
              let args = []
              // Get arity from function metadata
              let arity = (x[1] as ImpJsfA | ImpIfnA).arity
              for (let i = 0; i < arity; i++) {
                if (this.atEnd()) break  // Stop if we run out of arguments
                try {
                  args.push(await this.nextNoun())
                } catch (e) {
                  // If we can't get an argument (e.g., hit END), stop collecting
                  if (String(e).includes("unexpected end of input")) break
                  throw e
                }
              }
              if (x[0] === ImpT.IFN) {
                tb.emit(await this.applyIfn(x as ImpIfn, args))
              } else {
                tb.emit(await (x as ImpJsf)[2].apply(this, args))
              }
            } else {
              // At end - just emit the verb as a value
              tb.emit(x)
            }
          } else {
            x = await this.modifyNoun(x)
            tb.emit(x)
          }
          break
        case ImpP.Q:
          // Quotes (strands of backtick symbols are already formed by imparse())
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

    // Check if f is a dictionary - if so, handle dictionary indexing
    if (f[0] === ImpT.DCT) {
      const dct = (f as ImpDct)[2]
      const results: ImpVal[] = []

      // Collect all keys (handles both single keys and strands)
      for (let x of xs) {
        if (x[0] === ImpT.SEP) continue

        // Evaluate the key expression
        let key = await this.eval(x)

        // Handle key as symbol or vector of symbols
        if (ImpQ.isSym(key)) {
          const keyName = key[2].description || ''
          const value = dct.get(keyName)
          results.push(value !== undefined ? value : NIL)
        } else if (key[0] === ImpT.SYMs) {
          // Vector of symbols - lookup each one
          for (const k of key[2]) {
            const keyName = k.description || ''
            const value = dct.get(keyName)
            results.push(value !== undefined ? value : NIL)
          }
        } else {
          throw "dictionary keys must be symbols"
        }
      }

      // Return single value or vector
      if (results.length === 0) return NIL
      if (results.length === 1) return results[0]
      return imp.lst(undefined, results)
    }

    let args = [], arg = imp.lst()
    for (let x of xs) {
      if (x[0] === ImpT.SEP) { args.push(arg); arg = imp.lst() }
      else imp.push(arg,x)}
    args.push(arg)

    // Special forms (ite, while, cond) need lazy evaluation - pass unevaluated args
    let lazyEvalForms = ['ite', 'while', 'cond']
    let evaluatedArgs = []
    if (lazyEvalForms.includes(sym)) {
      // Pass arguments as-is (unevaluated LST values)
      evaluatedArgs = args
    } else {
      // Normal evaluation: evaluate all args first, then apply
      for (let a of args) {
        evaluatedArgs.push(await this.lastEval(a))
      }
    }

    // Check if it's a user-defined function (IFN) or JavaScript function (JSF)
    if (f[0] === ImpT.IFN) {
      return await this.applyIfn(f as ImpIfn, evaluatedArgs)
    } else if (f[0] === ImpT.JSF) {
      // Check arity for JSF functions
      const expectedArity = (f as ImpJsf)[1].arity
      // Variadic functions have arity -1 and accept any number of arguments
      if (expectedArity === -1) {
        return await (f as ImpJsf)[2].apply(this, evaluatedArgs)
      } else if (evaluatedArgs.length < expectedArity) {
        // Partial application - create a new function with captured arguments
        let partialArity = expectedArity - evaluatedArgs.length
        let capturedArgs = evaluatedArgs
        let originalFn = f as ImpJsf
        return [ImpT.JSF, {
          arity: partialArity,
          sourceIfn: originalFn,
          capturedArgs: capturedArgs,
          sourceName: originalFn[1].sourceName
        }, async (...remainingArgs: ImpVal[]) => {
          return await originalFn[2].apply(this, [...capturedArgs, ...remainingArgs])
        }]
      } else if (evaluatedArgs.length > expectedArity) {
        throw `[project] ${sym}: valence error: expected ${expectedArity} args, got ${evaluatedArgs.length}`
      }
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
      case ImpT.JSF: return x
      case ImpT.IFN: return x
      case ImpT.DCT: return x
      case ImpT.LST:
        let [_, a, v] = x
        // Check if list is quoted (starts with ' or `)
        let opener = a.open || '['
        // Handle dictionary literals: :[`a 1; `b 2; `c `d]
        if (opener === ':[') {
          const dctMap = new Map<string, ImpVal>()
          let i = 0
          while (i < v.length) {
            // Skip separators and commas
            if (v[i][0] === ImpT.SEP) { i++; continue }
            if (i >= v.length) break

            // Get key (must be backtick symbol)
            const keyItem = v[i]
            if (!ImpQ.isSym(keyItem)) {
              throw "dictionary keys must be backtick symbols"
            }
            if (keyItem[1].kind !== SymT.BQT) {
              throw "dictionary keys must be backtick symbols (e.g., `a)"
            }
            const actualKeyName = keyItem[2].description || ''
            i++

            // Collect the value expression (everything until the next separator or end)
            if (i >= v.length) throw "dictionary key without value"
            const valueExprs: ImpVal[] = []
            while (i < v.length && v[i][0] !== ImpT.SEP) {
              valueExprs.push(v[i])
              i++
            }

            // Evaluate the value expression as a TOP (sequence)
            const value = await this.lastEval(ImpC.top(valueExprs))

            dctMap.set(actualKeyName, value)
          }
          return imp.dct(dctMap)
        }
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
