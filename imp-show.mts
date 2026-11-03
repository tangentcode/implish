import { ImpT, ImpVal, SymT, ImpQ, NULL_INT } from './imp-core.mjs'

function q(x:string):string {
  if (x.match(/^[a-zA-Z0-9_]*$/)) return x
  else return JSON.stringify(x)}

export class ImpWriter {

  // > 0 while showing source tokens (a function body, a loaded program or
  // the contents of a quoted list), where items are written as they are.
  private codeDepth = 0

  private asCode(f: () => string): string {
    this.codeDepth++
    try { return f() } finally { this.codeDepth-- }
  }

  // Does this list item stand for code rather than a value? Evaluating it
  // would look it up, assign, act on a message, or run it as a group.
  private isCode(x: ImpVal): boolean {
    switch (x[0]) {
      case ImpT.SEP: return true
      case ImpT.LST: return this.isCodeList(x[1].open || '')
      case ImpT.SYM:
        switch (x[1].kind) {
          case SymT.RAW: case SymT.SET: case SymT.GET: case SymT.PATH:
          case SymT.MSG: case SymT.KW: case SymT.MSG2: case SymT.KW2:
          case SymT.UNQ:
            return true
          default: return false
        }
      default: return false
    }
  }

  // Any opener but a plain '[' makes a list of code when evaluated as a
  // value: ( { :[ name[ and quoted openers all mean something else unquoted.
  private isCodeList(open: string): boolean {
    return open !== '' && open !== '['
  }

  // A list value read from code (a quoted list, or one taken out of one)
  // must be written with a quote, or loading it evaluates its items.
  // Source tokens are written as they are, with no separators inserted.
  private showLst(open: string, close: string, xs: ImpVal[], showList: (xs: ImpVal[]) => string): string {
    let asWritten = () => xs.map(item => this.show(item)).join(' ')
    if (this.codeDepth > 0) return open + asWritten() + close
    if (this.isCodeList(open) || xs.some(item => this.isCode(item)))
      return "'" + open + this.asCode(asWritten) + close
    return open + showList(xs) + close
  }

  // Get the "kind" of a noun for comma separation purposes
  // Returns 'number' for numeric items, 'bqt-symbol' for backtick symbols, null otherwise
  private nounKind(x: ImpVal): string | null {
    switch (x[0]) {
      case ImpT.INT:
      case ImpT.NUM:
      case ImpT.INTs:
      case ImpT.NUMs:
        return 'number'
      case ImpT.SYM:
        // Only backtick symbols need commas
        if (x[1].kind === SymT.BQT) return 'bqt-symbol'
        return null
      case ImpT.SYMs:
        return 'bqt-symbol'  // Backtick symbol vectors
      default:
        return null
    }
  }

  // return a string representation
  show: (x: ImpVal) => string = (x) => {
    let showList: (xs: ImpVal[]) => string = (xs) => {
      // Check if this list has any SEP tokens
      const hasSeps = xs.some(item => item[0] === ImpT.SEP)

      let result = ''
      for (let i = 0; i < xs.length; i++) {
        if (i > 0) {
          // If the list has SEPs, they'll be shown naturally; don't insert commas
          // If no SEPs but adjacent same-kind nouns, insert comma
          if (!hasSeps) {
            const prevKind = this.nounKind(xs[i-1])
            const currKind = this.nounKind(xs[i])
            if (prevKind !== null && currKind !== null && prevKind === currKind) {
              result += ', '
            } else {
              result += ' '
            }
          } else {
            result += ' '
          }
        }
        result += this.show(xs[i])
      }
      return result
    }
    switch (x[0]) {
      case ImpT.TOP: return this.asCode(() => showList(x[2]))
      case ImpT.ERR: return `?${q(x[2])}`
      case ImpT.SEP: return x[2]
      case ImpT.INT: return x[2] === NULL_INT ? '0N' : x[2].toString()
      case ImpT.NUM: return x[2].toString()
      case ImpT.STR: return JSON.stringify(x[2])
      case ImpT.NIL: return 'nil'
      case ImpT.MLS: return '```\n' + x[2] + '```\n'
      case ImpT.INTs: return (x[2] as number[]).map(n => n === NULL_INT ? '0N' : n.toString()).join(' ')
      case ImpT.NUMs: return (x[2] as number[]).join(' ')
      case ImpT.SYMs: return (x[2] as symbol[]).map(s => '`' + (s.description ?? '?')).join(' ')
      case ImpT.SYM: {
        let name = x[2].description ?? '?`'
        switch (x[1].kind) {
          case SymT.RAW:  return name
          case SymT.SET:  return name + ':'
          case SymT.GET:  return ':' + name
          case SymT.LIT:  return "'" + name
          case SymT.REFN: return '/' + name
          case SymT.ISH:  return '#' + name
          case SymT.PATH: return name  // path keeps full string (foo/bar)
          case SymT.FILE: return '%' + name
          case SymT.URL:  return name  // URL keeps full string
          case SymT.BQT:  return '`' + name
          case SymT.TYP:  return name + '!'
          case SymT.ANN:  return '@' + name
          case SymT.MSG:  return '.' + name
          case SymT.KW:   return '.' + name + ':'
          case SymT.MSG2: return '!' + name
          case SymT.KW2:  return '!' + name + ':'
          case SymT.ERR:  return '?' + name
          case SymT.UNQ:  return ',' + name
          default: return name
        }
      }
      case ImpT.LST: return this.showLst(x[1].open||'', x[1].close||'', x[2], showList)
      case ImpT.DCT: {
        const dct = x[2] as Map<string, ImpVal>
        if (dct.size === 0) return ':[]'
        const pairs: string[] = []
        for (const [key, val] of dct.entries()) {
          const valStr = this.show(val)
          // Add comma before backtick symbol values to distinguish from key
          if (ImpQ.isSym(val) && val[1] && val[1].kind === SymT.BQT) {
            pairs.push(`\`${key}, ${valStr}`)
          } else if (val[0] === ImpT.SYMs) {
            // For symbol vectors, also add comma
            pairs.push(`\`${key}, ${valStr}`)
          } else {
            pairs.push(`\`${key} ${valStr}`)
          }
        }
        return ':[' + pairs.join('; ') + ']'
      }
      case ImpT.IFN: return '{' + this.asCode(() => showList(x[2])) + '}'
      case ImpT.JSF: {
        // If it's a partial application, show as {source}[args]
        if (x[1].capturedArgs) {
          // Use sourceName if available, otherwise try to show sourceIfn
          let source: string
          if (x[1].sourceName) {
            source = x[1].sourceName
          } else if (x[1].sourceIfn) {
            source = this.show(x[1].sourceIfn)
          } else {
            source = '<fn>'
          }
          let args = x[1].capturedArgs.map(a => this.show(a)).join('; ')
          return `${source}[${args}]`
        }
        // Otherwise show arity in brackets
        let arity = x[1].arity
        return arity === 1 ? '<fn[_]>' : `<fn[${Array(arity).fill('_').join('; ')}]>`
      }
      default:
        console.warn("[show] invalid argument:" + x)
        return `?${JSON.stringify(x)}`}}}

export let impShow : (x:ImpVal) => string =
  (x) => new ImpWriter().show(x)
