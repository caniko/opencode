import { expect } from "bun:test"
import { Effect, Schedule } from "effect"
import path from "node:path"
import { constants, createReadStream } from "node:fs"
import fs from "node:fs/promises"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Config } from "@opencode/core/config"
import { Environment } from "@opencode/core/environment/index"
import { Location } from "@opencode/core/location"
import { Shell } from "@opencode/core/shell"
import { Global } from "@opencode/util/global"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { hostEnvironmentLayer } from "./fixture/environment"
import { tempGlobalLayer } from "./fixture/global"
import { tempLocationLayer } from "./fixture/location"
import { testEffect } from "./lib/effect"

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Shell.node, Global.node, Location.node]), [
    Location.node.replace(tempLocationLayer),
    Global.node.replace(tempGlobalLayer),
    Config.node.replace(Config.testLayer()),
    Environment.node.replace(hostEnvironmentLayer),
  ] satisfies LayerNode.Replacements),
)

if (process.platform === "linux") {
  it.live("an output write failure fails the shell and cleans up its producer", () =>
    Effect.gen(function* () {
      const shell = yield* Shell.Service
      const global = yield* Global.Service
      const location = yield* Location.Service
      const id = Shell.ID.create()
      const file = path.join(global.data, Shell.DIRECTORY, location.project.id, `${id}.out`)
      yield* Effect.promise(() => fs.symlink("/dev/full", file))
      yield* shell.create({ id, shell: "/bin/sh", command: "head -c 16777216 /dev/zero", background: true })
      const result = yield* shell.wait(id).pipe(Effect.timeout("2 seconds"))
      expect(result.status).toBe("failed")
      expect(result.error).toContain("ENOSPC")
      const control = yield* shell.create({ shell: "/bin/sh", command: "printf responsive", timeout: 0 })
      expect((yield* shell.result(control)).capture?.output).toBe("responsive")
    }),
  )

  it.live("a blocked output sink backpressures the producer without blocking other shells", () =>
    Effect.gen(function* () {
      const shell = yield* Shell.Service
      const global = yield* Global.Service
      const location = yield* Location.Service
      const id = Shell.ID.create()
      const fifo = path.join(global.data, Shell.DIRECTORY, location.project.id, `${id}.out`)
      const entered = path.join(location.directory, "entered")
      const completed = path.join(location.directory, "completed")
      expect(yield* Effect.promise(() => Bun.spawn(["mkfifo", fifo]).exited)).toBe(0)
      const reader = yield* Effect.promise(() => fs.open(fifo, constants.O_RDWR | constants.O_NONBLOCK))
      yield* Effect.gen(function* () {
        yield* shell.create({
          id,
          shell: "/bin/sh",
          command: `touch '${entered}'; head -c 16777216 /dev/zero; touch '${completed}'`,
          timeout: 0,
        })
        yield* Effect.promise(() => Bun.file(entered).exists()).pipe(
          Effect.repeat({ until: (exists) => exists, schedule: Schedule.spaced("10 millis") }),
          Effect.timeout("10 seconds"),
        )
        yield* Effect.sleep("1 second")
        expect(yield* Effect.promise(() => Bun.file(completed).exists())).toBe(false)
        const control = yield* shell.create({ shell: "/bin/sh", command: "printf responsive", timeout: 0 })
        expect((yield* shell.result(control)).capture?.output).toBe("responsive")
      }).pipe(
        Effect.ensuring(
          Effect.promise(async () => {
            const drain = createReadStream(fifo)
            await new Promise<void>((resolve, reject) => {
              // Keep a reader connected until the draining reader has opened.
              drain.once("open", () => reader.close().catch(reject))
              drain.on("data", () => {})
              drain.once("end", resolve)
              drain.once("error", reject)
            })
          }),
        ),
      )
      expect((yield* shell.wait(id)).exit).toBe(0)
      expect(yield* Effect.promise(() => Bun.file(completed).exists())).toBe(true)
    }),
  )
}
