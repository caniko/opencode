import type { Hooks } from "./registration.js"

export interface ShellCreateBefore {
  /** Validated native session identity; absent for sessionless execution. */
  readonly sessionID?: string
  /** Native invocation identity, allocated before preparation starts. */
  readonly invocationID?: string
  readonly toolCallID?: string
  /** Explicit repair execution; project preparation remains the default. */
  readonly environment?: "project" | "bootstrap"
  /** Cancel preparation when the caller stops waiting for shell creation. */
  readonly signal?: AbortSignal
  command: string
  cwd: string
  timeout: number
  shell: string
  env: Record<string, string | undefined>
}

export interface ShellHooks {
  readonly "create.before": ShellCreateBefore
}

export interface ShellDomain {
  readonly hook: Hooks<ShellHooks>
}
