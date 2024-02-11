// new implish prototype (work in progress)

function ok() { }  // no-op

let T = {      // data types
  NIL: 'NIL',  // null type
  INT: 'INT',  // integer
  STR: 'STR',  // string
  SYM: 'SYM',  // symbol
  JSF: 'JSF',  // js function (primitive)
  IMP: 'IMP',  // implish function
  TOK: 'TOK',  // implish token
};

export class Imp {

  root = []            // top of data tree
  stack = this.root    // current node in nested stack
  token =  "^"         // token representing current parser state
  state = ["^"]        // internal stack of nodes and parse states
  symtab = {}          // global table for symbols
  buffer = []          // input buffer (list of strings)
  waiting = true       // waiting for input?


  put(x) { this.stack.push(x) }
  put2(x,y) { this.stack.push(x,y) }

  symbol(tok) {
    if (!this.symtab.hasOwnProperty(tok)) { this.symtab[tok] = Symbol(tok) }
    return this.symtab[tok]}

  word(tok){ this.put([T.TOK, tok]) }

  begin(tok) {
    var ctx = []
    this.put(ctx)
    this.state.push(this.stack, this.token)
    this.token = tok
    this.stack = ctx}

  end(tok) {
    this.token = this.state.pop()
    this.stack = this.state.pop()}

  prompt() { console.log("add more input with .addsrc(txt), please") }

  latest() { return this.stack[this.stack.length-1] } // `undefined` for empty stack.

  wait() { this.waiting = true }
  addsrc(s) { this.buffer.push(s); this.waiting = false }

  apply() {
    if (this.stack.length==0) throw "nothing to apply!"
    if (this.stack.length<2)
      throw "no arguments to apply to the function! (" + this.stack.length + ")"
    var tos = this.latest()
    switch (tos[0]) {
      case T.JSF: this.applyJSF(); break;
      case T.IMP: throw "TODO: implement applyIMP()"; break;
      default: throw "invalid type:" + tos[0] } }

  applyJSF() {
    var fn = this.stack.pop(), a = this.stack.pop();
    fn[1](a[1])}

  dumpstack() { console.log(this.stack.map(x=>x[1])) }

  scan() { // pushes next token and its handler onto stack
    if (this.buffer.length) {
      var m, rule, src = this.buffer.shift()
      for (rule of this.syntax) if (m=rule[0].exec(src)) break
      var tok = m ? m[0] : '', etc = src.slice(tok.length)
      if (tok) this.put2([T.STR, tok], [T.JSF, rule[1]])
      if (etc) this.buffer.unshift(etc)}
    else this.put2([T.STR, ''], [T.JSF, _=>this.wait()])}

  syntax = [
    [ /^\s+/                 , ok ],
    [ /^\/.*\n/              , ok ],
    [ /^-?\d+/               , x => this.put([T.INT, parseInt(x)]) ],
    [ /^"(\\.|[^"])*"/       , x => this.put([T.STR, x]) ],
    [ /^'(\\.|[^'])*'/       , x => this.put([T.STR, x]) ],
    [ /^`(\w|[.:-])*\b/      , x => this.put([T.SYM, this.symbol(x) ]) ],
    [ /^[[({]/               , x => this.begin(x) ],
    [ /^(]|[)}])/            , x => this.end(x) ],
    [ /^\?/                  , _ => this.dumpstack() ],
    [ /^\S+/                 , x => this.word(x) ]] // catchall, so keep last.
}
