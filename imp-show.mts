import { ImpT } from './imp-core.mjs'

export class ImpWriter {

  // return a string representation
  show = (x)=> {
    let showList = (xs)=> xs.map(this.show).join(' ')
    let [t, a, v] = x
    switch (t) {
      case ImpT.TOP: return showList(v)
      case ImpT.SEP: return v
      case ImpT.INT: return v.toString()
      case ImpT.STR: return JSON.stringify(v)
      case ImpT.NIL: return 'nil'
      case ImpT.MLS: return '```\n' + v + '```\n'
      case ImpT.SYM: return v.description
      case ImpT.LST: return a.open + showList(v) + a.close
      default: throw "[show] invalid argument:" + x }}}

export let impShow = (x) => new ImpWriter().show(x)
