// core components for implish interpreter

export function ok() { }  // the empty program

export let T = {  // types
  SEP: 'SEP',     // separator
  // --- values with literal representation
  TOP: 'TOP',     // top-level sequence (list with no delimiters)
  INT: 'INT',     // integer
  STR: 'STR',     // string
  MLS: 'MLS',     // multi-line string
  SYM: 'SYM',     // symbol
  LST: 'LST',     // list
  // ---- internal / refined types (require eval() to produce)
  NIL: 'NIL',     // empty/unit value
  JSF: 'JSF',     // javascript function
  JDY: 'JDY',     // javascript dyad (infix operator)
};

export let P = {  // parts of speech
  V: 'V',     // verb
  N: 'N',     // noun (data)
  A: 'A',     // adverb
  C: 'C',     // conjunction (infix between verbs)
  G: 'G',     // getter / gerund (like a :get-word in red)
  P: 'P',     // preposition (takes noun argument)
  Q: 'Q',     // quote - `symbol
  S: 'S',     // setter / like :set-word in red
  M: 'M',     // method / adjective (symbol starting with ".")
  O: 'O',     // operator (infix between nouns)
}

export let nil = [T.NIL, {}, null];  // the empty value

export class SymTable {
  constructor() { this.symtab = {} }
  sym(s) {
    if (!this.symtab.hasOwnProperty(s)) this.symtab[s] = Symbol(s)
    return this.symtab[s] }}

export class TreeBuilder {
  constructor() { this.here = this.root = []; this.stack = [] }
  emit(x) { this.here.push(x) }
  node() { this.stack.push(this.here); this.here = [] }
  done() { let prev = this.stack.pop(); prev.push(this.here); this.here = prev }}
