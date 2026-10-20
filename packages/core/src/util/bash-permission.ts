export * as BashPermission from "./bash-permission.js"

import { Wildcard } from "./wildcard.js"

// Generic environment twins must stop at the executable, not a later argument.
// ponytail: only literal assignment values are recognized here; expansions and
// escapes retain restrictive matching rather than guessing shell syntax.
const assignments = /^(?:[A-Za-z_][A-Za-z0-9_]*=(?:[^\s'"\\$`;&|<>()]|'[^']*'|"[^"\\$`]*")*[ \t]+)+/

// PowerShell and cmd have no assignment prefixes: `NAME=value` there names the executable.
export function match(input: string, pattern: string, effect: string, posix = true) {
  if (!pattern.startsWith("*=* ")) return Wildcard.match(input, pattern)
  if (!/^[A-Za-z_][A-Za-z0-9_]*=/.test(input)) return false
  if (!posix) return effect !== "allow" && Wildcard.match(input, pattern)
  const prefix = assignments.exec(input)?.[0]
  if (!prefix || /^[A-Za-z_][A-Za-z0-9_]*=/.test(input.slice(prefix.length))) {
    return effect !== "allow" && Wildcard.match(input, pattern)
  }
  return Wildcard.match(input.slice(prefix.length), pattern.slice(4))
}
