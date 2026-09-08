import { Effect } from "effect"
import type { Plugin } from "."

export const shellEnvironment = Effect.fn("Plugin.shellEnvironment")(function* (
  plugin: Pick<Plugin.Interface, "trigger">,
  input: { cwd: string; sessionID?: string; callID?: string; signal?: AbortSignal },
  inherited: NodeJS.ProcessEnv = process.env,
) {
  const env = Object.fromEntries(
    Object.entries(inherited).filter((entry): entry is [string, string] => entry[1] !== undefined),
  )
  const output: { env: Record<string, string>; unset?: string[] } = { env: {} }
  const extra = yield* plugin
    .trigger("shell.env", { ...input, env: Object.freeze({ ...env }) }, output)
    .pipe(Effect.catchCause((cause) => (input.signal?.aborted ? Effect.interrupt : Effect.failCause(cause))))
  // Keep the overlay separate: a later plugin may deliberately restore an unset key.
  for (const key of extra.unset ?? []) if (!Object.hasOwn(extra.env, key)) delete env[key]
  return { env: { ...env, ...extra.env }, resolved: extra.unset !== undefined }
})
