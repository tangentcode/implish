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
      case T.NIL: return 'nil'
      case T.MLS: return '```\n' + v + '```\n'
      case T.SYM: return v.description
      case T.LST: return a.open + showList(v) + a.close
      default: throw "[show] invalid argument:" + x }}}

export let impShow = (x) => new ImpWriter().show(x)
