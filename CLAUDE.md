# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Implish is a tiny, ultraportable programming language designed to be embedded across different tech stacks. It combines an imperative core (inspired by Eric Hehner's "A Practical Theory of Programming") with functional, array-centric features borrowed from APL/K/J/Nial.

Key principles:
- Programs are specifications of behavior that result in changes to named variables
- Code-as-data: simple token tree syntax that can be extended via domain-specific languages
- Portable across platforms (currently TypeScript/Node.js implementation)

## Commands

### Build and Development
```bash
# Compile TypeScript to JavaScript (outputs to dist/)
npm run build

# Watch mode for continuous compilation
npm run watch

# Run the REPL
node dist/imp-cmd.mjs
```

### Testing
No formal test suite yet. Use `imp-tests.org` for manual testing examples.

## Architecture

### Core Modules (*.mts files)

**imp-core.mts**: Type system and data structures
- `ImpVal`: Discriminated union for all implish values (INT, NUM, STR, SYM, LST, etc.)
- `ImpT`: Enum of value types (TOP, INT, NUM, STR, SYM, LST, SEP, JSF, JDY, NIL, etc.)
- `SymT`: Enum of symbol variants (RAW, SET, GET, LIT, FILE, URL, etc.)
- `ImpP`: Parts of speech (V=verb, N=noun, O=operator, S=setter, etc.)
- `JSF`: JavaScript function wrapper (with arity)
- `JDY`: JavaScript dyad (infix operator)
- `SymTable`: Symbol interning table
- `TreeBuilder`: Generic tree construction utility

**imp-load.mts**: Lexer/parser ("code-as-data" loader)
- `ImpLoader`: Converts strings to token trees
- `lexerTable`: Regex-based token matching (numbers, strings, symbols, delimiters)
- `load()`: Main entry point to parse implish code
- Handles nested structures with `[`, `(`, `{`, and `.:`...`:.` comments
- Symbol prefixes: `%file`, `:get`, `foo:` set, `'lit`, `` `quote``, `.msg`, `!msg2`, `@ann`, `#ish`, `/refn`, `?err`, `,unq`

**imp-eval.mts**: Evaluator/interpreter
- `ImpEvaluator`: Stack-based evaluator using "parts of speech" for parsing
- `impWords`: Global dictionary of built-in functions
- Handles assignment (`x: 123`), function calls, infix operators, strands (juxtaposed values)
- Async evaluation (supports Promise-returning functions)
- `nextItem()`: Advances through token stream, resolving symbols
- `collectStrand()`: Handles numeric/symbol vectors (e.g., `1 2 3` → INTs vector)
- `modifyNoun()`: Applies infix operators (dyads) to nouns
- `modifyVerb()`: Handles verb composition and adverbs
- `quasiquote()`: Evaluates backtick-quoted expressions with unquote (`,x`)

**imp-show.mts**: Serializer
- `ImpWriter.show()`: Converts ImpVal back to implish source code
- `impShow()`: Public API for showing values

**imp-cmd.mts**: REPL (Read-Eval-Print Loop)
- Interactive shell with readline support
- Tab completion for file paths (`%path`) and word names
- History persistence in `~/.imp-history`
- Handles multi-line input (unclosed delimiters)

**lib-file.mts**: File path utilities
- `toNativePath()`: Converts implish paths (`%/d/path`) to OS paths (`d:/path` on Windows)
- `toImplishPath()`: Reverse conversion
- `parsePartialPath()`: For tab completion
- Windows drive handling: `%/` lists drives, `%/c/` is C:/, etc.

### Built-in Words (imp-eval.mts)

Arithmetic (element-wise for vectors):
- `+`, `-`, `*`, `%` (integer division)

Functions:
- `!`: Range/iota (e.g., `! 5` → `0 1 2 3 4`)
- `rd`: Read file/URL (async)
- `wr`: Write file (async)
- `e?`: File exists check
- `rm`: Remove file
- `load`: Parse implish code from string or file
- `eval`: Evaluate JavaScript expression (dangerous, use cautiously)
- `echo`: Print value to console
- `show`: Convert value to string representation
- `xmls`: Convert value to XML
- `look`: Show value of a word
- `part`: Get part of speech for a value
- `type?`: Get type of a value

### Important Patterns

**Strands**: Juxtaposed values form vectors
```implish
x: 1 2 3        .: creates INTs vector :.
y: `foo `bar    .: creates SYMs vector :.
```

**Assignment chains**: Right-associative
```implish
a: b: 123       .: sets both a and b to 123 :.
```

**Projection syntax**: Partial/total application
```implish
f[1 2 3]        .: calls f with args [1, 2, 3] :.
f[a; b]         .: calls f with args a and b (semicolon separates) :.
```

**Symbol variants affect evaluation**:
- `foo` → look up word, evaluate
- `foo:` → assignment target (set-word)
- `:foo` → get value of word without further evaluation (get-word)
- `'foo` → literal symbol (lit-word)
- `` `foo`` → quoted symbol (backtick)
- `%foo/bar` → file path
- `http://...` → URL (auto-detected)

**Quasiquotation**: Backtick quotes, comma unquotes
```implish
x: 42
`[1 + ,x]       .: evaluates to [1 + 42] :.
```

### TypeScript Details

- Uses ES2022 modules (`.mts` extension)
- Strict TypeScript with full type checking
- All source files in root directory
- Output goes to `dist/` directory
- Discriminated unions for type safety (check `x[0]` for ImpT)
- Async/await throughout evaluation pipeline

### Known TODOs (from source comments)

- imp-load.mts: Nested `.: :. comments, unterminated strings, floats
- imp-eval.mts: Adverbs, prepositions, conjunctions (modifyVerb)
- docs/parse.md: PEG-style parse library not yet implemented

## Development Notes

- The evaluator uses a "parts of speech" approach (verbs, nouns, operators, etc.) rather than traditional precedence climbing
- Symbol resolution happens during evaluation, not parsing (late binding)
- The loader is deliberately simple: it only recognizes basic token types, leaving semantic interpretation to evaluators
- File paths use a unified syntax (`%/d/path` for Windows, `%/path` for Unix) to avoid platform-specific quoting issues
