/** Implish evaluator
 *
 * Runs code right to left, as in K. The parser (im-parse.mts) builds a
 * syntax tree for one statement at a time; this file runs that tree.
 * See docs/evaluator.md for the rules.
 */
import * as imp from './imp-core.mjs'
import {
  ImpT,
  ImpVal,
  ImpQ,
  NIL,
  SymT,
  ImpJsf,
  ImpIfn,
  ImpC, ImpTop, ImpErr, ImpLst, ImpDct
} from './imp-core.mjs'
import {impShow} from './imp-show.mjs'
import {statements, readData, scanArity, splitArgs, formStrands, type Node} from './im-parse.mjs'
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

// Reset the word dictionary to built-ins only
export function resetWords() {
  impWords = createImpWords()
}

export class ImpEvaluator {
  words: Record<string, ImpVal> = impWords

  constructor(_root?: ImpVal[]) {}

  // -- running code ----------------------------------------------------------

  /** Run a list of tokens as code. Returns the value of each statement. */
  runCode = async (items: ImpVal[]): Promise<ImpVal[]> => {
    const results: ImpVal[] = []
    for (const step of statements(items, () => this.words)) {
      if (step.k === 'need') {
        // The parser needs this value before it can go on (see Need).
        step.hold.value = await this.evalNode(step.hold.src)
        continue
      }
      results.push(await this.evalNode(step))
    }
    return results
  }

  /** Run the items of a list (or TOP) as code; return all statement values. */
  evalList = async (xs: ImpLst | ImpTop): Promise<ImpVal[]> =>
    await this.runCode(xs[2])

  /** Run the items of a list (or TOP) as code; return the last value. */
  lastEval = async (xs: ImpLst | ImpTop): Promise<ImpVal> => {
    const res = await this.evalList(xs)
    return res.length ? res[res.length - 1] : NIL
  }

  /** Look up a word. Fold (+/) and scan (+\) words are made on demand. */
  lookup = (name: string): ImpVal => {
    const w = this.words[name]
    if (w !== undefined) return w
    if (name.endsWith('/') || name.endsWith('\\')) {
      const baseName = name.slice(0, -1)
      const baseOp = this.words[baseName]
      if (baseOp && baseOp[0] === ImpT.JSF && baseOp[1].arity === 2) {
        return name.endsWith('/')
          ? this.createFoldOperator(baseName, baseOp)
          : this.createScanOperator(baseName, baseOp)
      }
    }
    throw "undefined word: " + name
  }

  /** Run one syntax tree node. */
  evalNode = async (n: Node): Promise<ImpVal> => {
    switch (n.k) {
      case 'val': return await this.eval(n.v)
      case 'quote': return n.v   // a raw token, not run (the ? word)
      case 'ref': return this.lookup(n.name)
      case 'get': return this.lookup(n.name)
      case 'set': {
        const v = await this.evalNode(n.rhs)
        this.words[n.name] = v
        return v
      }
      case 'verb': return n.name !== undefined ? this.lookup(n.name) : await this.eval(n.src!)
      case 'hold':
        if (n.value === undefined) throw "internal error: comma value used before it was set"
        return n.value
      case 'thread': {
        // The clause left of the comma runs first. Usually it already
        // ran while the statement was parsed (see Need in im-parse).
        if (n.hold.value === undefined) n.hold.value = await this.evalNode(n.left)
        return await this.evalNode(n.body)
      }
      case 'compose': {
        const f = await this.evalNode(n.f)
        const g = await this.evalNode(n.g)
        const arity = (g[1] as any)?.arity ?? 1
        return imp.jsf(async (...xs: ImpVal[]) => await this.apply(f, [await this.apply(g, xs)]), arity)
      }
      case 'index': {
        const t = await this.evalNode(n.target)
        if (!ImpQ.isDct(t)) throw "only a dictionary can be indexed with `key"
        return this.indexDict(t, n.key)
      }
      case 'call': {
        const f = await this.evalNode(n.fn)
        // Arguments run right to left, as in K.
        const args: ImpVal[] = new Array(n.args.length)
        for (let i = n.args.length - 1; i >= 0; i--) args[i] = await this.evalNode(n.args[i])
        const name = n.fn.k === 'verb' ? n.fn.name : undefined
        return await this.apply(f, args, name)
      }
    }
  }

  // -- applying functions ----------------------------------------------------

  /** Make a partial application of a JSF. */
  partial = (f: ImpJsf, captured: ImpVal[]): ImpJsf => [ImpT.JSF, {
    arity: f[1].arity - captured.length,
    sourceIfn: f,
    capturedArgs: captured,
    sourceName: f[1].sourceName
  }, async (...rest: ImpVal[]) => await f[2].apply(this, [...captured, ...rest])]

  /** Apply a function value to arguments. Too few arguments give a
   *  partial application; too many give a valence error. */
  apply = async (f: ImpVal, args: ImpVal[], name?: string): Promise<ImpVal> => {
    if (f[0] === ImpT.IFN) {
      if (args.length > f[1].arity) {
        throw `[project] ${name ?? impShow(f)}: valence error: expected ${f[1].arity} args, got ${args.length}`
      }
      return await this.applyIfn(f, args)
    }
    if (f[0] === ImpT.JSF) {
      const arity = f[1].arity
      const label = name ?? f[1].sourceName ?? impShow(f)
      if (arity === -1) return await f[2].apply(this, args)
      if (args.length < arity) return this.partial(f, args)
      if (args.length > arity) {
        throw `[project] ${label}: valence error: expected ${arity} args, got ${args.length}`
      }
      return await f[2].apply(this, args)
    }
    throw "not a function: " + impShow(f)
  }

  // Execute an IFN with bound parameters
  applyIfn = async (fn: ImpIfn, args: ImpVal[]): Promise<ImpVal> => {
    // If fewer args than arity, return a partial application
    if (args.length < fn[1].arity) {
      const captured = args
      const jsf: ImpJsf = [ImpT.JSF, {
        arity: fn[1].arity - args.length,
        sourceIfn: fn,
        capturedArgs: captured
      }, async (...rest: ImpVal[]) => await this.applyIfn(fn, [...captured, ...rest])]
      return jsf
    }
    if (args.length !== fn[1].arity) {
      throw `IFN arity mismatch: expected ${fn[1].arity}, got ${args.length}`
    }
    // Save current word bindings for x, y, z
    const saved = [this.words['x'], this.words['y'], this.words['z']]
    const names = ['x', 'y', 'z']
    args.forEach((a, i) => { this.words[names[i]] = a })
    try {
      return await this.lastEval(imp.lst({open: '{', close: '}'}, fn[2]))
    } finally {
      names.forEach((nm, i) => {
        if (saved[i] !== undefined) this.words[nm] = saved[i]
        else delete this.words[nm]
      })
    }
  }

  indexDict = (d: ImpDct, key: ImpVal): ImpVal => {
    const dct = d[2]
    if (ImpQ.isSym(key)) {
      const v = dct.get(key[2].description || '')
      return v !== undefined ? v : NIL
    }
    if (key[0] === ImpT.SYMs) {
      return imp.lst(undefined, key[2].map(k => {
        const v = dct.get(k.description || '')
        return v !== undefined ? v : NIL
      }))
    }
    throw "dictionary keys must be symbols"
  }

  // project a function:  name[arg; arg; ...]
  project = async (sym: string, xs: ImpVal[]): Promise<ImpVal> => {
    const f = this.lookup(sym)
    const chunks = splitArgs(xs)

    // Dictionary indexing:  d[`a]  d[`a `b]
    if (f[0] === ImpT.DCT) {
      const results: ImpVal[] = []
      for (const chunk of chunks) {
        const key = await this.lastEval(ImpC.top(chunk))
        const v = this.indexDict(f as ImpDct, key)
        if (key[0] === ImpT.SYMs) results.push(...(v as ImpLst)[2])
        else results.push(v)
      }
      if (results.length === 0) return NIL
      if (results.length === 1) return results[0]
      return imp.lst(undefined, results)
    }

    if (f[0] !== ImpT.JSF && f[0] !== ImpT.IFN) throw "[project]: not a function: " + sym

    // Lazy forms (ite, while, cond) get their argument code unevaluated.
    if (f[0] === ImpT.JSF && f[1].lazy) {
      return await this.apply(f, chunks.map(c => imp.lst(undefined, c)), sym)
    }
    // Arguments run right to left, as in K.
    const args: ImpVal[] = new Array(chunks.length)
    for (let i = chunks.length - 1; i >= 0; i--) args[i] = await this.lastEval(ImpC.top(chunks[i]))
    return await this.apply(f, args, sym)
  }

  // Evaluate quasiquoted expressions - walk the tree and evaluate unquoted items
  quasiquote = async (x: ImpVal): Promise<ImpVal> => {
    if (ImpQ.isSym(x) && x[1].kind === SymT.UNQ) {
      const result = this.lookup(x[2].description!)
      // If the result is a LIT or BQT symbol, strip the quote marker
      if (ImpQ.isSym(result) && (result[1].kind === SymT.LIT || result[1].kind === SymT.BQT)) {
        return ImpC.sym(result[2], SymT.RAW)
      }
      return result
    }
    if (ImpQ.isLst(x)) {
      const results: ImpVal[] = []
      for (const item of formStrands(x[2])) results.push(await this.quasiquote(item))
      const open = x[1].open.startsWith('`') ? x[1].open.slice(1) : x[1].open
      return imp.lst({open, close: x[1].close}, results)
    }
    return x
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

  // evaluate a value (a token from the loader)
  eval = async (x: ImpVal): Promise<ImpVal> => {
    switch (x[0]) {
      case ImpT.TOP: return await this.lastEval(x)
      case ImpT.SEP: return NIL
      case ImpT.LST: break
      default: return x  // every other token is a value
    }
    const [_, a, v] = x as ImpLst
    const opener = a.open || '['
    // Dictionary literals: :[`a 1; `b 2]
    if (opener === ':[') {
      const dctMap = new Map<string, ImpVal>()
      let i = 0
      while (i < v.length) {
        if (v[i][0] === ImpT.SEP) { i++; continue }
        const keyItem = v[i]
        if (!ImpQ.isSym(keyItem)) throw "dictionary keys must be backtick symbols"
        if (keyItem[1].kind !== SymT.BQT) throw "dictionary keys must be backtick symbols (e.g., `a)"
        const keyName = keyItem[2].description || ''
        i++
        if (i >= v.length) throw "dictionary key without value"
        const valueExprs: ImpVal[] = []
        while (i < v.length && !(v[i][0] === ImpT.SEP && v[i][2] !== ',')) {
          valueExprs.push(v[i])
          i++
        }
        dctMap.set(keyName, await this.lastEval(ImpC.top(valueExprs)))
      }
      return imp.dct(dctMap)
    }
    // Curly braces: function literal
    if (opener === '{') {
      let body = v
      let doc: string | undefined
      if (body.length > 0 && body[0][0] === ImpT.STR) {
        doc = body[0][2] as string
        body = body.slice(1)
      }
      return ImpC.ifn(scanArity(body), body, doc)
    }
    // Backtick: quasiquotation
    if (opener.startsWith('`')) return await this.quasiquote(x)
    // Single quote strips one layer
    if (opener.startsWith("'")) return imp.lst({open: opener.slice(1), close: a.close}, v)
    // Parentheses: run the code, return the last value
    if (opener === '(') return await this.lastEval(x as ImpLst)
    // Plain [ ]: a data block. It is not run.
    if (opener === '[') return readData(x as ImpLst)
    // name[ ... ]: projection (function call)
    const m = opener.match(/^(.+)\[$/)
    if (m) return await this.project(m[1], v)
    // Other openers such as name( are not defined yet.
    throw `unsupported list opener: ${opener}`
  }
}

export let impEval = async (x: ImpTop | ImpErr): Promise<ImpVal> =>
  ImpQ.isTop(x) ? await new ImpEvaluator().eval(x) : x
