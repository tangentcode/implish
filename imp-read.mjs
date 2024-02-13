// Implish reader (parser)
import { ok, T, SymTable, TreeBuilder } from './imp-core.mjs'

let closer = { '[': ']', '(': ')', '{': '}', '.:' : ':.' }

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
    [ /^-?\d+/               , x => this.emit([T.INT, parseInt(x)]) ],
    [ /^"(\\.|[^"])*"/       , x => this.emit([T.STR, x]) ],
    [ /^```.*```/s           , x => this.emit([T.MLS, x]) ],
    [ /^([[({]|\.:|\S+\[)/   , x => this.node(x) ],
    [ /^(]|:\.|[)}])/        , x => this.done(x) ],
    [ /^\S+/                 , x => this.emit([T.SYM, this.symtbl.sym(x)]) ]] // catchall, so keep last.
}
