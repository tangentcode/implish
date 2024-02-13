import { T } from './imp-core.mjs'

export class ImpWriter {

  // return a string representation
  show = (x)=> {
    let showList = (xs)=> xs.map(this.show).join(' ')
    let [t, a, v] = x
    switch (t) {
      case T.TOP: return showList(v)
      case T.SEP: return v
      case T.INT: return v.toString()
      case T.STR: return JSON.stringify(v)
      case T.MLS: return '```\n' + v + '```\n'
      case T.SYM: return v.description
      case T.LST: return a.open + showList(v) + a.close
      default: throw "invalid type:" + x[0] }}}