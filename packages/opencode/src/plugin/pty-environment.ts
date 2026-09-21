export * as PluginPtyEnvironment from "./pty-environment"

import { PtyEnvironment } from "@opencode-ai/server/pty-environment"
import { Direnv } from "@opencode-ai/core/direnv"
import { Effect, Layer } from "effect"
import { InstanceStore } from "@/project/instance-store"
import { Plugin } from "."
import { shellEnvironment } from "./shell-environment"

export const layer = Layer.effect(
  PtyEnvironment.Service,
  Effect.gen(function* () {
    const plugin = yield* Plugin.Service
    const instances = yield* InstanceStore.Service
    return PtyEnvironment.Service.of({
      get: Effect.fn("PtyEnvironment.get")(function* (input) {
        return yield* instances.provide({ directory: input.directory }, resolve(input))
      }),
    })

    function resolve(input: { directory: string; cwd: string; env?: Record<string, string> }) {
      return Effect.gen(function* () {
        const base = yield* Effect.promise((signal) => Direnv.environment(input.cwd, process.env, signal))
        return yield* shellEnvironment(plugin, { cwd: input.cwd }, { ...base, ...input.env })
      })
    }
  }),
)
