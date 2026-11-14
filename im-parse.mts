/** Implish parser
 *
 * Turns a token tree from imp-load into a small syntax tree (Node) that
 * the evaluator in imp-eval runs. The rules, in short:
 *
 *  - Code is read left to right, but it runs right to left (as in K).
 *  - A dyad (arity-2 verb) in infix position takes the whole expression
 *    to its right as its right argument:  2 + 3 * 5  is  2 + (3 * 5).
 *  - A prefix verb takes the next term(s) as its argument(s), one term
 *    per argument. A term is a noun, a set-word with its expression, or
 *    a verb that applies to its own terms. So  rev a + 10 * a  is
 *    (rev a) + (10 * a).
 *  - A monad right after a term is postfix and binds to that term:
 *    2 ! is ![2].
 *  - A set-word takes the whole expression to its right:  x: 1 + 2.
 *  - ; and newlines end a statement. Two terms side by side with no verb
 *    between them are two statements (Logo-like sequence sugar).
 *  - A comma ends a clause. The clause on its left runs first, and its
 *    value becomes the first item of the clause on its right:
 *    ! 10, * 2, + 1  is  ((! 10) * 2) + 1.
 *  - [ ] blocks are data, not code. They are read by readData().
 *
 * Arity is looked up in the word dictionary when a statement is parsed,
 * so the evaluator parses and runs one statement at a time.
 *
 * See docs/evaluator.md for the full description.
 */

import * as imp from './imp-core.mjs'
import {
  ImpT,
  ImpVal,
  ImpQ,
  SymT,
  ImpC,
  ImpJsfA,
  ImpIfnA,
  ImpLst,
} from './imp-core.mjs'
import {impShow} from './imp-show.mjs'

// Word dictionary type (maps symbol names to ImpVals)
export type WordDict = Record<string, ImpVal>

// ---------------------------------------------------------------------------
// Syntax tree

/** A hold is the value of the clause to the left of a comma. */
export type Hold = {k: 'hold', src: Node, value?: ImpVal}

export type Node =
  | {k: 'val', v: ImpVal}                     // literal, or source list that eval() handles
  | {k: 'ref', name: string}                  // a word used as a noun
  | {k: 'get', name: string}                  // :foo
  | {k: 'set', name: string, rhs: Node}       // foo: expr
  | {k: 'verb', name?: string, src?: ImpVal, arity: number}  // a verb, not applied
  | {k: 'call', fn: Node, args: Node[]}       // apply fn to args (maybe partial)
  | {k: 'compose', f: Node, g: Node}          // f g with no argument: f after g
  | {k: 'index', target: Node, key: ImpVal}   // dict`key
  | {k: 'thread', left: Node, hold: Hold, body: Node}  // left , body
  | Hold

// Part of speech of an item, found at parse time
type Kind =
  | {pos: 'noun', node: Node}
  | {pos: 'verb', node: Node, arity: number, raw?: boolean}
  | {pos: 'set', name: string}

// An item in a clause: a token from the loader, or a held clause value
type Item = ImpVal | Hold
function isHold(x: Item): x is Hold { return (x as any).k === 'hold' }

// ---------------------------------------------------------------------------
// Helpers

export function getArity(x: ImpVal): number {
  if (x[0] === ImpT.JSF) return (x[1] as ImpJsfA).arity
  if (x[0] === ImpT.IFN) return (x[1] as ImpIfnA).arity
  return 0
}

function isVerbVal(x: ImpVal | undefined): boolean {
  return !!x && (x[0] === ImpT.JSF || x[0] === ImpT.IFN)
}

/** Find the arity of a fold (+/) or scan (+\) word, or null if it is not one. */
function foldArity(name: string, dict: WordDict): number | null {
  if (!(name.endsWith('/') || name.endsWith('\\'))) return null
  const base = dict[name.slice(0, -1)]
  if (base && base[0] === ImpT.JSF && (base[1] as ImpJsfA).arity === 2) return 1
  return null
}

/** Scan a function body for the implicit parameters x, y, z.
 *  Nested { } functions are not scanned. */
export function scanArity(body: ImpVal[]): number {
  let hasZ = false, hasY = false, hasX = false
  function scan(x: ImpVal): void {
    if (ImpQ.isSym(x) && (x[1].kind === SymT.RAW || x[1].kind === SymT.GET)) {
      const name = x[2].description!
      if (name === 'z') hasZ = true
      else if (name === 'y') hasY = true
      else if (name === 'x') hasX = true
    } else if (ImpQ.isLst(x)) {
      if (x[1].open === '{') return
      for (const item of x[2]) scan(item)
    } else if (ImpQ.isTop(x)) {
      for (const item of x[2]) scan(item)
    }
  }
  for (const item of body) scan(item)
  return hasZ ? 3 : hasY ? 2 : hasX ? 1 : 0
}

/** Split a projection's items into argument chunks.
 *  Only ; and newlines split arguments. A comma inside an argument
 *  is the comma operator. Returns [] for empty brackets. */
export function splitArgs(items: ImpVal[]): ImpVal[][] {
  if (items.length === 0) return []
  const args: ImpVal[][] = [[]]
  for (const x of items) {
    if (x[0] === ImpT.SEP && x[2] !== ',') args.push([])
    else args[args.length - 1].push(x)
  }
  return args
}

// ---------------------------------------------------------------------------
// Strands and data blocks

/** Join adjacent number tokens into INTs/NUMs, and adjacent backtick
 *  symbols into SYMs. This is purely lexical: 1 2 3 is one strand. */
export function formStrands(items: ImpVal[]): ImpVal[] {
  const out: ImpVal[] = []
  let i = 0
  while (i < items.length) {
    const item = items[i]
    if (item[0] === ImpT.INT || item[0] === ImpT.NUM) {
      const nums: number[] = [item[2] as number]
      let hasNum = item[0] === ImpT.NUM
      let j = i + 1
      while (j < items.length && (items[j][0] === ImpT.INT || items[j][0] === ImpT.NUM)) {
        if (items[j][0] === ImpT.NUM) hasNum = true
        nums.push(items[j][2] as number)
        j++
      }
      if (nums.length > 1) {
        out.push(hasNum ? ImpC.nums(nums) : ImpC.ints(nums))
        i = j
        continue
      }
    }
    if (ImpQ.isSym(item) && item[1].kind === SymT.BQT) {
      const syms: symbol[] = [item[2] as symbol]
      let j = i + 1
      while (j < items.length) {
        const next = items[j]
        if (!ImpQ.isSym(next) || next[1].kind !== SymT.BQT) break
        syms.push(next[2] as symbol)
        j++
      }
      if (syms.length > 1) {
        out.push(ImpC.syms(syms))
        i = j
        continue
      }
    }
    out.push(item)
    i++
  }
  return out
}

/** Read a [ ] block as data. Nothing is looked up or run.
 *  Strands are formed, ; and , separate items (and are dropped),
 *  and nested [ ] blocks are read the same way. Other nested lists
 *  ( ), { }, '[ ], name[ ] stay as they are. */
export function readData(x: ImpLst): ImpLst {
  const items = formStrands(x[2])
    .filter(item => item[0] !== ImpT.SEP)
    .map(item => (ImpQ.isLst(item) && item[1].open === '[') ? readData(item) : item)
  return imp.lst(x[1], items)
}

// ---------------------------------------------------------------------------
// Statement splitting

/** Split items into statements on ; | and newline (not on comma). */
function splitStatements(items: ImpVal[]): ImpVal[][] {
  const segs: ImpVal[][] = [[]]
  for (const x of items) {
    if (x[0] === ImpT.SEP && x[2] !== ',') segs.push([])
    else segs[segs.length - 1].push(x)
  }
  return segs.filter(s => s.length > 0)
}

/** Split one statement into clauses on commas. */
function splitCommas(items: ImpVal[]): ImpVal[][] {
  const out: ImpVal[][] = [[]]
  for (const x of items) {
    if (x[0] === ImpT.SEP && x[2] === ',') out.push([])
    else out[out.length - 1].push(x)
  }
  return out
}

/** A request from the parser to the caller: run hold.src now and put
 *  the result in hold.value. The parser asks for this when the parse of
 *  the rest of the statement depends on a value (is it a verb or not?).
 *  A caller that does not run code (imparse) ignores the request, and
 *  the parser then guesses from the syntax (staticVerbArity). */
export type Need = {k: 'need', hold: Hold}
export type Step = Node | Need

/** Thrown inside the parser when it needs the value of an item. */
class NeedValue {
  constructor(public item: ImpVal, public node: Node) {}
}

/** Walk code one statement at a time.
 *  The generator yields each finished statement. The caller runs it
 *  (or not) before it asks for the next one, so words that a statement
 *  defines are known when the next statement is parsed.
 *  It also yields Need requests (see Need). After each request, the
 *  dictionary is read again, so the parse uses the new state. */
export function* statements(items: ImpVal[], dict: () => WordDict,
                            groups?: GroupCache): Generator<Step, void, void> {
  // A caller that passes a cache keeps the dictionary fixed and runs
  // nothing (see groupVerbArity). Otherwise the dictionary can change
  // after each step, so the cache is cleared after each step.
  const shared = groups !== undefined
  let cache: GroupCache = groups ?? new Map()
  const fresh = (): GroupCache => shared ? cache : (cache = new Map())
  for (const seg of splitStatements(formStrands(items))) {
    const clauses = splitCommas(seg)
    clauses.forEach((clause, ci) => {
      if (clause.length === 0) {
        throw ci === 0 ? "comma with nothing on its left" : "comma followed by nothing"
      }
    })
    let carry: Hold | null = null
    for (let ci = 0; ci < clauses.length; ci++) {
      const isLast = ci === clauses.length - 1
      const p: Parser = new Parser(clauses[ci], dict(), carry, cache)
      carry = null
      while (!p.done()) {
        const start = p.pos
        let stmt: Node
        try {
          stmt = p.statement()
        } catch (e) {
          if (!(e instanceof NeedValue)) throw e
          // Run the item, then parse the statement again with its value.
          const hold: Hold = {k: 'hold', src: e.node}
          yield {k: 'need', hold}
          p.values.set(e.item, hold)
          p.dict = dict()
          p.groups = fresh()
          p.pos = start
          continue
        }
        if (!isLast && p.done()) {
          // The clause left of a comma runs before the next clause is
          // parsed, so the next clause sees its value and its effects.
          carry = {k: 'hold', src: stmt}
          yield {k: 'need', hold: carry}
          fresh()
          break
        }
        yield stmt
        p.dict = dict()  // pick up words the last statement defined
        p.groups = fresh()
      }
    }
  }
}

// ---------------------------------------------------------------------------
// The parser for one clause

/** Verb arity (or null) of each ( ) group that was classified while one
 *  statement was parsed. The dictionary does not change while a statement
 *  is parsed, so a group is parsed at most once. Without this, the parser
 *  parses nested groups again each time it looks at them, and the cost
 *  grows exponentially with the depth. */
export type GroupCache = Map<ImpVal, number | null>

export class Parser {
  items: Item[]
  pos = 0
  dict: WordDict
  hold: Hold | null = null
  groups: GroupCache
  /** Values of items that the caller ran during the parse (see Need). */
  values = new Map<ImpVal, Hold>()

  constructor(clause: ImpVal[], dict: WordDict, carry: Hold | null = null,
              groups: GroupCache = new Map()) {
    this.dict = dict
    this.groups = groups
    if (carry) {
      this.hold = carry
      this.items = [carry, ...clause]
    } else {
      this.items = clause
    }
  }

  done(): boolean { return this.pos >= this.items.length }

  /** Parse one statement (one expression). */
  statement(): Node {
    const startedWithHold = this.pos === 0 && this.hold !== null
    const node = this.expr()
    if (startedWithHold) return {k: 'thread', left: this.hold!.src, hold: this.hold!, body: node}
    return node
  }

  // -- classification -------------------------------------------------------

  /** Classify an item: is it a verb (and with which arity), a noun, or a
   *  set-word? i is the position of the item in this.items. If run is
   *  true, the parser may ask the caller to run a group or projection to
   *  learn its value (see evaluated). */
  kind(x: Item, i: number, run: boolean): Kind {
    if (isHold(x)) return holdKind(x, this.dict)
    if (ImpQ.isSym(x)) {
      const name = x[2].description!
      switch (x[1].kind) {
        case SymT.RAW: {
          const w = this.dict[name]
          if (isVerbVal(w)) {
            return {pos: 'verb', node: {k: 'verb', name, arity: getArity(w)},
                    arity: getArity(w), raw: !!(w[1] as ImpJsfA).rawArg}
          }
          if (w === undefined) {
            const fa = foldArity(name, this.dict)
            if (fa !== null) return {pos: 'verb', node: {k: 'verb', name, arity: fa}, arity: fa}
          }
          return {pos: 'noun', node: {k: 'ref', name}}
        }
        case SymT.SET: return {pos: 'set', name}
        case SymT.GET: return {pos: 'noun', node: {k: 'get', name}}
        default: return {pos: 'noun', node: {k: 'val', v: x}}
      }
    }
    if (ImpQ.isLst(x)) {
      const open = x[1].open
      if (open === '{') {
        const a = scanArity(x[2])
        if (a > 0) return {pos: 'verb', node: {k: 'verb', src: x, arity: a}, arity: a}
        return {pos: 'noun', node: {k: 'val', v: x}}
      }
      if (open === '(') {
        // A group whose value is a verb is a verb:  (rev !) 5
        const e = this.evaluated(x, i, run)
        if (e) return e
        // Not run (see needsValue): guess from the code in the group.
        let a = this.groups.get(x)
        if (a === undefined) {
          a = groupVerbArity(x[2], this.dict, this.groups)
          this.groups.set(x, a)
        }
        if (a !== null) return {pos: 'verb', node: {k: 'verb', src: x, arity: a}, arity: a}
        return {pos: 'noun', node: {k: 'val', v: x}}
      }
      const m = open.match(/^(.+)\[$/)
      if (m && !open.startsWith("'") && !open.startsWith('`') && open !== ':[') {
        // projection: name[args]. If the word is a verb and some
        // arguments are still missing, the projection is a verb.
        const w = this.dict[m[1]]
        if (isVerbVal(w)) {
          const a = getArity(w)
          const n = splitArgs(x[2]).length
          if (a > n) return {pos: 'verb', node: {k: 'verb', src: x, arity: a - n}, arity: a - n}
        }
        // A full projection can give a verb too:  get[`f] 5
        const e = this.evaluated(x, i, run)
        if (e) return e
      }
      return {pos: 'noun', node: {k: 'val', v: x}}
    }
    return {pos: 'noun', node: {k: 'val', v: x as ImpVal}}
  }

  /** Classify the next item. Pass run = true only where the parser takes
   *  the item as a term: at the start of a statement, after a dyad or
   *  set-word, or as an argument of a prefix verb. Where it only looks
   *  ahead (is a dyad or a postfix monad next?), the item can be the start
   *  of the next statement, and that must not run before this statement
   *  has run. So these look-aheads pass run = false. */
  peekKind(run: boolean): Kind | null {
    return this.done() ? null : this.kind(this.items[this.pos], this.pos, run)
  }

  /** For a ( ) group or a full projection: if the caller ran it, classify
   *  it by its value. If its value decides the parse and run is true, ask
   *  the caller to run it (throw NeedValue). Else return null, and the
   *  caller guesses from the syntax. */
  evaluated(x: ImpVal, i: number, run: boolean): Kind | null {
    const h = this.values.get(x)
    if (h) return h.value === undefined ? null : holdKind(h, this.dict)
    if (run && this.needsValue(i)) throw new NeedValue(x, {k: 'val', v: x})
    return null
  }

  /** Does the parse depend on whether item i is a verb? It does when a
   *  term follows it: then item i is applied to that term (a verb) or the
   *  two are separate statements (a noun). Running item i early does not
   *  change the run order there: a function runs before its arguments,
   *  and separate statements run left to right. When a dyad or nothing
   *  follows, item i is run at the normal time. */
  needsValue(i: number): boolean {
    const nx = this.items[i + 1]
    return nx !== undefined && !this.isDyadItem(nx)
  }

  /** Is x (by syntax and the dictionary) an infix dyad? */
  isDyadItem(x: Item): boolean {
    if (isHold(x)) return false
    if (ImpQ.isSym(x) && x[1].kind === SymT.RAW) {
      const w = this.dict[x[2].description!]
      return isVerbVal(w) && getArity(w) === 2
    }
    if (ImpQ.isLst(x)) {
      const open = x[1].open
      if (open === '{') return scanArity(x[2]) === 2
      const m = open.match(/^(.+)\[$/)
      if (m && !open.startsWith("'") && !open.startsWith('`') && open !== ':[') {
        const w = this.dict[m[1]]
        return isVerbVal(w) && getArity(w) - splitArgs(x[2]).length === 2
      }
    }
    return false
  }

  /** Can the next item start an argument term? A dyad can start one
   *  only in the first argument slot (before any argument). */
  startsTerm(firstSlot: boolean): boolean {
    const k = this.peekKind(true)   // an argument of a prefix verb
    if (!k) return false
    if (k.pos !== 'verb') return true
    return k.arity !== 2 || firstSlot
  }

  // -- grammar --------------------------------------------------------------

  /** expr := term [dyad expr] */
  expr(): Node {
    let left = this.term()
    const k = this.peekKind(false)   // look-ahead: is a dyad next?
    if (k && k.pos === 'verb' && k.arity === 2) {
      this.pos++
      if (this.done()) return {k: 'call', fn: k.node, args: [left]}   // 2 +  is +[2]
      const right = this.expr()
      return {k: 'call', fn: k.node, args: [left, right]}
    }
    return left
  }

  /** term := set-word expr | verb term* | noun postfix* */
  term(): Node {
    const k = this.peekKind(true)
    if (!k) throw "unexpected end of input (missing argument?)"
    this.pos++

    if (k.pos === 'set') {
      if (this.done()) throw `SET symbol ${k.name} has no right-hand side`
      // A function literal right after a set-word is a value: f: {x + 1}
      const next = this.items[this.pos]
      if (!isHold(next) && ImpQ.isLst(next) && next[1].open === '{') {
        this.pos++
        let rhs: Node = {k: 'val', v: next}
        const after = this.peekKind(false)
        if (after && after.pos === 'verb' && after.arity === 2) {
          this.pos++
          rhs = this.done() ? {k: 'call', fn: after.node, args: [rhs]}
                            : {k: 'call', fn: after.node, args: [rhs, this.expr()]}
        }
        return {k: 'set', name: k.name, rhs}
      }
      return {k: 'set', name: k.name, rhs: this.expr()}
    }

    if (k.pos === 'verb') {
      // A raw verb (like ?) takes the next token as it is.
      if (k.raw) {
        const args: Node[] = []
        if (!this.done() && !isHold(this.items[this.pos])) {
          args.push({k: 'val', v: this.items[this.pos++] as ImpVal})
        }
        return {k: 'call', fn: k.node, args}
      }
      const args: Node[] = []
      const want = k.arity
      while ((want === -1 || args.length < want) && this.startsTerm(args.length === 0)) {
        args.push(this.term())
      }
      if (args.length === 0 && want !== 0) return k.node   // a verb as a value
      // f g with no argument for g: composition
      if (want === 1 && args.length === 1 && isBareVerb(args[0])) {
        return {k: 'compose', f: k.node, g: args[0]}
      }
      return {k: 'call', fn: k.node, args}
    }

    // noun
    let node = k.node
    // dict`key indexing (only when the word holds a dictionary now)
    if (node.k === 'ref' && this.dict[node.name]?.[0] === ImpT.DCT) {
      while (!this.done()) {
        const nx = this.items[this.pos]
        if (isHold(nx)) break
        const isKey = (ImpQ.isSym(nx) && nx[1].kind === SymT.BQT) || nx[0] === ImpT.SYMs
        if (!isKey) break
        this.pos++
        node = {k: 'index', target: node, key: nx as ImpVal}
      }
    }
    // postfix monads:  2 !  is  ![2]
    while (true) {
      const p = this.peekKind(false)   // look-ahead: a postfix monad?
      if (!p || p.pos !== 'verb' || p.arity !== 1 || p.raw) break
      this.pos++
      const args: Node[] = [node]
      // Extra nouns after a postfix monad are extra arguments. The
      // evaluator reports them as a valence error:  2 ! 10
      while (true) {
        const q = this.peekKind(false)
        if (!q || q.pos !== 'noun') break
        this.pos++
        args.push(q.node)
      }
      node = {k: 'call', fn: p.node, args}
    }
    return node
  }
}

/** Parse the code of a ( ) group without running it, and return the
 *  arity of its last statement if that statement gives a verb. */
function groupVerbArity(items: ImpVal[], dict: WordDict, groups: GroupCache): number | null {
  try {
    let last: Node | null = null
    for (const stmt of statements(items, () => dict, groups)) {
      if (stmt.k !== 'need') last = stmt
    }
    return last ? staticVerbArity(last, dict) : null
  } catch {
    return null
  }
}

/** Verb arity of a value, or null if it is not a function. */
function valueArity(v: ImpVal): number | null {
  return isVerbVal(v) ? getArity(v) : null
}

/** Classify a hold by its value if the caller ran it, else by syntax. */
function holdKind(h: Hold, dict: WordDict): Kind {
  const a = h.value !== undefined ? valueArity(h.value) : staticVerbArity(h.src, dict)
  return a === null ? {pos: 'noun', node: h} : {pos: 'verb', node: h, arity: a}
}

function isBareVerb(n: Node): boolean {
  return n.k === 'verb' || n.k === 'compose'
}

/** If a node gives a verb, return its arity, else null.
 *  Used to classify the value that a comma carries and the last
 *  statement of a ( ) group. Words are looked up in dict (the
 *  dictionary at parse time), because a word can hold a verb. */
export function staticVerbArity(n: Node, dict: WordDict): number | null {
  const sva = (m: Node) => staticVerbArity(m, dict)
  switch (n.k) {
    case 'verb': return n.arity
    // A word gives the value it holds:  (:f) 5  and  :f, 5  are  f 5.
    // (A get-word alone is still a noun: :f does not call f.)
    case 'get':
    case 'ref': {
      const w = dict[n.name]
      return isVerbVal(w) ? getArity(w) : null
    }
    // A set-word gives the value it stores:  f: {x + 1}, 5  is  f 5
    case 'set': return sva(n.rhs)
    // A function literal (stored by a set-word) is a verb if it uses x, y or z
    case 'val': {
      const v = n.v
      if (ImpQ.isLst(v) && v[1].open === '{') {
        const a = scanArity(v[2])
        return a > 0 ? a : null
      }
      return null
    }
    case 'compose': return sva(n.g)
    case 'hold': return n.value !== undefined ? valueArity(n.value) : sva(n.src)
    case 'thread': return sva(n.body)
    case 'call': {
      const fa = sva(n.fn)
      if (fa === null || fa === -1) return null
      if (n.args.length > 0 && n.args.length < fa) return fa - n.args.length
      return null
    }
    default: return null
  }
}

// ---------------------------------------------------------------------------
// Showing the syntax tree as M-expressions (for the imparse word)

const SEMI = () => ImpC.sep(';')

function joinArgs(args: ImpVal[]): ImpVal[] {
  const out: ImpVal[] = []
  args.forEach((a, i) => { if (i > 0) out.push(SEMI()); out.push(a) })
  return out
}

/** Collect the function and all arguments of a call, merging partial
 *  calls:  (+ 1, 2)  shows as  +[1 ; 2]. */
function flattenCall(n: Node): {fn: Node, args: Node[]} {
  if (n.k === 'hold') return flattenCall(n.src)
  if (n.k === 'call') {
    const inner = n.fn.k === 'call' || n.fn.k === 'hold' ? flattenCall(n.fn) : {fn: n.fn, args: []}
    return {fn: inner.fn, args: [...inner.args, ...n.args]}
  }
  return {fn: n, args: []}
}

function fnName(fn: Node): string {
  if (fn.k === 'verb') {
    if (fn.name) return fn.name
    if (fn.src) {
      const m = ImpQ.isLst(fn.src) && fn.src[1].open.match(/^(.+)\[$/)
      if (m) return m[1]
    }
  }
  return ''
}

export function toMExpr(n: Node): ImpVal {
  switch (n.k) {
    case 'val': return n.v
    case 'ref': return ImpC.sym(Symbol(n.name), SymT.RAW)
    case 'get': return imp.lst({open: 'get[', close: ']'}, [ImpC.sym(Symbol(n.name), SymT.BQT)])
    case 'set':
      return imp.lst({open: 'set[', close: ']'},
        [ImpC.sym(Symbol(n.name), SymT.BQT), SEMI(), toMExpr(n.rhs)])
    case 'verb': return n.name ? ImpC.sym(Symbol(n.name), SymT.RAW) : n.src!
    case 'hold': return toMExpr(n.src)
    case 'thread': return toMExpr(n.body)
    case 'compose': return imp.lst({open: '(', close: ')'}, [toMExpr(n.f), toMExpr(n.g)])
    case 'index': {
      const t = toMExpr(n.target)
      const name = ImpQ.isSym(t) ? t[2].description! : ''
      return imp.lst({open: name + '[', close: ']'}, [n.key])
    }
    case 'call': {
      const {fn, args} = flattenCall(n)
      let name = fnName(fn)
      let pre: Node[] = []
      if (fn.k === 'verb' && !fn.name && fn.src && name) {
        // projection with more arguments:  add[3] 5  shows as  add[3 ; 5]
        pre = splitArgs((fn.src as ImpLst)[2]).map(chunk =>
          ({k: 'val', v: chunk.length === 1 ? chunk[0] : ImpC.top(chunk)} as Node))
      }
      if (!name) name = toShowName(fn)
      return imp.lst({open: name + '[', close: ']'}, joinArgs([...pre, ...args].map(toMExpr)))
    }
  }
}

// Fallback name for an anonymous verb, such as a function literal.
function toShowName(fn: Node): string {
  return impShow(toMExpr(fn))
}

// ---------------------------------------------------------------------------
// Public entry point

/** Parse a token tree and return it as M-expressions.
 *  This is what the imparse word shows. It does not run anything,
 *  so words that the code itself defines are not known yet. */
export function imparse(tree: ImpVal, dict?: WordDict): ImpVal {
  if (tree[0] !== ImpT.TOP && tree[0] !== ImpT.LST) return tree
  const d = dict ?? {}
  const out: ImpVal[] = []
  for (const stmt of statements(tree[2] as ImpVal[], () => d)) {
    if (stmt.k === 'need') continue   // imparse runs nothing
    if (out.length) out.push(SEMI())
    out.push(toMExpr(stmt))
  }
  return ImpC.top(out)
}
