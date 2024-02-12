Implish has a small imperative core inspired by Eric Hehner's [A Practical Theory of Programming](https://www.cs.toronto.edu/~hehner/aPToP/).

In Hehner's view, a program is a specification of behavior, which can be observed by inspecting named variables.

A specification is just a binary expression (true or false) concerning named variables before and after an operation.

For example, a program to increment a number, might be specified like this:

```
inc: {if n :: Num [n' = n + 1] el ok}
```

Here `n` is a variable defined externally by the program.
