# implish
implish: a tiny programming language

**Note**: *As of Feb 2024, implish is a work in progress. The following text is aspirational, and may contain contradictions.*
## ultraportable

Almost all programming languages these days are portable across different hardware and operating systems. Implish is intended to be portable across *tech stacks*.

You should be able to use the same language to write code in a game engine, your text editor,  the front or back-end of a web application, or even your shell. Different host languages provide different abilities (access to libraries or novel features) but you shouldn't have to throw out your whole toolset every time you try a new tech stack.

## imperative core

It seems almost taboo to make an imperative programming language these days. Everyone knows that purely functional programming languages make it easier to reason about state.

But is it possible there are *other* approaches that also make it easier to reason about state?

Implish follows Eric Hehner's *[A Practical Theory of Programming](https://www.cs.toronto.edu/~hehner/aPToP/)*, in which programs are specifications of behavior resulting in changes to named variables. (see: [aptop.md](docs/aptop.md))

In implish, if `p` and `q` are programs, `x` is a variable,  and `b` is a binary expression, then the following are all programs:

```implish
ok                 .: the empy program (no variables change) :.
x: 123             .: assignment (x' = 123, other vars are unchanged) :.
p ; q              .: sequence :.
if b [p] el [q]    .: condition :.
while b [p]        .: repetition :.
```

The following constructs are implemented in terms of the above:

```implish
rep [p] until b    .: repeat until .:
for x xs [p]       .: iterator :.
```

## functional and array-centric

Of course, functional programming *does* have a lot to offer, so implish tries to support purely functional, referentially transparent expressions whenever possible.

The implish expression syntax borrows heavily from the APL family of languages (including K, J, and Nial), offering a rich assortment of  functional operations.

```implish
x: 0 1 2 3 4        .: "strand notation" for numeric arrays :.
x: ! 5              .: same: "!" is "iota" or "range" :.
cheq 10 +/ x        .: check equaliy of the sum  :.
cheq +/ x 10        .: same (slightly unusual in array langs) :.
```

```implish
f: {[n] n + 1 }       .: k-style lambdas :.
f: {x + 1}            .: same. signature [x] is implied :.

cheq 1 2 3 4 5 f x    .: "map" is generally implied :.
cheq[1 + ! 5] f x     .: projection syntax (partial application) :.
cheq[1 + ! 5; f[x]]   .: projection can be total application too :.
```

## code as data (so dialects are easy)

The rules for the base syntax are simple:

- strings are double quoted and fit on one line (using `\` for escapes)
- triple-backticks start and end multi-line strings (as in markdown)
- numbers look like numbers
- parentheses, square brackets, and curly braces form nested structures
- `.:` and `:.` delimit nestable comments
- everything else is just symbols separated by whitespace

The `load` primitive can parse this much, and a [parse library](docs/parse) can then further match and expand the resulting "token trees" to create domain specific languages.

## concurrency and object orientation

If you believe programs specify behavior in terms of changes to public variables, and you want to keep those variables manageable, then it might make sense to break your system up into lots of little programs running on their own computers.

This is sort of the original line of thinking behind "object oriented programming", at least according to the guy who invented the term:

> I thought of objects being like biological cells and/or individual computers on a network, only able to communicate with messages

-- [Alan Kay](http://userpage.fu-berlin.de/~ram/pub/pub_jf47ht81Ht/doc_kay_oop_en)

In implish, objects are just separate copies of the virtual machine each speaking their own dialect with their own words and variables.

## gradually typed

I like type annotations. Sometimes I like to start with them. Sometimes I don't. Implish gives you the flexibility to do either.

## database included

Implish includes a table type, similar to tables in a relational database, or "data frames" in languages like python and R.

As stated earlier, implish can run atop various technology stacks and make use of "virtual hardware".  Some of these stacks include SQLite, allowing implish to seamlessly persist data simply by modifying variables.

## examples

```implish
wrln "hello, world!"
```

```implish
name: input -prompt "what is your name?"
wrln tpl "hello, {name}!"
```

```implish
.: fizzbuzz :.
for i range 100 [
  if not i mod 15 [wr "FizzBuzz"]
  ef not i mod 5  [wr "Buzz"]
  ef not i mod 3  [wr "Fizz"]
  el [wr i]
  if i mod 10 [wrln] el [ok]]
```

```implish
.: mandelbrot set (work in progress, translating from K) :.

s: {(-/*:x),2**/x}                 .: complex square (explicit lambda. x is R,Im pair) :.
m: (%. +/ *:)                      .: magnitude (tacit pipeline: sqrt of sum of squared distances) :.

d: 120 60                          .: dimensions of the picture :.
t: -88 -30                         .: camera translation :.
f: % 40 20                         .: scale factor (%x is 1/x) :.

.: TODO: this next line may need some translation :.
c: (,/:\:) . f * t + !:' d          .: complex plane near mandelbrot set :.

z: d # ,0 0                         .: 3d array of zeroes in same shape :.

.: TODO: this line probably needs work too :.
r: (); do 8  [r,:,z:s''[z] + c]     .: collect "z = s(z) +c' 8 times :.

o: " 12345678"@ +/ 2 < m''' r       .: "color" by how soon point "escapes" :.

wrln ' + o                          .: transpose and print the output :.
```

## how to try it or get in touch

As of this writing (Feb 2024), only the loader exists. Stay tuned.

If you'd like to talk to me about this, you can join the #implish discord channel from the  [TangentCode community page](https://tangentcode.com/community) or [find me on your favorite platform](http://tangentstorm.com/).
