// Implish reader (parser)
import { T, ok, SymTable, TreeBuilder } from './imp-core.mjs'
import * as imp from './imp-core.mjs'

let closer = { '[': ']', '(': ')', '{': '}', '.:' : ':.' }

export class ImpReader {
  tree = new TreeBuilder()
  symtbl = new SymTable() // global table for symbols
  buffer = []           // input buffer (list of strings)
  expect = []           // expected closing tokens

  get empty() { return this.buffer.length===0 }
  get waiting() { return this.expect.length>0 }
  get ready() { return this.empty && !this.waiting }

  clear() { this.tree = new TreeBuilder() }
  emit(x) { this.tree.emit(x) }

  node(tok) {
    this.tree.node();
    let o = tok === ".:" ? tok : tok.slice(-1)
    this.expect.push({open: tok, close:closer[o]});  }
  done(closeTok) {
    let ex = this.expect.pop()
    if (!ex) console.error("unexpected", closeTok)
    else if (closeTok === ex.close) {
      this.tree.done()
      let that = this.tree.here.pop()
      if (closeTok !== ':.') this.tree.emit(imp.lst(ex, that))}
    else console.error("expected", ex.close, "got", closeTok)}

  dump() { console.log(this.tree.root) }
  send(s) {
    this.buffer.push(s);
    while (!this.empty) this.scan();
    return this }

  read() {
    if (this.ready) {
      let res = this.tree.root;
      this.clear();
      return [T.TOP, {}, res ]}
    else { console.error("not ready to read") }}

  scan() { // match and process the next token
    if (!this.empty) {
      let src = this.buffer.shift()
      if (src) {
        let m, rx, rule
        for ([rx, rule] of this.syntax) if ((m=rx.exec(src))) break
        // assert(m) because of catchall, but TODO: handle string fragments
        if (m) {
          let tok = m[0], rest = src.slice(tok.length)
          if (tok) rule(tok)
          if (rest) this.buffer.unshift(rest)}
        else { console.error("unmatched input:", src)}}}}

  // TODO: nested .: :. should treat everything inside as a single comment
  // TODO: handle unterminated strings
  // TODO: strands of juxtaposed numbers should be a single token
  // TODO: floats (?)
  syntax = [
    [ /^((?!\n)\s)+/s, ok ], // ignore whitespace
    [ /^[;|\n]/m             , x => this.emit(imp.sep(x)) ],
    [ /^-?\d+/               , x => this.emit(imp.int(parseInt(x))) ],
    [ /^"(\\.|[^"])*"/       , x => this.emit(imp.str(x.slice(1,-1))) ],
    // TODO: markdown style multi-line strings
    // [ /^```.*```/           , x => this.emit(imp.mls(x)) ],
    [ /^(((?![[({])\S)*[[({]|\.:)/      , x => this.node(x) ],
    [ /^(]|:\.|[)}])/        , x => this.done(x) ],
    [ /^((?![\])}])\S)+/     , x => this.emit(imp.sym(this.symtbl.sym(x))) ]] // catchall, so keep last.
}

// impStr -> impData
export let read = (impStr) => new ImpReader().send(impStr[2]).read()