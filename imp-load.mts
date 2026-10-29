/** Implish loader ("code-as-data" parser)
 * Converts strings to implish token-trees.
 */
import {type ImpVal, ImpT, ok, SymTable, TreeBuilder, NIL, ImpStr, ImpC, ImpErr, ImpTop, SymT, NULL_INT} from './imp-core.mjs'
import * as imp from './imp-core.mjs'

let closer: Record<string, string> = { '[': ']', '(': ')', '{': '}', '.:' : ':.' }
type TokenRule = (token:string) => void

// Token types for the lexer
export const TokT = {
  WS: 'ws', SEP: 'sep', NUM: 'num', INT: 'int', STR: 'str',
  NODE: 'node', DONE: 'done',
  URL: 'url', KW: 'kw', KW2: 'kw2', SET: 'set',
  MSG2: 'msg2', TYP: 'typ', ISH: 'ish', FILE: 'file',
  PATH: 'path', REFN: 'refn', LIT: 'lit', GET: 'get',
  BQT: 'bqt', ANN: 'ann', MSG: 'msg', ERR: 'err', UNQ: 'unq', RAW: 'raw'
} as const

export type TrimSpec = [number, number] | null

// Lexer table: [tokenType, regex, trimSpec]
// trimSpec is [charsFromStart, charsFromEnd] to strip when creating symbol
export const lexerTable: Array<[string, RegExp, TrimSpec]> = [
  [TokT.WS,   /^((?!\n)\s)+/s,                        null],
  [TokT.NUM,  /^-?\d+\.\d+([eE][+-]?\d+)?/,          null], // decimal with optional scientific notation
  [TokT.NUM,  /^-?\d+[eE][+-]?\d+/,                  null], // integer with scientific notation
  [TokT.INT,  /^0N\b/,                                null], // null integer (must come before general INT)
  [TokT.INT,  /^-?\d+/,                               null],
  [TokT.STR,  /^"(\\.|[^"])*"/,                       [1, 1]],
  [TokT.NODE, /^(((?![[({])\S)*[[({]|\.:)/,          null],
  [TokT.DONE, /^(]|:\.|[)}])/,                       null],
  // Symbol types (order matters - more specific before less specific)
  [TokT.UNQ,  /^,[^\s\[\](){}:;!,]+/,                [1, 0]], // unquote: ,foo (must come before SEP)
  [TokT.SEP,  /^[;,|\n]/m,                            null],   // separator (comma with whitespace after)
  [TokT.URL,  /^https?:\/\/[^\s\[\](){}]+/,          [0, 0]], // url: http://foo (no trim, keep full URL)
  [TokT.KW,   /^\.[^\s\[\](){}:;!]+:/,               [1, 1]], // keyword: .foo: (strip . and :)
  [TokT.KW2,  /^![^\s\[\](){}:;!]+:/,                [1, 1]], // keyword2: !foo: (strip ! and :)
  [TokT.SET,  /^[^\s\[\](){}:;!]+:/,                 [0, 1]], // set-word: foo: (strip :)
  [TokT.MSG2, /^![^\s\[\](){}:;!]+/,                 [1, 0]], // message2: !foo (strip !)
  [TokT.TYP,  /^[^\s\[\](){}:;!]+!/,                 [0, 1]], // type: foo! (strip !)
  [TokT.ISH,  /^#[^\s\[\](){}:;!]+/,                 [1, 0]], // issue: #foo (strip #)
  [TokT.FILE, /^%[^\s\[\](){}:;!]+/,                 [1, 0]], // file: %foo/bar (strip %)
  [TokT.PATH, /^[^\s\[\](){}:;!%@#'.`]+\/[^\s\[\](){}:;!]+/, [0, 0]], // path: foo/bar/baz (no trim)
  [TokT.REFN, /^\/[^\s\[\](){}:;!]+/,                [1, 0]], // refinement: /foo (strip /)
  [TokT.LIT,  /^'[^\s\[\](){}:;!]+/,                 [1, 0]], // lit-word: 'foo (strip ')
  [TokT.GET,  /^:[^\s\[\](){}:;!]+/,                 [1, 0]], // get-word: :foo (strip :)
  [TokT.BQT,  /^`(?=[\s\[\](){}:;,]|$)/,             [1, 0]], // bare backtick: ` (null symbol, strip `)
  [TokT.BQT,  /^`[^\s\[\](){}:;!`]+/,                [1, 0]], // backtick: `foo (strip `, stops at next `)
  [TokT.ANN,  /^@[^\s\[\](){}:;!]+/,                 [1, 0]], // annotation: @foo (strip @)
  [TokT.MSG,  /^\.[^\s\[\](){}:;!]+/,                [1, 0]], // message: .foo (strip .)
  [TokT.ERR,  /^\?[^\s\[\](){}:;!]+/,                [1, 0]], // error: ?foo (strip ?)
  [TokT.RAW,  /^[^\s\[\](){}`;]+/,                    [0, 0]], // catchall (keep last, exclude backtick)
]

export class ImpLoader {
  tree: TreeBuilder<any> = new TreeBuilder()
  symtbl = new SymTable() // global table for symbols
  buffer: string[] = []           // input buffer (list of strings)
  expect: Array<{open: string, close: string}> = []           // expected closing tokens
  // text of an open ``` multi-line string; skipNl: the opening ``` ended its
  // chunk, so the newline after it (implied by the next send) isn't content
  mls: {text: string, skipNl: boolean} | null = null

  get empty() { return this.buffer.length===0 }
  get waiting() { return this.expect.length>0 || this.mls !== null }
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

  // ``` starts and ends a multi-line string, as in markdown. The newline
  // right after the opening ``` is not part of the string.
  mlsOpen(src: string): void {
    let rest = src.slice(3)
    this.mls = {text: '', skipNl: rest === ''}
    this.mlsText(rest.startsWith('\n') ? rest.slice(1) : rest)
  }
  mlsText(src: string): void {
    let end = src.indexOf('```')
    if (end < 0) { this.mls!.text += src; return }
    this.emit(ImpC.mls(this.mls!.text + src.slice(0, end)))
    this.mls = null
    let rest = src.slice(end + 3)
    if (rest) this.buffer.unshift(rest)
  }

  dump(): void { console.log(this.tree.root) }
  send(s: string): ImpLoader {
    // Inside an open ``` string, each later send is a new line of it.
    if (this.mls) {
      s = (this.mls.skipNl ? '' : '\n') + s
      this.mls.skipNl = false
      this.mlsText(s)
    }
    else this.buffer.push(s);
    while (!this.empty) this.scan();
    return this }

  read(): ImpTop | ImpErr {
    if (this.ready) {
      let res = this.tree.root;
      this.clear();
      return ImpC.top(res)}
    else {
      // Provide detailed error about why reading failed
      if (!this.empty) {
        return ImpC.err(`failed to read: ${this.buffer.length} unprocessed tokens remaining`)
      } else if (this.mls) {
        return ImpC.err("failed to read: unclosed multi-line string: ```")
      } else if (this.waiting) {
        let unclosed = this.expect.map(e => e.open).join(', ')
        return ImpC.err(`failed to read: unclosed delimiters: ${unclosed}`)
      } else {
        return ImpC.err("failed to read: unknown error")
      }
    }}

  // Helper: create a symbol with trimming
  mkSym(tok: string, trim: TrimSpec, kind: SymT): void {
    if (!trim) {
      this.emit(ImpC.sym(this.symtbl.sym(tok), kind))
    } else {
      let [start, end] = trim
      let value = end > 0 ? tok.slice(start, -end) : tok.slice(start)
      this.emit(ImpC.sym(this.symtbl.sym(value), kind))
    }
  }

  // Rule dictionary: maps token types to handler functions
  rules: Record<string, (tok: string, trim: TrimSpec) => void> = {
    [TokT.WS]:   () => {},  // ignore whitespace
    [TokT.SEP]:  (tok) => this.emit(ImpC.sep(tok)),
    [TokT.NUM]:  (tok) => this.emit(ImpC.num(parseFloat(tok))),
    [TokT.INT]:  (tok) => this.emit(ImpC.int(tok === '0N' ? NULL_INT : parseInt(tok))),
    [TokT.STR]:  (tok, trim) => this.emit(ImpC.str(trim ? tok.slice(trim[0], -trim[1]) : tok)),
    [TokT.NODE]: (tok) => this.node(tok),
    [TokT.DONE]: (tok) => this.done(tok),
    // Symbol types
    [TokT.URL]:  (tok, trim) => this.mkSym(tok, trim, SymT.URL),
    [TokT.KW]:   (tok, trim) => this.mkSym(tok, trim, SymT.KW),
    [TokT.KW2]:  (tok, trim) => this.mkSym(tok, trim, SymT.KW2),
    [TokT.SET]:  (tok, trim) => this.mkSym(tok, trim, SymT.SET),
    [TokT.MSG2]: (tok, trim) => this.mkSym(tok, trim, SymT.MSG2),
    [TokT.TYP]:  (tok, trim) => this.mkSym(tok, trim, SymT.TYP),
    [TokT.ISH]:  (tok, trim) => this.mkSym(tok, trim, SymT.ISH),
    [TokT.FILE]: (tok, trim) => this.mkSym(tok, trim, SymT.FILE),
    [TokT.PATH]: (tok, trim) => this.mkSym(tok, trim, SymT.PATH),
    [TokT.REFN]: (tok, trim) => this.mkSym(tok, trim, SymT.REFN),
    [TokT.LIT]:  (tok, trim) => this.mkSym(tok, trim, SymT.LIT),
    [TokT.GET]:  (tok, trim) => this.mkSym(tok, trim, SymT.GET),
    [TokT.BQT]:  (tok, trim) => this.mkSym(tok, trim, SymT.BQT),
    [TokT.ANN]:  (tok, trim) => this.mkSym(tok, trim, SymT.ANN),
    [TokT.MSG]:  (tok, trim) => this.mkSym(tok, trim, SymT.MSG),
    [TokT.ERR]:  (tok, trim) => this.mkSym(tok, trim, SymT.ERR),
    [TokT.UNQ]:  (tok, trim) => this.mkSym(tok, trim, SymT.UNQ),
    [TokT.RAW]:  (tok, trim) => this.mkSym(tok, trim, SymT.RAW),
  }

  scan(): void { // match and process the next token
    if (!this.empty) {
      let src = this.buffer.shift()
      if (src?.startsWith('```')) {
        // inside a .: comment, ``` is just comment text
        if (this.expect.at(-1)?.open === '.:') this.buffer.unshift(src.slice(3))
        else this.mlsOpen(src)
        return }
      if (src) {
        let m: RegExpExecArray | null = null
        let tokType: string | null = null
        let trim: TrimSpec = null

        // Find matching token in lexer table
        for (let [tt, rx, tr] of lexerTable) {
          if ((m = rx.exec(src))) {
            tokType = tt
            trim = tr
            break
          }
        }

        // Process the matched token
        if (m && tokType) {
          let tok = m[0], rest = src.slice(tok.length)
          let rule = this.rules[tokType]
          if (rule) rule(tok, trim)
          if (rest) this.buffer.unshift(rest)
        } else {
          console.error("unmatched input:", src)
        }
      }
    }
  }

  // TODO: nested .: :. should treat everything inside as a single comment
  // TODO: handle unterminated strings
  // TODO: strands of juxtaposed numbers should be a single token
  // TODO: floats (?)
}

// impStr -> impData (parse string into tree)
// A read failure is thrown, not returned: an error value has no syntax
// of its own, so it couldn't be shown or loaded back as data.
export let load: (impStr: ImpStr) => ImpVal
  = (impStr) => {
    let res = new ImpLoader().send(impStr[2]).read() ?? NIL
    if (res[0] === ImpT.ERR) throw res[2]
    return res }
