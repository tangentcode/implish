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

  // Phase 2: Transform to M-expressions (if dictionary provided)
  // Transform TOP-level sequences AND regular bracket lists (source code)
  // Do NOT transform projection syntax (verb in opener like "+[")
  //
  // STATUS: PHASE 1 - Conservative transformation enabled
  // Transforms postfix/infix ONLY when no prefix verbs present
  // Cases WITH prefix verbs (! 10 * 2) are left for evaluator
  // This fixes: 2 !, 2 + 3, 2 + 3 * 5 (postfix and infix chains)
  // Skips: ! 10, ! 10 * 2, 1 + 2 * ! 10 (prefix cases)

  // Check if this is a regular list (not projection syntax)
  // Projection syntax has verb in opener: "+[", "![", etc.
  // Regular lists have plain brackets: "[", "'[", "`["
  const isRegularList = tree[0] === ImpT.LST &&
                        tree[1].open?.match(/^['`]*\[/)  // Just quotes+bracket, no verb

  const shouldTransform = dict && (tree[0] === ImpT.TOP || isRegularList)
  const phase2 = (shouldTransform && dict) ? transformToMExpr(phase1, dict) : phase1

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

// Pass 1: Transform prefix verbs (F a → F[a])
// Prefix verbs bind tighter than infix - they consume arguments eagerly
function transformPrefix(items: ImpVal[], dict: WordDict): ImpVal[] {
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

      // Check if this is PREFIX (no noun left argument available)
      let hasLeftArg = false
      if (result.length > 0) {
        const leftItem = result[result.length - 1]
        if (leftItem[0] !== ImpT.SEP) {
          // Check if left item is a noun (not a verb)
          const leftVal = resolveSymbol(leftItem, dict)
          const leftResolved = leftVal || leftItem
          hasLeftArg = !isVerb(leftResolved)
        }
      }

      if (!hasLeftArg && arity >= 1 && i + arity <= items.length) {
        // This is PREFIX - try to collect arguments from the right
        // BUT: only collect NOUNS, not verbs (verbs should be left for the evaluator)
        const args: ImpVal[] = []

        for (let j = 1; j <= arity && i + j < items.length; j++) {
          const nextItem = items[i + j]
          if (nextItem[0] === ImpT.SEP) break // Stop at separator

          // Check if next item is a verb - if so, don't consume it
          const nextVal = resolveSymbol(nextItem, dict)
          const nextResolved = nextVal || nextItem
          if (isVerb(nextResolved)) break // Stop at verbs

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
          result.push(mexpr)
          i += 1 + arity
          continue
        }
      }
    }

    // Default: keep as-is
    result.push(item)
    i++
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
        const rightArg = items[i + 1]

        const verbName = (item[2] as symbol).description || '?'
        const mexpr = imp.lst({open: verbName + '[', close: ']'}, [leftArg, ImpC.sep(';'), rightArg])
        result.push(mexpr)
        i += 2
        continue
      }

      // Arity-1 verbs can be POSTFIX: a F → F[a]
      if (arity === 1 && availableArgs > 0) {
        const arg = result.pop()!

        const verbName = (item[2] as symbol).description || '?'
        const mexpr = imp.lst({open: verbName + '[', close: ']'}, [arg])
        result.push(mexpr)
        i++
        continue
      }
    }

    // Default: keep as-is
    result.push(item)
    i++
  }

  return result
}

// Phase 2: Transform to M-expressions
// Coordinates the two-pass transformation
function transformToMExpr(items: ImpVal[], dict: WordDict): ImpVal[] {
  // Check if there are any commas in the sequence
  // If so, skip transformation and let the evaluator handle comma threading
  const hasComma = items.some(item => item[0] === ImpT.SEP && item[2] === ',')
  if (hasComma) {
    return items
  }

  // Check for special symbols (SET, GET, LIT, etc.) - skip transformation
  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    if (ImpQ.isSym(item) && item[1].kind !== SymT.RAW) {
      return items
    }
  }

  // Two-pass transformation:
  // Pass 1: PREFIX verbs (bind tighter, consume args eagerly)
  //   ! 10 → ![10]
  // Pass 2: INFIX and POSTFIX (left-to-right)
  //   ![10] * 2 → *[![10]; 2]
  const afterPrefix = transformPrefix(items, dict)
  const afterInfix = transformInfixPostfix(afterPrefix, dict)
  return afterInfix
}
