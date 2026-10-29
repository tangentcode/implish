// ANSI color codes for terminal syntax highlighting
const colors = {
  reset: '\x1b[0m',
  number: '\x1b[38;5;110m',      // blue (like #6897bb)
  string: '\x1b[38;5;108m',      // green (like #6a8759)
  operator: '\x1b[38;5;221m',    // yellow (like #ffc66d)
  keyword: '\x1b[38;5;173m',     // orange (like #cc7832)
  identifier: '\x1b[38;5;145m',  // gray (like #a9b7c6)
  comment: '\x1b[38;5;244m',     // dark gray (like #808080)
  brace: '\x1b[38;5;210m',       // red (like #f97c7c)
  symbol: '\x1b[38;5;139m',      // purple for special symbols
  backtick: '\x1b[38;5;179m',    // tan/gold for backtick symbols
  file: '\x1b[38;5;114m',        // light green for file paths
}

const KEYWORDS = new Set([
  'rev', 'drop', 'take', 'each', 'map', 'sum', 'prod', 'min', 'max',
  'abs', 'floor', 'ceil', 'not', 'and', 'or', 'if', 'then', 'else'
])

/**
 * Highlights implish code with ANSI color codes for terminal display
 */
export function highlightCode(code: string): string {
  let result = ''
  let i = 0

  while (i < code.length) {
    const rest = code.slice(i)
    const char = rest[0]

    // Handle whitespace
    if (char === '\t' || char === ' ') {
      result += char
      i++
      continue
    }

    // Handle comments: .: ... :.
    // If unclosed, highlight to end of line
    if (char === '.' && rest[1] === ':') {
      const end = rest.indexOf(':.', 2)
      if (end !== -1) {
        const comment = rest.slice(0, end + 2)
        result += colors.comment + comment + colors.reset
        i += comment.length
        continue
      } else {
        // Unclosed comment - highlight to end of line
        const comment = rest
        result += colors.comment + comment + colors.reset
        i += comment.length
        continue
      }
    }

    // Handle file paths: %/path/to/file
    if (char === '%') {
      const fileMatch = rest.match(/^%[^\s\[\]\{\}\(\)]+/)
      if (fileMatch) {
        result += colors.file + fileMatch[0] + colors.reset
        i += fileMatch[0].length
        continue
      }
    }

    // Handle backtick symbols: `sym
    if (char === '`') {
      const symMatch = rest.match(/^`[^\s\[\]\{\}\(\)]*/)
      if (symMatch) {
        result += colors.backtick + symMatch[0] + colors.reset
        i += symMatch[0].length
        continue
      }
    }

    // Handle single-quote symbols: 'sym
    if (char === "'") {
      const symMatch = rest.match(/^'[^\s\[\]\{\}\(\)]*/)
      if (symMatch) {
        result += colors.symbol + symMatch[0] + colors.reset
        i += symMatch[0].length
        continue
      }
    }

    // Handle get-words: :word
    if (char === ':' && rest.length > 1 && rest[1].match(/[A-Za-z_]/)) {
      const getMatch = rest.match(/^:[A-Za-z_][\w-]*/)
      if (getMatch) {
        result += colors.symbol + getMatch[0] + colors.reset
        i += getMatch[0].length
        continue
      }
    }

    // Handle strings: "..."
    const stringMatch = rest.match(/^"(?:\\.|[^"\\])*"?/)
    if (stringMatch && stringMatch[0].length > 1) {
      result += colors.string + stringMatch[0] + colors.reset
      i += stringMatch[0].length
      continue
    }

    // Handle numbers: 123 or 123.456
    const numberMatch = rest.match(/^\d+(?:\.\d+)?/)
    if (numberMatch) {
      result += colors.number + numberMatch[0] + colors.reset
      i += numberMatch[0].length
      continue
    }

    // Handle words/identifiers
    const wordMatch = rest.match(/^[A-Za-z_][\w-]*/)
    if (wordMatch) {
      const token = wordMatch[0]
      const color = KEYWORDS.has(token) ? colors.keyword : colors.identifier
      result += color + token + colors.reset
      i += token.length
      continue
    }

    // Handle operators
    const operatorMatch = rest.match(/^[+\-*/^=<>!?,]+/)
    if (operatorMatch) {
      result += colors.operator + operatorMatch[0] + colors.reset
      i += operatorMatch[0].length
      continue
    }

    // Handle braces/brackets/parens
    const braceMatch = rest.match(/^[\[\]\{\}\(\)]/)
    if (braceMatch) {
      result += colors.brace + braceMatch[0] + colors.reset
      i += braceMatch[0].length
      continue
    }

    // Default: just add the character as-is
    result += char
    i++
  }

  return result
}
