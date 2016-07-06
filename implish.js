// new implish prototype (work in progress)

"use strict";
module.exports = function() {

  this.root = []            // top of data tree
  this.stack = this.root    // current node in nested stack
  this.mark = 0             // index of last committed entry
  this.token =  "^"         // token representing current parser state
  this.state = ["^"]        // internal stack of nodes and parse states
  this.symtab = []          // global table for symbols
  this.lookup = {}          // reverse lookup (symbol->int)
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
  var ok = () => undefined  // no-op

  // -- opcodes ------------

  this.put=(x) => this.stack.push(x)
  this.put2=(x,y) => this.stack.push(x,y)

  this.symbol = function(tok) {
    var code = this.symtab.length
    if (this.lookup.hasOwnProperty(tok)) code = this.lookup[tok]
    else this.symtab.push(tok)
    this.put([T.SYM, code])}

  this.word = (tok)=> this.put([T.TOK, tok])

  this.begin = function(tok) {
    var ctx = []
    this.put(ctx)
    this.state.push(this.stack, this.mark, this.token)
    this.token = tok
    this.stack = ctx}

  this.invoke = (tok)=> undefined
  this.lambda = (tok)=> undefined
  this.define = (tok)=> undefined
  this.commit = (tok)=> undefined

  this.end = function(tok) {
    this.commit(tok)
    this.token = this.state.pop()
    this.mark = this.state.pop()
    this.stack = this.state.pop()}

  this.keyword = function(tok) {
    if (this.macros.hasOwnProperty(tok)) this.macros[tok](tok)
    else this.err(`unknown keyword '#{tok}'`)}

  this.prompt = ()=> console.log("add more input with .addsrc(txt), please")

  this.latest = ()=> this.stack[this.stack.length-1] // `undefined` for empty stack.

  this.wait = ()=> this.waiting = true
  this.addsrc = (s)=> { this.buffer.push(s); this.waiting = false }

  this.show = function(x) {
    // TODO: real show()
    return JSON.stringify(x[1]) }

  this.apply = function() {
    if (this.stack.length==0) throw "nothing to apply!"
    if (this.stack.length<2) throw "no arguments to apply to the function! (" + this.stack.length + ")"
    var tos = this.latest()
    switch (tos[0]) {
      case T.JSF: this.applyJSF(); break;
      case T.IMP: throw "TODO: implement applyIMP()"; break;
      default: throw "invalid type:" + this.types[tos[0]] } }

  this.applyJSF = function() {
    var fn = this.stack.pop(), a = this.stack.pop();
    fn[1](a[1])}

  this.dumpstack = ()=> console.log(this.stack.map(this.show))

  this.scan = function() { // pushes next token and its handler onto stack
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
    [ /^-?\d+/               , x=> this.put([T.INT, parseInt(x)])       ],
    [ /^"(\\.|[^"])*"/       , x=> this.put([T.STR, x])                 ],
    [ /^'(\\.|[^'])*'/       , x=> this.put([T.STR, x])                 ],
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
}
