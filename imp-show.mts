import { ImpT, ImpVal } from './imp-core.mjs'

function q(x:string):string {
  if (x.match(/^[a-zA-Z0-9_]*$/)) return x
  else return JSON.stringify(x)}

export class ImpWriter {

  // return a string representation
  show: (x: ImpVal) => string = (x) => {
    let showList: (xs: ImpVal[]) => string =
      (xs) => xs.map(this.show).join(' ')
    switch (x[0]) {
      case ImpT.TOP: return showList(x[2])
      case ImpT.ERR: return `?${q(x[2])}`
      case ImpT.SEP: return x[2]
      case ImpT.INT: return x[2].toString()
      case ImpT.STR: return JSON.stringify(x[2])
      case ImpT.NIL: return 'nil'
      case ImpT.MLS: return '```\n' + x[2] + '```\n'
      case ImpT.SYM: return x[2].description ?? '?`'
      case ImpT.LST: return (x[1].open||'') + showList(x[2]) + (x[1].close||'')
      default:
        console.warn("[show] invalid argument:" + x)
        return `?${JSON.stringify(x)}`}}}

export let impShow : (x:ImpVal) => string =
  (x) => new ImpWriter().show(x)
