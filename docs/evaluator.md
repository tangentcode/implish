# Implish Evaluator

This document describes the evaluation algorithm used by the Implish interpreter.

## Overview

The Implish evaluator is a **stack-based, left-to-right evaluator** that uses a **parts-of-speech** approach rather than traditional operator precedence. It evaluates token trees produced by the loader and produces ImpVal results.

## Parts of Speech (ImpP)

The evaluator classifies values into grammatical categories:

- **V** (Verb): Functions (JSF, IFN) - applied to arguments
- **N** (Noun): Data values (INT, NUM, STR, LST, vectors, etc.)
- **S** (Setter): Set-words like `foo:` - triggers assignment
- **G** (Getter): Get-words like `:foo` - retrieves value without evaluation
- **Q** (Quote): Quoted symbols like `` `foo `` - literal values
- **E** (End): End of input or separator
- **M** (Method): Message symbols like `.foo` - for method calls
- **A** (Adverb): Verb modifiers (future)
- **P** (Preposition): Takes noun arguments (future)
- **C** (Conjunction): Combines verbs (future)

**Note:** The **O** (Operator) part of speech was removed during unification. All binary operators are now verbs (ImpP.V) with arity 2.

## Main Evaluation Loop (evalList)

The core algorithm walks left-to-right through a token list, building up results:

```
while not at end:
  skip separators
  get next item
  switch on word class:
    case V (verb):
      collect arity arguments
      apply verb to arguments
      emit result

    case N (noun):
      evaluate noun
      extend into strand if next items match type
      check for infix verbs (modifyNoun)
      emit result

    case S (setter):
      perform assignment (doAssign)
      emit assigned value

    case G (getter):
      look up variable value
      emit value

    case Q (quote):
      collect strand of quoted symbols
      emit as literal
```

### Key Components

#### 1. **Strand Collection** (`extendStrand`)

Consecutive values of the same type automatically form strands (vectors):

- `1 2 3` → `[1, 2, 3]` (INTs vector)
- `` `a `b `c`` → `[a, b, c]` (SYMs vector)
- `foo bar baz` → three separate values (words don't form strands)

Strand formation is **mechanical** - it doesn't look at function arity.

#### 2. **Infix Application** (`modifyNoun`)

After evaluating a noun, the evaluator checks if the next token is an **arity-2 verb**:

```
modifyNoun(result):
  while next is arity-2 verb:
    consume verb
    collect right operand (may be verb application or strand)
    apply: result = verb(result, right_operand)
  return result
```

This implements **left-associative chaining**:
- `1 + 2 * 3` → `(1 + 2) * 3` → `3 * 3` → `9`

**Important:** Any JSF or IFN with arity 2 can be used infix, not just operators.

#### 3. **Partial Application**

When a verb is called with fewer arguments than its arity, it returns a partial application:

```
if args.length < arity:
  return JSF with:
    arity = original_arity - args.length
    capturedArgs = args collected so far
    function = closure that applies original function with captured + remaining args
```

Examples:
- `+ 1 2` → `<fn[_; _]>[1 2]` (partial, waiting for more args)
- `+ 1, 2` → `3` (full application with comma separator)
- `(f: + 1 2) 3` → `4 5` (applying partial to strand)

#### 4. **Assignment** (`doAssign`)

Set-words trigger assignment:

```
x: 123        # assign 123 to x
a: b: 456     # right-associative: both a and b get 456
```

The RHS is evaluated according to its word class:
- Noun: evaluate, extend strand, apply infix operators
- Verb: collect arguments and apply (with partial application support)
- Get-word: retrieve value without evaluation
- Another set-word: recurse (enables chaining)

#### 5. **Verb Composition** (`modifyVerb`)

When two verbs appear in sequence, they compose (for arity-1 verbs):

```
rev !        # compose: reverse ∘ iota
rev ! 5      # apply composition: rev(!(5)) → rev([0,1,2,3,4]) → [4,3,2,1,0]
```

## Symbol Resolution

Symbols are resolved during evaluation, not parsing (late binding):

1. `nextItem()` checks if current item is a RAW symbol
2. If yes, looks it up in the word dictionary
3. Replaces symbol with its value (JSF, IFN, or data)
4. Determines word class based on the value type

Special symbol variants are handled differently:
- `foo:` (SET) → triggers assignment
- `:foo` (GET) → retrieves value
- `'foo` (LIT) → literal symbol
- `` `foo`` (BQT) → quoted symbol

## Function Application

### JSF (JavaScript Functions)

```javascript
imp.jsf((x, y) => elemWise((a,b) => a+b, x, y), 2)
```

- Uses rest parameters: `(...args: ImpVal[]) => ImpVal | Promise<ImpVal>`
- Arity stored in metadata: `{arity: 2}`
- Supports async (returns Promise)
- Supports partial application
- Can be used as both prefix and infix (if arity 2)

### IFN (Implish Functions)

```
{x * 2}           # arity inferred by scanning for x, y, z
{x + y}           # arity 2
{x + y + z}       # arity 3
```

- Defined with curly braces
- Arity determined by scanning for implicit parameters (x, y, z)
- Parameters bound during application
- Supports partial application (fewer args than arity)

## Special Syntactic Forms

### Projection (Bracket Application)

```
f[1; 2; 3]        # explicit application with semicolon separators
+[1; 2]           # same as + 1, 2
```

Semicolons separate arguments, avoiding strand formation.

### Quasiquotation

```
x: 42
`[1 + ,x]         # backtick quotes, comma unquotes → [1 + 42]
```

- Backtick (`` ` ``) quotes expressions
- Comma (`,`) unquotes within quoted context
- Used for code-as-data manipulation

### Fold and Scan Operators

Created dynamically when `name/` or `name\` is not found:

```
+/                # fold (reduce) with +
+\ # scan (running total) with +
```

- `/` suffix creates fold operator
- `\` suffix creates scan operator
- Base operator must be arity-2 JSF
- Cached in word dictionary after creation

## Evaluation Order Summary

1. **Left-to-right**: Tokens processed sequentially
2. **Eager**: Arguments evaluated before function application
3. **Strands first**: Consecutive same-type values collected before anything else
4. **Infix after**: Arity-2 verbs applied in left-associative chains
5. **Late binding**: Symbols resolved during evaluation, not parsing

## Key Differences from Traditional Evaluators

- **No operator precedence**: All infix application is left-associative
- **No special operators**: `+` and user functions with arity 2 work identically
- **Mechanical strands**: Type-based collection, not context-dependent
- **Parts of speech**: Grammatical categories instead of precedence levels
- **Partial application**: First-class feature, automatic for insufficient args

## Example Evaluation Traces

### Simple Infix

```
1 + 2
→ evalList: nextItem() → 1 (N)
→ eval(1) → 1
→ extendStrand(1) → no matching types, return 1
→ modifyNoun(1):
    peek() → + (V, arity 2)
    nextItem() → +
    collectStrand() → 2
    apply +(1, 2) → 3
→ emit(3)
```

### Chaining

```
1 + 2 * 3
→ evalList: 1 (N) → 1
→ modifyNoun(1):
    + (V, arity 2), collectStrand() → 2, apply +(1,2) → 3
    * (V, arity 2), collectStrand() → 3, apply *(3,3) → 9
→ emit(9)
```

### Partial Application

```
+ 1 2
→ evalList: + (V, arity 2)
→ collect args:
    nextNoun() → 1, extendStrand → [1, 2] (strand)
    nextNoun() → END (stop)
→ args.length (1) < arity (2)
→ create partial: JSF {arity: 1, capturedArgs: [[1,2]]}
→ emit(<fn[_; _]>[1 2])
```

### Prefix with Separator

```
+ 1, 2
→ evalList: + (V, arity 2)
→ collect args:
    nextNoun() → collectStrand() → 1
    (comma separator breaks strand)
    nextNoun() → collectStrand() → 2
→ apply +(1, 2) → 3
→ emit(3)
```

## Implementation Files

- **imp-eval.mts**: Main evaluator implementation
- **imp-core.mts**: Type definitions and constructors
- **imp-show.mts**: Value serialization for display
- **imp-load.mts**: Parser/lexer (produces token trees for evaluator)
