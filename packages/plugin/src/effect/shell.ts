import type { Hooks } from "./registration.js"

export interface ShellCreateBefore {
  /** Validated native session identity; absent for sessionless execution. */
  readonly sessionID?: string
  /** Cancel preparation when the caller stops waiting for shell creation. */
  readonly signal?: AbortSignal
  /** Explicit caller choice; project preparation is the default. */
  readonly environment?: "project" | "bootstrap"
  /** Native shell identity allocated before preparation starts. */
  readonly invocationID?: string
  /** Originating native tool call, absent for direct user shells. */
  readonly toolCallID?: string
  command: string
  cwd: string
  timeout: number
  shell: string
  /** A trusted native adapter can opt into RS/token/US stderr start framing with
   * OPENCODE_SHELL_NOTIFY_START=1. Core supplies a fresh OPENCODE_SHELL_START_TOKEN;
   * emit it only after admission. Until then the shell stays queued without using
   * its execution timeout. Adapters must not pass the token to nested payloads. */
  env: Record<string, string | undefined>
}

export interface ShellHooks {
  readonly "create.before": ShellCreateBefore
}

export interface ShellDomain {
  readonly hook: Hooks<ShellHooks>
}
