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

// Helper: Resolve a RAW symbol to its value in the dictionary
function resolveSymbol(sym: ImpVal, dict?: WordDict): ImpVal | null {
  if (!dict || !ImpQ.isSym(sym) || sym[1].kind !== SymT.RAW) {
    return null
  }
  const name = sym[2].description
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
  // ONLY transform TOP-level sequences, NOT bracket lists [...]
  // Bracket lists are already in projection syntax and should not be transformed
  // DISABLED: See imparse.org for why and alternative approaches
  const shouldTransform = false // dict && tree[0] === ImpT.TOP
  const phase2 = (shouldTransform && dict) ? transformToMExpr(phase1, dict) : phase1

  // Return with same structure
  if (tree[0] === ImpT.TOP) {
    return [ImpT.TOP, tree[1], phase2]
  } else {
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

// Phase 2: Transform to M-expressions
// Implements: function application (a F b → F[a; b])
// TODO: Add comma threading transform
function transformToMExpr(items: ImpVal[], dict: WordDict): ImpVal[] {
  // Check if there are any commas in the sequence
  // If so, skip transformation and let the evaluator handle comma threading
  const hasComma = items.some(item => item[0] === ImpT.SEP && item[2] === ',')
  if (hasComma) {
    return items
  }

  const result: ImpVal[] = []
  let i = 0

  while (i < items.length) {
    const item = items[i]

    // Skip separators and special symbols
    if (item[0] === ImpT.SEP) {
      result.push(item)
      i++
      continue
    }

    // Try to resolve symbols to check if they're verbs
    const val = resolveSymbol(item, dict)
    const resolved = val || item

    // Check if this is a verb
    if (isVerb(resolved)) {
      const arity = getArity(resolved)
      const availableArgs = result.length
      const hasAhead = i + 1 < items.length

      // Arity-2 verbs are INFIX operators: a op b → op[a; b]
      // They require exactly 1 arg from left and 1 from right
      if (arity === 2 && availableArgs > 0 && hasAhead) {
        const leftArg = result.pop()!
        const rightArg = items[i + 1]

        // Build M-expression with verb as part of the opener
        // This matches the existing projection syntax: +[2; 3]
        // The evaluator recognizes the pattern "sym[" and calls project()
        // IMPORTANT: Must include SEP (;) between arguments for project() to work
        const verbName = (item[2] as symbol).description || '?'
        const mexpr = imp.lst({open: verbName + '[', close: ']'}, [leftArg, ImpC.sep(';'), rightArg])
        result.push(mexpr)
        i += 2  // Skip both the operator and right arg
        continue
      }

      // Arity-1 verbs can be POSTFIX: a F → F[a]
      // Only consume from stack if we have args available
      if (arity === 1 && availableArgs > 0) {
        const arg = result.pop()!

        // Build M-expression with verb as part of the opener
        const verbName = (item[2] as symbol).description || '?'
        const mexpr = imp.lst({open: verbName + '[', close: ']'}, [arg])
        result.push(mexpr)
        i++
        continue
      }

      // For other cases (prefix, or not enough args), keep as-is
      // The evaluator will handle prefix application
    }

    // Default: keep as-is
    result.push(item)
    i++
  }

  return result
}
