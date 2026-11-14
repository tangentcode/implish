# Implish Evaluator

This document describes how implish reads and runs code.

## Overview

You read implish code left to right, but it runs right to left, as in K.

Two files do the work:

- **im-parse.mts** (the parser) turns the token tree from `imp-load.mts`
  into a small syntax tree, one statement at a time.
- **imp-eval.mts** (the evaluator) runs that syntax tree.

The evaluator asks the parser for one statement, runs it, and then asks
for the next one. The parser looks up each word in the dictionary when it
parses the statement, to learn if the word is a verb and how many
arguments it takes. Because a statement runs before the next one is
parsed, a word that one statement defines is known to the next one:

```
f: {x + 1}  f 5        .: 6 :.
```

## The rules

### 1. A dyad takes everything to its right

A dyad (a verb with two arguments) in infix position takes the whole
expression to its right as its right argument. There is no precedence
between verbs.

```
2 + 3 * 5              .: 2 + (3 * 5) = 17 :.
10 - 5 - 2             .: 10 - (5 - 2) = 7 :.
2 * 3 + 4              .: 2 * (3 + 4) = 14 :.
(2 * 3) + 4            .: 10 :.
```

Any verb with arity 2 can be used infix: `+`, `min`, `tk`, or a user
function such as `{x + y}`.

### 2. A prefix verb takes one term per argument

A verb with nothing on its left is prefix. It takes the next term as its
argument (or the next terms, one per argument). A term is:

- a noun: a number, a strand such as `1 2 3`, a string, a word that
  holds data, a get-word, a quoted symbol, a `[ ]` block, a `( )` group,
  or a projection such as `f[a; b]`;
- a set-word and the expression to its right (rule 4);
- a verb and its own terms.

So a prefix verb binds tighter than a dyad:

```
rev a + 10 * a         .: (rev a) + (10 * a) :.
rev 1 2 3 + 10 20 30   .: (rev 1 2 3) + 10 20 30 = 13 22 31 :.
rev (1 2 3 + 10 20 30) .: 33 22 11 :.
echo show type? 3      .: echo (show (type? 3)) :.
+ a b                  .: +[a; b] :.
```

To give a monad a whole expression, use `( )`, a projection `f[...]`, or
a comma (rule 5). For example, a recursive call needs brackets:

```
fact: {ite[x < 2; 1; x * fact[x - 1]]}
```

`fact x - 1` would be `(fact x) - 1`.

If a prefix verb gets fewer terms than it needs, the result is a partial
application: `+ 1` gives `+[1]`. A verb with no terms at all is just the
verb as a value: `each[rev; ...]`.

A dyad can start a term only right after a prefix verb, before any
argument. After a term, a dyad is always infix.

A monad whose term is a bare verb gives a composition: `rev !` is a
monad that runs `!` and then `rev`. So `(rev !) 5` is `4 3 2 1 0`.

### 3. A monad after a term is postfix

A monad right after a term applies to that term. It binds as tight as a
prefix monad:

```
2 !                    .: ![2] :.
"hello" ord - 32 chr   .: (ord "hello") - (chr 32) :.
```

Nouns after a postfix monad are extra arguments, and the evaluator
reports a valence error: `2 ! 10`.

A dyad with nothing on its right is a partial application: `2 +` gives
`+[2]`.

### 4. A set-word takes everything to its right

```
x: 2 + 3 * 4           .: x is 14 :.
1 + y: 2 * 3           .: y is 6, the result is 7 :.
rev x: 1 + ! 3         .: x is 1 2 3, the result is 3 2 1 :.
a: b: 5                .: both are 5 :.
```

A function literal right after a set-word is a value (a noun), not a
verb: `f: {x + 1}` stores the function. The rest of the expression is
parsed as usual, so `f: {x + 1} type?` stores `ifn!`.

### 5. The comma

A comma ends a clause. The clause on its left runs first. Its value then
becomes the first item of the clause on its right.

- If the value is a noun, the clause on the right usually starts with a
  verb, and that verb takes the value as its left argument. A dyad then
  takes everything to its right, as usual. A monad applies to the value.
- If the value is a verb that still needs arguments (a partial
  application), the clause on the right gives those arguments.
- A set-word gives the value it stores. So if it stores a verb, the
  clause on the right gives the arguments: `f: {x + 1}, 5` is 6.
- The parser parses the clause on the right after the clause on the
  left has run. So it sees words that the left clause defined:
  `f: {x + 1}, 5, f` is 7.
- A get-word gives the value of its word. If that value is a verb,
  `:f , 5` is `f 5`, and so is `(:f) 5`. A get-word alone does not
  call the function: `:f` gives `{x + 1}`.

```
2, + 3 * 5, + 7              .: (2 + (3 * 5)) + 7 = 24 :.
! 10, * 2, + 1               .: ((! 10) * 2) + 1 :.
! 5, rev                     .: rev (! 5) :.
rev x: 1 + ! 3 , + 10 * x    .: (rev x) + (10 * x) = 13 22 31 :.
ord "hello" - 32, chr        .: chr ((ord "hello") - 32) = "HELLO" :.
+ 1 2 3, 4 5 6               .: +[1 2 3; 4 5 6] = 5 7 9 :.
g 3, 5                       .: g[3; 5] :.
```

A comma carries only the last statement of the clause on its left, and it
never reaches across a `;` or a newline:

```
a: 1 + ! 3 ; rev a , + 10 * a    .: a is 1 2 3, the result is 13 22 31 :.
y: 9  z: ! 3, + 1                .: y is 9, z is 0 1 2, the result is 1 2 3 :.
```

A comma with nothing on one side is an error.

Inside a projection `f[...]`, only `;` (or a newline) separates
arguments. A comma inside an argument is the comma operator.

Inside a `[ ]` data block, a comma only separates items (rule 8).

### 6. `;` and newlines end a statement

`;`, `|` and newlines end a statement. Statements run left to right, and
the value of a sequence is the value of its last statement.

Two terms side by side with no verb between them are also two
statements (Logo-like sequence sugar):

```
x: 12  y: 34  z: 56    .: three statements; the value is 56 :.
1 `x                   .: two statements; the value is `x :.
```

The token `.|` is not used. It is kept free for a possible future
pipeline operator.

### 7. Arguments run right to left

When a call has more than one argument, the evaluator runs the last
argument first, as in K. This also holds for projections `f[a; b]`.

```
x + x: 5               .: the right side runs first, so this is 10 :.
```

The clause left of a comma always runs before the clause on its right.

There is one more exception. The parser must know if a `( )` group or a
full projection `f[...]` gives a verb when a term follows it: if it is a
verb, it applies to that term, and if not, the two are separate
statements. So the parser asks the evaluator to run the group or
projection at that point, and then it goes on with the real value. This
does not change the order in most code, because a function runs before
its arguments and separate statements run left to right. It changes the
order only when such a group is an argument of a prefix verb and another
term follows it:

```
o: 0
+ (o: o + 1) (o: o * 10)    .: the left group runs first: 1 + 10 = 11 :.
(o: o + 1) + (o: o * 10)    .: a dyad follows, so right to left: 1 :.
```

When a dyad or nothing follows a group, the group runs at the normal
time, and the parser guesses from the code in the group if it is a verb.

The parser runs a group early only when it takes the group as a term:
at the start of a statement, after a dyad or set-word, or as an argument
of a prefix verb. When it only looks ahead past the end of a statement
(to check for a dyad or a postfix monad), it does not run the group. So
in `echo "first" (echo "second") 3`, "first" prints before "second".

### 8. Blocks: `[ ]` is data

A `[ ]` block is data. It is not run. Inside a block:

- numbers side by side form one strand, and backtick symbols side by
  side form one symbol strand;
- `;` and `,` separate items (they are not kept);
- nested `[ ]` blocks are read the same way;
- all other tokens (words, set-words, `( )`, `{ }`) stay as they are.

```
[1 + 2]                .: [1 + 2], three items :.
[1 2; 3 4]             .: two items: 1 2 and 3 4 :.
count [a b c]          .: 3 :.
```

The other kinds of list:

| Form        | Meaning                                                    |
|-------------|------------------------------------------------------------|
| `( ... )`   | code: run it and give the last value                       |
| `{ ... }`   | function literal; arity comes from the names x, y, z used  |
| `f[ ... ]`  | projection: call `f` with arguments separated by `;`       |
| `:[ ... ]`  | dictionary literal; each value is run as code              |
| `'[ ... ]`  | the raw token list, with one quote removed                 |
| `` `[ ... ]`` | quasiquote: like data, but `,x` puts in the value of x  |

The words `ite`, `while` and `cond` are lazy: in a projection they get
the code of each argument unevaluated, and they decide what to run.

### 9. Strands

Numbers side by side form one vector: `1 2 3`. Backtick symbols side by
side form one symbol vector: `` `a `b `c``. This is purely lexical and
happens before parsing.

## Words and late binding

- A plain word whose value is a function (JSF or IFN) is a verb. Its
  arity comes from the function. Arity -1 means variadic.
- A function value (JSF or IFN) in the token tree itself is a verb
  too, with its own arity. It can come from the embedding API or from
  an unquote: `` r: :rev  `[,r 1 2 3] `` gives a list that runs as
  `rev 1 2 3`.
- Any other plain word is a noun. Its value is looked up when the
  statement runs. A stored value is not run again: if `l` holds a list,
  `l` gives that list.
- `name/` and `name\` are fold and scan verbs when `name` is a dyad.
- A `( )` group or a full projection whose value is a verb is a verb
  when a term follows it: `(rev !) 5`, ``get[`f] 5`` (see rule 7).
- A projection `f[a]` of a verb that needs more arguments is a verb:
  `add[3] 5` is `add[3; 5]`.
- A noun that gives a dictionary, followed by a backtick symbol, is an
  index: `` d`a ``, `` (:d)`a ``, `` get[`d]`a ``, `` :[`b 7]`b ``.
- The help word `?` takes the next token as it is and does not run
  it: `? rev`. In `? (x: 1)` the group does not run.

## Syntax tree

The parser makes these nodes (see `Node` in im-parse.mts):

| Node      | Meaning                                                 |
|-----------|---------------------------------------------------------|
| `val`     | a literal, or a list that `eval()` handles by its opener |
| `quote`   | a token passed as it is and never run (the `?` word)    |
| `ref`     | a word used as a noun                                   |
| `get`     | `:foo`                                                  |
| `set`     | `foo: expr`                                             |
| `verb`    | a verb that is not applied                              |
| `call`    | a verb applied to arguments (maybe a partial)           |
| `compose` | `f g` with no argument                                  |
| `index`   | `` d`key ``                                             |
| `thread`  | `left , body`: run `left`, then `body`                  |
| `hold`    | the place in `body` where the value of `left` goes      |

The `imparse` word shows the syntax tree as M-expressions:

```
imparse '[2 + 3 * 5]          .: +[2 ; *[3 ; 5]] :.
imparse '[! 10 * 2 + 1]       .: *[![10] ; +[2 ; 1]] :.
imparse '[2, + 3 * 5]         .: +[2 ; *[3 ; 5]] :.
imparse load "x: 2 + 3"       .: set[`x ; +[2 ; 3]] :.
```

`imparse` does not run anything, so it does not know words that the
code itself defines.

## Function application

- **JSF** (JavaScript function): `imp.jsf(fn, arity)`. Fewer arguments
  than the arity give a partial application. More give a valence error.
- **IFN** (implish function): `{x + y}`. The evaluator binds `x`, `y`,
  `z`, runs the body, and then restores the old bindings. The body is
  parsed each time the function runs.

## Implementation files

- **im-parse.mts**: parser, data block reader, strands, `imparse`
- **imp-eval.mts**: evaluator (`ImpEvaluator`, `impEval`)
- **imp-core.mts**: type definitions and constructors
- **imp-show.mts**: value serialization for display
- **imp-load.mts**: lexer (produces token trees for the parser)
