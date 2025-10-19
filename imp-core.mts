// core components for implish interpreter

export function ok() { }  // the empty program

export enum ImpT {
  SEP = 'SEP',     // separator
  TOP = 'TOP',     // top-level sequence (list with no delimiters)
  END = 'END',     // virtual 'end of input' token
  // --- values with literal representation
  INT = 'INT',     // integer
  STR = 'STR',     // string
  MLS = 'MLS',     // multi-line string
  SYM = 'SYM',     // symbol
  LST = 'LST',     // list
  // ---- internal / refined types (require eval() to produce)
  NIL = 'NIL',     // empty/unit value
  JSF = 'JSF',     // javascript function
  JDY = 'JDY',     // javascript dyad (infix operator)
}

export enum ImpP {  // parts of speech
  V = 'V',     // verb
  N = 'N',     // noun (data)
  A = 'A',     // adverb
  C = 'C',     // conjunction (infix between verbs)
  G = 'G',     // getter / gerund (like a :get-word in red)
  P = 'P',     // preposition (takes noun argument)
  Q = 'Q',     // quote - `symbol
  S = 'S',     // setter / like :set-word in red
  M = 'M',     // method / adjective (symbol starting with ".")
  O = 'O',     // operator (infix between nouns)
  E = 'E',     // end of input
}

export const nil:ImpVal<null> = [ImpT.NIL, {}, null];  // the empty value
export const end:ImpVal<null> = [ImpT.END, {}, null];  // the virtual end token

export class SymTable {
  symTab = {}
  sym(s:string) {
    if (!this.symTab.hasOwnProperty(s)) this.symTab[s] = Symbol(s)
    return this.symTab[s] }}

export type Node<T> = T | Node<T>[]
export class TreeBuilder<T> {
  root: Node<T>[] = []
  here: Node<T>[] = this.root
  stack: Node<T>[][] = []
  emit(x:T) { this.here.push(x) }
  node() { this.stack.push(this.here); this.here = [] }
  done() { let prev = this.stack.pop(); prev.push(this.here); this.here = prev }}

export type ImpAttrs = Record<string,any>
export type ImpVal<T> = [ImpT, ImpAttrs, T]
export function lst(atr?:ImpAttrs, items?:any[]): ImpVal<any> {
  if (atr===undefined) atr = {open:'<<', close:'>>'}
  if (items===undefined) items = []
  return [ImpT.LST, atr, items] }
export function push<T>(xs:ImpVal<T[]>, x:T) { xs[2].push(x); return xs }

export function int(x:number):ImpVal<number> { return [ImpT.INT, {}, x] }
export function str(x:string):ImpVal<string> { return [ImpT.STR, {}, x] }
export function sym(x:string):ImpVal<string> { return [ImpT.SYM, {}, x] }
export function sep(x:string):ImpVal<string> { return [ImpT.SEP, {}, x] }
export function mls(x:string):ImpVal<string> { return [ImpT.MLS, {}, x] }
export type JSF = (...args: any[]) => any
export type JDY = (left: any, right: any) => any
export let jsf: (f: JSF, a: number) => ImpVal<JSF> = (f, a) => [ImpT.JSF, {arity: a}, f]
export let jdy: (f: JDY) => ImpVal<JDY> = (f) => [ImpT.JDY, {}, f]
