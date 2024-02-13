// core components for implish interpreter

export function ok() { }  // the empty program

export let T = {  // token types
  INT: 'INT',     // integer
  STR: 'STR',     // string
  MLS: 'MLS',     // multi-line string
  SYM: 'SYM',     // symbol
  LST: 'LST',     // list
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
