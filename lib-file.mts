// Path handling utilities for implish
// Handles conversion between implish file paths (%file/path) and native OS paths

/**
 * Convert implish file path to native OS path
 * On Windows: %/d/path → d:/path
 * On Unix:    %/path → /path
 */
export function toNativePath(implishPath: string): string {
  // Strip the leading % if present
  let path = implishPath.startsWith('%') ? implishPath.slice(1) : implishPath

  // On Windows, convert /d/path to d:/path
  if (process.platform === 'win32') {
    let driveMatch = path.match(/^\/([a-zA-Z])\/(.*)/)
    if (driveMatch) {
      return driveMatch[1] + ':/' + driveMatch[2]
    }
    // Also handle /d (just the drive)
    let driveOnlyMatch = path.match(/^\/([a-zA-Z])$/)
    if (driveOnlyMatch) {
      return driveOnlyMatch[1] + ':/'
    }
  }

  return path
}

/**
 * Convert native OS path to implish file path
 * On Windows: d:/path → %/d/path or D:\path → %/d/path
 * On Unix:    /path → %/path
 */
export function toImplishPath(nativePath: string): string {
  // On Windows, convert d:/path or d:\path to %/d/path
  if (process.platform === 'win32') {
    let driveMatch = nativePath.match(/^([a-zA-Z]):[\/\\](.*)/)
    if (driveMatch) {
      return '%/' + driveMatch[1].toLowerCase() + '/' + driveMatch[2].replace(/\\/g, '/')
    }
    // Handle bare drive letter d: or d:\
    let driveOnlyMatch = nativePath.match(/^([a-zA-Z]):[\/\\]?$/)
    if (driveOnlyMatch) {
      return '%/' + driveOnlyMatch[1].toLowerCase() + '/'
    }
  }

  // For Unix or relative paths, just prepend %
  return '%' + nativePath
}

/**
 * Parse a partial implish path for tab completion
 * Returns: {nativeDir, prefix, isWindowsDrive, driveLetter, rest}
 */
export function parsePartialPath(partialPath: string): {
  nativeDir: string,
  prefix: string,
  isWindowsDrive: boolean,
  driveLetter?: string,
  rest?: string
} {
  // Strip the % prefix if present
  let path = partialPath.startsWith('%') ? partialPath.slice(1) : partialPath

  // Windows drive path: /d/ or /d/some/path
  if (process.platform === 'win32') {
    let match = path.match(/^\/([a-zA-Z])(\/|$)(.*)/)
    if (match) {
      let driveLetter = match[1]
      let rest = match[3] || ''

      if (rest.includes('/') || rest.includes('\\')) {
        let lastSep = Math.max(rest.lastIndexOf('/'), rest.lastIndexOf('\\'))
        return {
          nativeDir: driveLetter + ':/' + rest.slice(0, lastSep),
          prefix: rest.slice(lastSep + 1),
          isWindowsDrive: true,
          driveLetter,
          rest
        }
      } else {
        return {
          nativeDir: driveLetter + ':/',
          prefix: rest,
          isWindowsDrive: true,
          driveLetter,
          rest
        }
      }
    }
  }

  // Regular path
  if (path.includes('/') || path.includes('\\')) {
    let lastSep = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
    return {
      nativeDir: path.slice(0, lastSep) || '.',
      prefix: path.slice(lastSep + 1),
      isWindowsDrive: false
    }
  }

  // No directory separator - current directory
  return {
    nativeDir: '.',
    prefix: path,
    isWindowsDrive: false
  }
}

/**
 * Reconstruct an implish path from parsed components
 */
export function reconstructImplishPath(
  parsed: ReturnType<typeof parsePartialPath>,
  filename: string,
  isDirectory: boolean
): string {
  let fullPath: string

  if (parsed.isWindowsDrive && parsed.driveLetter) {
    // Reconstruct as %/d/path
    let rest = parsed.rest || ''
    let dirPart = rest.includes('/')
      ? rest.slice(0, rest.lastIndexOf('/') + 1)
      : ''
    fullPath = '%/' + parsed.driveLetter + '/' + dirPart + filename
  } else if (parsed.nativeDir === '.') {
    // Current directory
    fullPath = '%' + filename
  } else {
    // Regular path
    fullPath = '%' + parsed.nativeDir + '/' + filename
  }

  // Add trailing / for directories
  if (isDirectory && !fullPath.endsWith('/')) {
    fullPath += '/'
  }

  return fullPath
}
