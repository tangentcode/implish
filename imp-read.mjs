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

let closer = { '[': ']', '(': ')', '{': '}', '.:' : ':.' }

export class TreeBuilder {
  constructor() { this.here = this.root = []; this.stack = [] }
  emit(x) { this.here.push(x) }
  node() { this.stack.push(this.here); this.here = [] }
  done() { let prev = this.stack.pop(); prev.push(this.here); this.here = prev }}

export class SymTable {
  constructor() { this.symtab = {} }
  sym(tok) {
    if (!this.symtab.hasOwnProperty(tok)) {
      this.symtab[tok] = Symbol(tok) }
    return this.symtab[tok] }}

export class ImpReader {
  tree = new TreeBuilder()
  symtbl = new SymTable() // global table for symbols
  buffer = []           // input buffer (list of strings)
  expect = []           // expected closing tokens

  get empty() { return this.buffer.length==0 }
  get waiting() { return this.expect.length>0 }
  get ready() { return this.empty && !this.waiting }

  clear() { this.tree = new TreeBuilder() }
  emit(x) { this.tree.emit(x) }
  node(tok) { this.expect.push(closer[tok]); this.tree.node() }
  done(tok) {
    let ex = this.expect.pop()
    if (tok == ex) this.tree.done()
    else console.error("expected", ex, "got", tok)}

  dump() { console.log(this.tree.root) }
  send(s) { this.buffer.push(s); while (!this.empty) this.scan() }

  read() {
    if (this.ready) { let res = this.tree.root; this.clear(); return res }
    else { console.error("not ready to read") }}

  scan() { // match and process the next token
    if (!this.empty) {
      let src = this.buffer.shift()
      if (src) {
        var m, rx, rule
        for ([rx, rule] of this.syntax) if (m=rx.exec(src)) break
        // assert(m) because of catchall, but TODO: handle string fragments
        if (m) {
          var tok = m[0], rest = src.slice(tok.length)
          if (tok) rule(tok)
          if (rest) this.buffer.unshift(rest)}
        else { console.error("unmatched input:", src)}}}}

  // TODO: nested .: :. should treat everything inside as a single comment
  // TODO: tag the kind of nested node
  // TODO: handle unterminated strings
  // TODO: markdown style multi-line strings
  // TODO: strands of juxtaposed numbers should be a single token
  // TODO: floats (?)
  syntax = [
    [ /^\s+/                 , ok ],
    [ /^\/.*\n/              , ok ],
    [ /^-?\d+/               , x => this.emit([T.INT, parseInt(x)]) ],
    [ /^"(\\.|[^"])*"/       , x => this.emit([T.STR, x]) ],
    [ /^`(\w|[.:-])*\b/      , x => this.emit([T.SYM, this.symtbl.sym(x) ]) ],
    [ /^([[({]|\.:)/         , x => this.node(x) ],
    [ /^(]|:\.|[)}])/        , x => this.done(x) ],
    [ /^\S+/                 , x => this.emit([T.TOK, x]) ]] // catchall, so keep last.
}
