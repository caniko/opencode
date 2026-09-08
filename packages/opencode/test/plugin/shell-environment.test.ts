import { expect, test } from "bun:test"
import { Effect } from "effect"
import { shellEnvironment } from "../../src/plugin/shell-environment"
import type { Hooks } from "@opencode-ai/plugin"

test("keeps the legacy overlay separate and applies explicit removals before later overrides", async () => {
  const base = { PATH: "/backend", REMOVE: "inherited", KEEP: "base" }
  const result = await Effect.runPromise(
    shellEnvironment(
      {
        trigger: (_name, input, output) =>
          Effect.sync(() => {
            const args = input as Parameters<NonNullable<Hooks["shell.env"]>>[0]
            const extra = output as Parameters<NonNullable<Hooks["shell.env"]>>[1]
            expect(args.env).toEqual(base)
            expect(extra.env).toEqual({})
            extra.unset = ["REMOVE", "KEEP"]
            extra.env.KEEP = "later-plugin"
            return output
          }),
      },
      { cwd: "/project" },
      base,
    ),
  )
  expect(result.env).toEqual({ PATH: "/backend", KEEP: "later-plugin" })
  expect(result.resolved).toBe(true)
  expect(base.REMOVE).toBe("inherited")
})

test("does not opt legacy plugins into new executable selection", async () => {
  const result = await Effect.runPromise(
    shellEnvironment(
      {
        trigger: (_name, _input, output) => Effect.succeed({ ...output, env: { PATH: "/legacy" } }),
      },
      { cwd: "/project" },
      { PATH: "/base" },
    ),
  )
  expect(result).toEqual({ env: { PATH: "/legacy" }, resolved: false })
})
