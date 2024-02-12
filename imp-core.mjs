// core components for implish interpreter

export function ok() { }  // the empty program

export let T = {  // data types
  NIL: 'NIL',     // null type
  INT: 'INT',     // integer
  STR: 'STR',     // string
  SYM: 'SYM',     // symbol
  JSF: 'JSF',     // js function (primitive)
  IMP: 'IMP',     // implish function
  TOK: 'TOK',     // implish token
};

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
