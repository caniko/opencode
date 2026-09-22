import { Wildcard } from "./wildcard"

// Generic environment twins must stop at the executable, not a later argument.
// ponytail: only literal assignment values are recognized here; expansions and
// escapes retain restrictive matching rather than guessing shell syntax.
const assignments = /^(?:[A-Za-z_][A-Za-z0-9_]*=(?:[^\s'"\\$`;&|<>()]|'[^']*'|"[^"\\$`]*")*[ \t]+)+/

export function match(input: string, pattern: string, action: string) {
  if (!pattern.startsWith("*=* ")) return Wildcard.match(input, pattern)
  if (!/^[A-Za-z_][A-Za-z0-9_]*=/.test(input)) return false
  const prefix = assignments.exec(input)?.[0]
  if (!prefix || /^[A-Za-z_][A-Za-z0-9_]*=/.test(input.slice(prefix.length))) {
    return action !== "allow" && Wildcard.match(input, pattern)
  }
  return Wildcard.match(input.slice(prefix.length), pattern.slice(4))
}

export * as BashPermission from "./bash-permission"
