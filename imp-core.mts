// core components for implish interpreter

export function ok() { }  // the empty program

export enum ImpT {
  TOP = 'TOP',     // top-level sequence (list with no delimiters)
  ERR = 'ERR',     // an error value
  SEP = 'SEP',     // separator
  END = 'END',     // virtual 'end of input' token
  // --- values with literal representation
  INT = 'INT',     // integer
  NUM = 'NUM',     // number (float/decimal/scientific notation)
  STR = 'STR',     // string
  MLS = 'MLS',     // multi-line string
  SYM = 'SYM',     // symbol
  LST = 'LST',     // list
  // ---- internal / refined types (require eval() to produce)
  NIL = 'NIL',     // empty/unit value
  JSF = 'JSF',     // javascript function
  JDY = 'JDY',     // javascript dyad (infix operator)
}

export type ImpLstA = { open:string, close:string }
export type ImpJsfA = {arity:number}

// Individual types for each ImpVal variant
export type ImpTop = [ImpT.TOP, null, ImpVal[]]
export type ImpErr = [ImpT.ERR, null, string]
export type ImpSep = [ImpT.SEP, null, string]
export type ImpEnd = [ImpT.END, null, null]
export type ImpInt = [ImpT.INT, null, number]
export type ImpNum = [ImpT.NUM, null, number]
export type ImpStr = [ImpT.STR, null, string]
export type ImpMls = [ImpT.MLS, null, string]
export type ImpSym = [ImpT.SYM, null, symbol]
export type ImpLst = [ImpT.LST, ImpLstA, ImpVal[]]
export type ImpNil = [ImpT.NIL, null, null]
export type ImpJsf = [ImpT.JSF, ImpJsfA, JSF]
export type ImpJdy = [ImpT.JDY, {}, JDY]

// Main discriminated union type (equivalent to union of individual types above)
export type ImpVal
  = ImpTop | ImpErr | ImpSep | ImpEnd
  | ImpInt | ImpNum | ImpStr | ImpMls | ImpSym | ImpLst | ImpNil
  | ImpJsf | ImpJdy

// Syntactic sugar: utility object with methods on ImpVal
export const ImpQ = {
  isTop(x: ImpVal): x is ImpTop { return x[0] === ImpT.TOP },
  isSym(x: ImpVal): x is ImpSym { return x[0] === ImpT.SYM },
  isLst(x: ImpVal): x is ImpLst { return x[0] === ImpT.LST },
};

/** Constructor to lift js types up into Implish **/
export const ImpC = {
  any(x:any):ImpVal {
    if (typeof x === 'string') return ImpC.str(x)
    if (typeof x === 'number') return ImpC.int(Math.floor(x))
    throw new Error(`nyi ImpC.any(${x})`)},
  top(x:ImpVal[]):ImpTop { return [ImpT.TOP, null, x]},
  err(x:string):ImpErr { return [ImpT.ERR, null, x]},
  int(x:number):ImpInt { return [ImpT.INT, null, x]},
  num(x:number):ImpNum { return [ImpT.NUM, null, x]},
  str(x:string):ImpStr { return [ImpT.STR, null, x]},
  sym(x:symbol):ImpSym { return [ImpT.SYM, null, x]},
  sep(x:string):ImpSep { return [ImpT.SEP, null, x]},
  mls(x:string):ImpMls { return [ImpT.MLS, null, x]},
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

export const NIL:ImpVal = [ImpT.NIL, null, null];  // the empty value
export const END:ImpVal = [ImpT.END, null, null];  // the virtual end token

export class SymTable {
  symTab: Record<string, symbol> = {}
  sym(s:string): symbol {
    if (!(s in this.symTab)) this.symTab[s] = Symbol(s)
    return this.symTab[s]! }}

export type Node<T> = T | Node<T>[]
export class TreeBuilder<T> {
  root: Node<T>[] = []
  here: Node<T>[] = this.root
  stack: Node<T>[][] = []
  emit(x:T) { this.here.push(x) }
  node() { this.stack.push(this.here); this.here = [] }
  done() { let prev = this.stack.pop(); if (prev) { prev.push(this.here); this.here = prev } else { throw new Error("done called without node") } }}

export function lst(atr?:ImpLstA, items?:any[]): ImpLst {
  if (atr===undefined) atr = {open:'<<', close:'>>'}
  if (items===undefined) items = []
  return [ImpT.LST, atr, items] }
export function push(xs: ImpLst, x: ImpVal): ImpVal {
  xs[2].push(x)
  return xs }

export type JSF = (...args: ImpVal[]) => ImpVal
export type JDY = (left: ImpVal, right: ImpVal) => ImpVal
export let jsf: (f: JSF, a: number) => ImpJsf =
  (f, a) => [ImpT.JSF, {arity: a}, f]
export let jdy: (f: JDY) => ImpVal =
  (f) => [ImpT.JDY, {}, f]
