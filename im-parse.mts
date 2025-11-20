/** Implish parser/normalizer
 * Transforms token trees from imp-load into normalized M-expression AST
 * This is the second phase: load[] → imparse[] → eval[]
 */

import * as imp from './imp-core.mjs'
import {
  ImpT,
  ImpVal,
  ImpQ,
  SymT,
  ImpC,
  ImpJsf,
  ImpJsfA,
  ImpIfn,
  ImpIfnA
} from './imp-core.mjs'

// Word dictionary type (maps symbol names to ImpVals)
type WordDict = Record<string, ImpVal>

// Helper: Get arity of a value (returns 0 for non-functions)
function getArity(x: ImpVal): number {
  if (x[0] === ImpT.JSF) {
    return (x[1] as ImpJsfA).arity
  } else if (x[0] === ImpT.IFN) {
    return (x[1] as ImpIfnA).arity
  }
  return 0
}

// Helper: Check if a value is a verb (function)
function isVerb(x: ImpVal): boolean {
  return x[0] === ImpT.JSF || x[0] === ImpT.IFN
}

// Helper: Check if a value is a RAW symbol (not SET, GET, LIT, etc.)
function isRawSymbol(x: ImpVal): boolean {
  return ImpQ.isSym(x) && x[1].kind === SymT.RAW
}

// Helper: Resolve a RAW symbol to its value in the dictionary
function resolveSymbol(sym: ImpVal, dict?: WordDict): ImpVal | null {
  if (!dict || !isRawSymbol(sym)) {
    return null
  }
  const name = (sym[2] as symbol).description
  return name ? (dict[name] || null) : null
}

// Parse/normalize a token tree into M-expression form
// When dict is provided, performs full M-expression transformation
// Otherwise just combines literal strands (backward compatibility)
export function imparse(tree: ImpVal, dict?: WordDict): ImpVal {
  // Only process TOP and LST nodes
  if (tree[0] !== ImpT.TOP && tree[0] !== ImpT.LST) {
    return tree
  }

  const items = tree[2] as ImpVal[]

  // Phase 1: Form strands (numeric and symbol literals)
  const phase1: ImpVal[] = formStrands(items)

  // Phase 1.5: Transform GET/SET symbols to M-expressions (always, even without dict)
  // :wd → get[`wd]
  // x: expr → set[`x; expr]
  const phase15: ImpVal[] = transformGetSet(phase1, dict)

  // Phase 2: Transform to M-expressions (if dictionary provided)
  // Transform TOP-level sequences AND regular bracket lists (source code)
  // Do NOT transform projection syntax (verb in opener like "+[")
  //
  // STATUS: PHASE 1 - Conservative transformation enabled
  // Transforms postfix/infix ONLY when no prefix verbs present
  // Cases WITH prefix verbs (! 10 * 2) are left for evaluator
  // This fixes: 2 !, 2 + 3, 2 + 3 * 5 (postfix and infix chains)
  // Skips: ! 10, ! 10 * 2, 1 + 2 * ! 10 (prefix cases)

  // Check if this is a regular list (not projection syntax, curly braces, parens, or backtick)
  // Projection syntax has verb in opener: "+[", "![", etc.
  // Regular lists: "[", "'[" (single quote is OK - we transform contents)
  // Curly braces "{...}" are function definitions - don't transform
  // Parentheses "(...)" are grouping - don't transform (let evaluator handle)
  // Backtick "`[...]" is quasiquotation - don't transform (evaluator handles it)
  const isRegularList = tree[0] === ImpT.LST &&
                        tree[1].open?.match(/^'*\[/)  // Plain or single-quoted bracket, no verb

  const isCurlyBraces = tree[0] === ImpT.LST && tree[1].open === '{'
  const isParens = tree[0] === ImpT.LST && tree[1].open === '('
  const isBacktick = tree[0] === ImpT.LST && tree[1].open?.startsWith("`")

  const shouldTransform = dict && (tree[0] === ImpT.TOP || isRegularList) &&
                          !isCurlyBraces && !isParens && !isBacktick
  const phase2 = (shouldTransform && dict) ? transformToMExpr(phase15, dict) : phase15

  // Check if transformation actually occurred (phase2 !== phase1)
  const wasTransformed = phase2 !== phase1

  // Return with appropriate structure
  if (tree[0] === ImpT.TOP) {
    return [ImpT.TOP, tree[1], phase2]
  } else if (isRegularList && wasTransformed) {
    // Regular lists that got transformed become TOP nodes (unwrapped)
    return [ImpT.TOP, null, phase2]
  } else {
    // Projection syntax and untransformed lists stay as lists
    return imp.lst(tree[1], phase2)
  }
}

// Phase 1: Form strands from adjacent literals
function formStrands(items: ImpVal[]): ImpVal[] {
  const refined: ImpVal[] = []
  let i = 0

  while (i < items.length) {
    const item = items[i]

    // Check if this is the start of a numeric strand
    if (item[0] === ImpT.INT || item[0] === ImpT.NUM) {
      const nums: number[] = [item[2] as number]
      let hasNum = item[0] === ImpT.NUM
      let j = i + 1

      // Collect adjacent INT/NUM tokens
      while (j < items.length) {
        const next = items[j]
        if (next[0] !== ImpT.INT && next[0] !== ImpT.NUM) break
        nums.push(next[2] as number)
        if (next[0] === ImpT.NUM) hasNum = true
        j++
      }

      // If we collected more than one, create a strand
      if (nums.length > 1) {
        refined.push(hasNum ? ImpC.nums(nums) : ImpC.ints(nums))
        i = j
        continue
      }
    }

    // Check if this is the start of a backtick symbol strand
    if (ImpQ.isSym(item) && item[1].kind === SymT.BQT) {
      const syms: symbol[] = [item[2] as symbol]
      let j = i + 1

      // Collect adjacent backtick symbols
      while (j < items.length) {
        const nextItem = items[j]
        if (!ImpQ.isSym(nextItem)) break
        const attrs = nextItem[1]
        if (!attrs || attrs.kind !== SymT.BQT) break
        syms.push(nextItem[2] as symbol)
        j++
      }

      // If we collected more than one, create a strand
      if (syms.length > 1) {
        refined.push(ImpC.syms(syms))
        i = j
        continue
      }
    }

    // Not part of a strand, keep as-is
    refined.push(item)
    i++
  }

  return refined
}

// Phase 1.5: Transform GET/SET symbols to M-expressions
// :wd → get[`wd]
// x: expr → set[`x; expr]
function transformGetSet(items: ImpVal[], dict?: WordDict): ImpVal[] {
  const result: ImpVal[] = []
  let i = 0

  while (i < items.length) {
    const item = items[i]

    // Handle GET symbols: :foo → get[`foo]
    if (ImpQ.isSym(item) && item[1].kind === SymT.GET) {
      const symName = item[2] as symbol
      const bqtSym = ImpC.sym(symName, SymT.BQT)
      const mexpr = imp.lst({open: 'get[', close: ']'}, [bqtSym])
      result.push(mexpr)
      i++
      continue
    }

    // Handle SET symbols: foo: expr → set[`foo; expr]
    if (ImpQ.isSym(item) && item[1].kind === SymT.SET) {
      const symName = item[2] as symbol
      const bqtSym = ImpC.sym(symName, SymT.BQT)

      // Collect the RHS (everything until separator or end)
      // Handle chained assignments: a: b: 123 → set[`a; set[`b; 123]]
      const rhs: ImpVal[] = []
      let j = i + 1

      // Collect RHS until we hit a separator or another SET/GET (with special handling)
      // Chained assignment: a: b: 123 → collect "b: 123" (only SET/GET symbols until value)
      // Separate assignments: x: 12 y: 34 → collect "12", stop at "y:"
      while (j < items.length) {
        const next = items[j]
        if (next[0] === ImpT.SEP) {
          break  // Stop at any separator (;, ,, \n)
        }
        // Check if this is a SET or GET symbol
        const isSetOrGet = ImpQ.isSym(next) && (next[1].kind === SymT.SET || next[1].kind === SymT.GET)

        // Only stop at SET/GET if we've collected actual values (not just SET/GET symbols)
        // This allows chained assignments (a: b: 123) while stopping separate ones (x: 12 y: 34)
        const hasActualValues = rhs.some(item =>
          !(ImpQ.isSym(item) && (item[1].kind === SymT.SET || item[1].kind === SymT.GET))
        )
        if (isSetOrGet && hasActualValues) {
          break
        }
        // Otherwise include it (handles chained assignment: a: b: 123)
        rhs.push(next)
        j++
      }

      if (rhs.length === 0) {
        throw `SET symbol ${symName.description} has no right-hand side`
      }

      // Transform the RHS through full pipeline (handles GET/SET, infix, postfix, commas)
      // First recursively handle GET/SET in the RHS
      const rhsPhase1 = transformGetSet(rhs, dict)
      // Then apply full M-expression transformation if dict available
      const transformedRhs = dict ? transformToMExpr(rhsPhase1, dict) : rhsPhase1

      // Build the M-expression: set[`foo; rhs]
      const args: ImpVal[] = [bqtSym, ImpC.sep(';')]

      // If RHS is a single item, add it directly; otherwise wrap in a list
      if (transformedRhs.length === 1) {
        args.push(transformedRhs[0])
      } else {
        // Multiple items on RHS - wrap in TOP node for further processing
        args.push(imp.lst(undefined, transformedRhs))
      }

      const mexpr = imp.lst({open: 'set[', close: ']'}, args)
      result.push(mexpr)
      i = j
      continue
    }

    // Not GET or SET, keep as-is
    result.push(item)
    i++
  }

  return result
}

// Pass 1: Transform prefix verbs (F a → F[a])
// Prefix verbs bind tighter than infix - they consume arguments eagerly
// Process RIGHT-TO-LEFT so nested prefix verbs work: echo show type? 3 → echo[show[type?[3]]]
function transformPrefix(items: ImpVal[], dict: WordDict): ImpVal[] {
  const result: ImpVal[] = []
  let i = items.length - 1

  while (i >= 0) {
    const item = items[i]

    // Skip separators
    if (item[0] === ImpT.SEP) {
      result.unshift(item)
      i--
      continue
    }

    // Check if this is a RAW symbol verb
    if (!isRawSymbol(item)) {
      result.unshift(item)
      i--
      continue
    }

    const val = resolveSymbol(item, dict)
    const resolved = val || item

    if (isVerb(resolved)) {
      const arity = getArity(resolved)

      // Check if this is PREFIX (no noun left argument available)
      // Look left (until a separator) for ANY noun (verbs don't block)
      let hasLeftArg = false
      for (let j = i - 1; j >= 0; j--) {
        const leftItem = items[j]
        if (leftItem[0] === ImpT.SEP) break

        const leftVal = resolveSymbol(leftItem, dict)
        const leftResolved = leftVal || leftItem
        if (!isVerb(leftResolved)) {
          hasLeftArg = true
          break
        }
        // If it's a verb, keep scanning farther left for a noun
        continue
      }

      if (!hasLeftArg && arity >= 1) {
        // This is PREFIX - collect arguments from result (which has items to the right)
        const args: ImpVal[] = []

        for (let j = 0; j < arity && j < result.length; j++) {
          const nextItem = result[j]
          if (nextItem[0] === ImpT.SEP) break // Stop at separator
          args.push(nextItem)
        }

        // If we collected exactly the right number of args, create M-expression
        if (args.length === arity) {
          const verbName = (item[2] as symbol).description || '?'
          const argList: ImpVal[] = []
          for (let k = 0; k < args.length; k++) {
            if (k > 0) argList.push(ImpC.sep(';'))
            argList.push(args[k])
          }
          const mexpr = imp.lst({open: verbName + '[', close: ']'}, argList)

          // Remove consumed args from result and prepend mexpr
          result.splice(0, args.length)
          result.unshift(mexpr)
          i--
          continue
        }
      }
    }

    // Default: keep as-is
    result.unshift(item)
    i--
  }

  return result
}

// Pass 2: Transform infix and postfix (left-to-right)
function transformInfixPostfix(items: ImpVal[], dict: WordDict): ImpVal[] {
  const result: ImpVal[] = []
  let i = 0

  while (i < items.length) {
    const item = items[i]

    // Skip separators
    if (item[0] === ImpT.SEP) {
      result.push(item)
      i++
      continue
    }

    // Check if this is a RAW symbol verb
    if (!isRawSymbol(item)) {
      result.push(item)
      i++
      continue
    }

    const val = resolveSymbol(item, dict)
    const resolved = val || item

    if (isVerb(resolved)) {
      const arity = getArity(resolved)
      const availableArgs = result.length
      const hasAhead = i + 1 < items.length

      // Arity-2 verbs are INFIX operators: a op b → op[a; b]
      if (arity === 2 && availableArgs > 0 && hasAhead) {
        const leftArg = result.pop()!
        let rightArg = items[i + 1]
        let consume = 2

        // If right token is a monadic verb, eagerly apply it prefix-style to following nouns
        // so expressions like "1 + 2 * ! 10" become "*[+[1; 2]; ![10]]"
        const rightVal = resolveSymbol(rightArg, dict)
        const rightResolved = rightVal || rightArg
        if (isVerb(rightResolved) && getArity(rightResolved) === 1 && i + 2 < items.length) {
          const args: ImpVal[] = []
          let j = i + 2
          while (j < items.length) {
            const next = items[j]
            if (next[0] === ImpT.SEP) break

            const nextVal = resolveSymbol(next, dict)
            const nextResolved = nextVal || next
            if (isVerb(nextResolved)) break

            // Unwrap strands for arguments (match postfix collection behavior)
            if (next[0] === ImpT.INTs || next[0] === ImpT.NUMs) {
              const nums = next[2] as number[]
              for (const num of nums) {
                args.push(next[0] === ImpT.INTs ? ImpC.int(num) : ImpC.num(num))
              }
            } else if (next[0] === ImpT.SYMs) {
              const syms = next[2] as symbol[]
              for (const sym of syms) {
                args.push(ImpC.sym(sym, SymT.BQT))
              }
            } else {
              args.push(next)
            }
            j++
          }

          if (args.length > 0) {
            const verbName = (rightArg[2] as symbol).description || '?'
            const argList: ImpVal[] = []
            for (let k = 0; k < args.length; k++) {
              if (k > 0) argList.push(ImpC.sep(';'))
              argList.push(args[k])
            }
            rightArg = imp.lst({open: verbName + '[', close: ']'}, argList)
            consume = 2 + args.length
          }
        }

        const verbName = (item[2] as symbol).description || '?'
        const mexpr = imp.lst({open: verbName + '[', close: ']'}, [leftArg, ImpC.sep(';'), rightArg])
        result.push(mexpr)
        i += consume
        continue
      }

      // Arity-1 verbs can be POSTFIX: a F → F[a]
      // Also collect trailing nouns: a F b c → F[a; b; c] (let evaluator check arity)
      if (arity === 1 && availableArgs > 0) {
        const args: ImpVal[] = [result.pop()!]

        // Collect all trailing NOUNS (stop at verbs or separators)
        let j = i + 1
        while (j < items.length) {
          const nextItem = items[j]
          if (nextItem[0] === ImpT.SEP) break

          // Check if next item is a verb - if so, stop
          const nextVal = resolveSymbol(nextItem, dict)
          const nextResolved = nextVal || nextItem
          if (isVerb(nextResolved)) break

          // Unwrap strands when collecting as function arguments
          // This allows: 5 ! 20 30 → ![5; 20; 30] instead of ![5; 20 30]
          if (nextItem[0] === ImpT.INTs || nextItem[0] === ImpT.NUMs) {
            const nums = nextItem[2] as number[]
            for (const num of nums) {
              args.push(nextItem[0] === ImpT.INTs ? ImpC.int(num) : ImpC.num(num))
            }
          } else if (nextItem[0] === ImpT.SYMs) {
            const syms = nextItem[2] as symbol[]
            for (const sym of syms) {
              args.push(ImpC.sym(sym, SymT.BQT))  // Unwrapped syms from strand are backtick
            }
          } else {
            args.push(nextItem)
          }
          j++
        }

        const verbName = (item[2] as symbol).description || '?'
        const argList: ImpVal[] = []
        for (let k = 0; k < args.length; k++) {
          if (k > 0) argList.push(ImpC.sep(';'))
          argList.push(args[k])
        }
        const mexpr = imp.lst({open: verbName + '[', close: ']'}, argList)
        result.push(mexpr)
        i = j
        continue
      }
    }

    // Default: keep as-is
    result.push(item)
    i++
  }

  return result
}

// Transform comma-separated segments into chained M-expressions
// e.g., `2, + 3` → `+[2; 3]`, `2, + 3 * 5, + 7` → `+[+[2; *[3; 5]]; 7]`
function transformCommas(items: ImpVal[], dict: WordDict): ImpVal[] {
  // Split items by comma separators
  const segments: ImpVal[][] = []
  let currentSegment: ImpVal[] = []

  for (const item of items) {
    if (item[0] === ImpT.SEP && item[2] === ',') {
      if (currentSegment.length > 0) {
        segments.push(currentSegment)
        currentSegment = []
      }
    } else {
      currentSegment.push(item)
    }
  }
  if (currentSegment.length > 0) {
    segments.push(currentSegment)
  }

  if (segments.length === 1) {
    // No commas, just transform normally
    return transformNoComma(segments[0], dict)
  }

  // Check if first segment starts with a prefix verb (+ args, more-args)
  // In this case, commas are argument separators, not threading
  // BUT: only if subsequent segments don't start with verbs (which indicates threading)
  if (segments[0].length > 0) {
    const firstItem = segments[0][0]
    const firstIsVerb = isRawSymbol(firstItem) &&
                        isVerb(resolveSymbol(firstItem, dict) || firstItem)

    if (firstIsVerb && segments.length > 1) {
      // Check if any subsequent segment starts with a verb (indicates threading, not args)
      let hasVerbAfterComma = false
      for (let i = 1; i < segments.length; i++) {
        if (segments[i].length > 0) {
          const segFirstItem = segments[i][0]
          const segFirstIsVerb = isRawSymbol(segFirstItem) &&
                                 isVerb(resolveSymbol(segFirstItem, dict) || segFirstItem)
          if (segFirstIsVerb) {
            hasVerbAfterComma = true
            break
          }
        }
      }

      // Only treat as comma-separated args if no verbs after commas
      if (!hasVerbAfterComma) {
        const verbItem = firstItem
        const verbName = (verbItem[2] as symbol).description || '?'

        // Collect all arguments from all segments (comma-separated args)
        const allArgs: ImpVal[] = []
        for (let i = 0; i < segments.length; i++) {
          const segment = i === 0 ? segments[i].slice(1) : segments[i]  // Skip verb in first segment
          const transformed = transformNoComma(segment, dict)
          if (i > 0) allArgs.push(ImpC.sep(';'))
          allArgs.push(...transformed)
        }

        // Build M-expression: verb[arg1; arg2; ...]
        const mexpr = imp.lst({open: verbName + '[', close: ']'}, allArgs)
        return [mexpr]
      }
    }
  }

  // Process segments with comma threading
  // First segment transforms normally
  let result = transformNoComma(segments[0], dict)

  // Subsequent segments: check if they start with a verb (threading) or noun (arg separator)
  for (let i = 1; i < segments.length; i++) {
    const segment = segments[i]
    if (segment.length === 0) {
      throw "comma followed by nothing"
    }

    // Check if first item is a verb (for threading)
    const firstItem = segment[0]
    const isThreading = isRawSymbol(firstItem) &&
                        isVerb(resolveSymbol(firstItem, dict) || firstItem)

    if (!isThreading) {
      // Not threading - this is argument separation (like `+ 1 2, 3 4`)
      // Just append the comma and transformed segment to results
      result.push(ImpC.sep(','))
      const transformed = transformNoComma(segment, dict)
      result.push(...transformed)
      continue
    }

    // Threading case: verb takes previous result as first arg
    const verbItem = firstItem
    const val = resolveSymbol(verbItem, dict)
    const resolved = val || verbItem

    const arity = getArity(resolved)
    const verbName = (verbItem[2] as symbol).description || '?'

    if (arity === 1) {
      // Arity-1: verb[prevResult]
      if (segment.length > 1) {
        throw `arity-1 verb ${verbName} after comma cannot have additional arguments`
      }
      // Wrap result in single M-expression
      const mexpr = imp.lst({open: verbName + '[', close: ']'},
                            result.length === 1 ? result : [imp.lst(undefined, result)])
      result = [mexpr]
    } else if (arity === 2) {
      // Arity-2: verb[prevResult; restOfSegment]
      const restItems = segment.slice(1)
      const rightArg = transformNoComma(restItems, dict)

      // Build M-expression: verb[prevResult; rightArg]
      const args: ImpVal[] = []
      // Add previous result
      if (result.length === 1) {
        args.push(result[0])
      } else {
        args.push(imp.lst(undefined, result))
      }
      args.push(ImpC.sep(';'))
      // Add right argument
      if (rightArg.length === 1) {
        args.push(rightArg[0])
      } else {
        args.push(imp.lst(undefined, rightArg))
      }

      const mexpr = imp.lst({open: verbName + '[', close: ']'}, args)
      result = [mexpr]
    } else {
      throw `comma-verb sequencing requires verb of arity 1 or 2, got arity ${arity}`
    }
  }

  return result
}

// Transform items without commas (helper for comma threading)
function transformNoComma(items: ImpVal[], dict: WordDict): ImpVal[] {
  // Two-pass transformation:
  // Pass 1: PREFIX verbs (bind tighter, consume args eagerly)
  //   ! 10 → ![10]
  // Pass 2: INFIX and POSTFIX (left-to-right)
  //   ![10] * 2 → *[![10]; 2]
  const afterPrefix = transformPrefix(items, dict)
  const afterInfix = transformInfixPostfix(afterPrefix, dict)
  return afterInfix
}

// Phase 2: Transform to M-expressions
// Coordinates the two-pass transformation
function transformToMExpr(items: ImpVal[], dict: WordDict): ImpVal[] {
  // Check if there are any commas in the sequence
  const hasComma = items.some(item => item[0] === ImpT.SEP && item[2] === ',')

  if (hasComma) {
    // Handle comma threading
    return transformCommas(items, dict)
  } else {
    // No commas, use standard transformation
    return transformNoComma(items, dict)
  }
}
