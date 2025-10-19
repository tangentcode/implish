// Implish reader (parser)
import {type ImpVal, ImpT, ok, SymTable, TreeBuilder, NIL, ImpStr, ImpC, ImpErr, ImpTop} from './imp-core.mjs'
import * as imp from './imp-core.mjs'

let closer: Record<string, string> = { '[': ']', '(': ')', '{': '}', '.:' : ':.' }
type TokenRule = (token:string) => void

export class ImpReader {
  tree: TreeBuilder<any> = new TreeBuilder()
  symtbl = new SymTable() // global table for symbols
  buffer: string[] = []           // input buffer (list of strings)
  expect: Array<{open: string, close: string}> = []           // expected closing tokens

  get empty() { return this.buffer.length===0 }
  get waiting() { return this.expect.length>0 }
  get ready() { return this.empty && !this.waiting }

  clear(): void { this.tree = new TreeBuilder() }
  emit(x: any): void { this.tree.emit(x) }

  node(tok: string): void {
    this.tree.node();
    let o = tok === ".:" ? tok : tok.slice(-1)
    this.expect.push({open: tok, close:closer[o]});  }
  done(closeTok: string): void {
    let ex = this.expect.pop()
    if (!ex) console.error("unexpected", closeTok)
    else if (closeTok === ex.close) {
      this.tree.done()
      let that = this.tree.here.pop()
      if (closeTok !== ':.') this.tree.emit(imp.lst(ex, that))}
    else console.error("expected", ex.close, "got", closeTok)}

  dump(): void { console.log(this.tree.root) }
  send(s: string): ImpReader {
    this.buffer.push(s);
    while (!this.empty) this.scan();
    return this }

  read(): ImpTop | ImpErr {
    if (this.ready) {
      let res = this.tree.root;
      this.clear();
      return ImpC.top(res)}
    else return ImpC.err("failed to read")}

  scan(): void { // match and process the next token
    if (!this.empty) {
      let src = this.buffer.shift()
      if (src) {
        let m:RegExpExecArray|null=null, rx:RegExp, rule:TokenRule|null=null
        for ([rx, rule] of this.syntax) if ((m=rx.exec(src))) break
        // assert(m) because of catchall, but TODO: handle string fragments
        if (m) {
          let tok = m[0], rest = src.slice(tok.length)
          if (tok && rule) rule(tok)
          if (rest) this.buffer.unshift(rest)}
        else { console.error("unmatched input:", src)}}}}

  // TODO: nested .: :. should treat everything inside as a single comment
  // TODO: handle unterminated strings
  // TODO: strands of juxtaposed numbers should be a single token
  // TODO: floats (?)
  syntax: Array<[RegExp, TokenRule]> = [
    [ /^((?!\n)\s)+/s, ok ], // ignore whitespace
    [ /^[;|\n]/m             , x => this.emit(ImpC.sep(x)) ],
    [ /^-?\d+/               , x => this.emit(ImpC.int(parseInt(x))) ],
    [ /^"(\\.|[^"])*"/       , x => this.emit(ImpC.str(x.slice(1,-1))) ],
    // TODO: markdown style multi-line strings
    // [ /^```.*```/           , x => this.emit(imp.mls(x)) ],
    [ /^(((?![[({])\S)*[[({]|\.:)/      , x => this.node(x) ],
    [ /^(]|:\.|[)}])/        , x => this.done(x) ],
    [ /^((?![\])}])\S)+/     , x => this.emit(ImpC.sym(this.symtbl.sym(x))) ]] // catchall, so keep last.
}

// impStr -> impData
export let read: (impStr: ImpStr) => ImpVal
  = (impStr) => new ImpReader().send(impStr[2]).read() ?? NIL
