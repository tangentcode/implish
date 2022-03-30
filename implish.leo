<?xml version="1.0" encoding="utf-8"?>
<!-- Created by Leo: http://leoeditor.com/leo_toc.html -->
<leo_file xmlns:leo="http://leoeditor.com/namespaces/leo-python-editor/1.1" >
<leo_header file_format="2"/>
<globals/>
<preferences/>
<find_panel_settings/>
<vnodes>
<v t="tangentstorm.20220329190225.1"><vh>implish</vh>
<v t="tangentstorm.20220329190344.1"><vh>goals</vh></v>
<v t="tangentstorm.20220329191124.1"><vh>data types</vh></v>
<v t="tangentstorm.20220329190348.1"><vh>control flow</vh></v>
</v>
<v t="tangentstorm.20220329192754.1"><vh>prototype: symbolic interpreter</vh>
<v t="tangentstorm.20220329193828.1"><vh>bare minimum interpreter</vh></v>
<v t="tangentstorm.20220329192842.1"><vh>k-like meta-syntax</vh></v>
<v t="tangentstorm.20220329195243.1"><vh>use as a generic linter/refactoring tool</vh>
<v t="tangentstorm.20220329212812.1"><vh>linter</vh></v>
<v t="tangentstorm.20220329212839.1"><vh>refactoring</vh>
<v t="tangentstorm.20220329212851.1"><vh>extract function</vh></v>
</v>
</v>
</v>
<v t="tangentstorm.20220329183021.1"><vh>@path d:/ver/implish</vh>
<v t="tangentstorm.20220329183230.2"><vh>@clean imp</vh></v>
<v t="tangentstorm.20220329183230.4"><vh>@clean implish.js</vh>
<v t="tangentstorm.20220329183230.5"><vh>module.exports = function</vh>
<v t="tangentstorm.20220329183230.6"><vh>this.symbol = function</vh></v>
<v t="tangentstorm.20220329183230.7"><vh>this.begin = function</vh></v>
<v t="tangentstorm.20220329183230.8"><vh>this.end = function</vh></v>
<v t="tangentstorm.20220329183230.9"><vh>this.keyword = function</vh></v>
<v t="tangentstorm.20220329183230.10"><vh>this.show = function</vh></v>
<v t="tangentstorm.20220329183230.11"><vh>this.apply = function</vh></v>
<v t="tangentstorm.20220329183230.12"><vh>this.applyJSF = function</vh></v>
<v t="tangentstorm.20220329183230.13"><vh>this.scan = function</vh></v>
</v>
</v>
</v>
</vnodes>
<tnodes>
<t tx="tangentstorm.20220329183021.1"></t>
<t tx="tangentstorm.20220329183230.10">this.show = function(x) {
  // TODO: real show()
  return JSON.stringify(x[1]) }

</t>
<t tx="tangentstorm.20220329183230.11">this.apply = function() {
  if (this.stack.length==0) throw "nothing to apply!"
  if (this.stack.length&lt;2) throw "no arguments to apply to the function! (" + this.stack.length + ")"
  var tos = this.latest()
  switch (tos[0]) {
    case T.JSF: this.applyJSF(); break;
    case T.IMP: throw "TODO: implement applyIMP()"; break;
    default: throw "invalid type:" + this.types[tos[0]] } }

</t>
<t tx="tangentstorm.20220329183230.12">this.applyJSF = function() {
  var fn = this.stack.pop(), a = this.stack.pop();
  fn[1](a[1])}

this.dumpstack = ()=&gt; console.log(this.stack.map(this.show))

</t>
<t tx="tangentstorm.20220329183230.13">this.scan = function() { // pushes next token and its handler onto stack
  if (this.buffer.length) {
    var m, rule, src = this.buffer.shift()
    for (rule of this.syntax) if (m=rule[0].exec(src)) break
    var tok = m ? m[0] : '', etc = src.slice(tok.length)
    if (tok) this.put2([T.STR, tok], [T.JSF, rule[1]])
    if (etc) this.buffer.unshift(etc)}
  else this.put2([T.STR, ''], [T.JSF, this.wait])}

this.syntax = [
  [ /^\s+/                 , ok                                       ],
  [ /^\/.*\n/              , ok                                       ],
  [ /^-?\d+/               , x=&gt; this.put([T.INT, parseInt(x)])       ],
  [ /^"(\\.|[^"])*"/       , x=&gt; this.put([T.STR, x])                 ],
  [ /^'(\\.|[^'])*'/       , x=&gt; this.put([T.STR, x])                 ],
  [ /^`(\w|[.:-])*\b/      , this.symbol                              ],
  [ /^[[({]/               , this.begin                               ],
  [ /^]|[)}]/              , this.end                                 ],
  [ /^:[a-z]*/             , this.invoke                              ],
  [ /^:\(/                 , this.lambda                              ],
  [ /^::/                  , this.define                              ],
  [ /^;/                   , this.commit                              ],
  [ /^\?/                  , this.dumpstack                           ],
  [ /^\S+/                 , this.word                                ]] // catchall, so keep last.

this.macros = {
  ":if" : this.begin,
  ":ef" : this.begin,
  ":el" : this.begin,
  ":en" : this.end }

return this;
</t>
<t tx="tangentstorm.20220329183230.2">@language unknown_language
#!/usr/bin/node
var prompt = require("prompt");
var Imp = require("./implish.js");

prompt.message=""

imp = new Imp();

imp.runTilEmpty = function() {
  while (!imp.waiting) {
    imp.scan()
    imp.apply()}
  imp.prompt()}

imp.prompt = function() {
  prompt.get("imp&gt;", function(err, res) {
    if (err) console.log(err)
    else imp.addsrc(res["imp&gt;"])
    imp.runTilEmpty() })}

imp.runTilEmpty()
</t>
<t tx="tangentstorm.20220329183230.4">// new implish prototype (work in progress)

"use strict";
@others
@language javascript
@tabwidth -4
</t>
<t tx="tangentstorm.20220329183230.5">module.exports = function() {

  this.root = []            // top of data tree
  this.stack = this.root    // current node in nested stack
  this.mark = 0             // index of last committed entry
  this.token =  "^"         // token representing current parser state
  this.state = ["^"]        // internal stack of nodes and parse states
  this.symtab = []          // global table for symbols
  this.lookup = {}          // reverse lookup (symbol-&gt;int)
  this.buffer = []          // input buffer (list of strings)
  this.waiting = true       // waiting for input?

  var T = this.T = {        // data types
    NIL: 0,  // null type
    INT: 1,  // integer
    STR: 2,  // string
    SYM: 3,  // symbol
    JSF: 4,  // js function (primitive)
    IMP: 5,  // implish function
    TOK: 6,  // implish token
  };
  this.types = ["NIL", "INT", "STR", "SYM", "JSF", "IMP", "TOK"]
  var NIL = [T.NIL]         // only ever need one NIL token
  var ok = () =&gt; undefined  // no-op

  // -- opcodes ------------

  this.put=(x) =&gt; this.stack.push(x)
  this.put2=(x,y) =&gt; this.stack.push(x,y)

  @others
}
</t>
<t tx="tangentstorm.20220329183230.6">this.symbol = function(tok) {
  var code = this.symtab.length
  if (this.lookup.hasOwnProperty(tok)) code = this.lookup[tok]
  else this.symtab.push(tok)
  this.put([T.SYM, code])}

this.word = (tok)=&gt; this.put([T.TOK, tok])

</t>
<t tx="tangentstorm.20220329183230.7">this.begin = function(tok) {
  var ctx = []
  this.put(ctx)
  this.state.push(this.stack, this.mark, this.token)
  this.token = tok
  this.stack = ctx}

this.invoke = (tok)=&gt; undefined
this.lambda = (tok)=&gt; undefined
this.define = (tok)=&gt; undefined
this.commit = (tok)=&gt; undefined

</t>
<t tx="tangentstorm.20220329183230.8">this.end = function(tok) {
  this.commit(tok)
  this.token = this.state.pop()
  this.mark = this.state.pop()
  this.stack = this.state.pop()}

</t>
<t tx="tangentstorm.20220329183230.9">this.keyword = function(tok) {
  if (this.macros.hasOwnProperty(tok)) this.macros[tok](tok)
  else this.err(`unknown keyword '#{tok}'`)}

this.prompt = ()=&gt; console.log("add more input with .addsrc(txt), please")

this.latest = ()=&gt; this.stack[this.stack.length-1] // `undefined` for empty stack.

this.wait = ()=&gt; this.waiting = true
this.addsrc = (s)=&gt; { this.buffer.push(s); this.waiting = false }

</t>
<t tx="tangentstorm.20220329190225.1"></t>
<t tx="tangentstorm.20220329190344.1">@

- bootstrap in js
- real thing runs on tiny multi-core virtual machine


- high level language, with garbage collection
- sort of a blend of python, nial, smalltalk, k
- asynchronous
- generators


narrative, iterative style
</t>
<t tx="tangentstorm.20220329190348.1">- pattern matching
- method dispatch
- everything async

- comprehensions?
- do notation?
</t>
<t tx="tangentstorm.20220329191124.1">scalar:
  - bit
  - symbol
  - integers of various sizes
  - character

- array
- algebraic types
- function
- dictionary
- generator
- object/instance
- interface

</t>
<t tx="tangentstorm.20220329192754.1"></t>
<t tx="tangentstorm.20220329192842.1">
- : for declaration/assignment
- ; for sequence (plus parens and right to left evaluation)
- ?[ ] for if/elif
- ![ ] for while

- .[ ] for application
- @[ ] for application

- {} , {[names] } for lambda
</t>
<t tx="tangentstorm.20220329193828.1">- state [as variable bindings in a namespace]
- sequence
- condition
- repetition [loop]
</t>
<t tx="tangentstorm.20220329195243.1"></t>
<t tx="tangentstorm.20220329212812.1">
- linter tool
  - provide a list of names referenced and used in the scope
  - better yet, list of names *at a cursor position*, or used in a selected region.
  - note names that are used but not declared
</t>
<t tx="tangentstorm.20220329212839.1">- parse and map onto the sequence operator
- really only need to be able to track:
  - initial definitions/declarations
  - sequence
  - mutation
  - input/output
  - condition
  - reference


- refactoring tool
  - expressions should have some kind of side effect unless they're inspected or returned
  - assume that freestanding f[x] is a function call with side effects (and not useless array indexing)
    - therefore f itself must be a function and probably defined elsewhere

</t>
<t tx="tangentstorm.20220329212851.1">so: to extract a function,
  - highlight the phrase
  - it should be a valid token tree (forest?)
  - determine which local names need to be used as parameters
  - determine which names are modified (outputs)
    - does language allow multiple return values? multiple assignment? pass by reference?
    - or bundle various locals into a struct?

to find other code that uses the same pattern:
  - treat the code as a unification template
  - scan for matches
</t>
</tnodes>
</leo_file>
