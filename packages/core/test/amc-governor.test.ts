import { expect, test } from "bun:test"
import path from "node:path"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import { Effect, Fiber } from "effect"
import { ProcessGovernor } from "@opencode/util/process-governor"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Config } from "@opencode/core/config"
import { Environment } from "@opencode/core/environment/index"
import { Location } from "@opencode/core/location"
import { Shell } from "@opencode/core/shell"
import { Global } from "@opencode/util/global"
import { hostEnvironmentLayer } from "./fixture/environment"
import { tempGlobalLayer } from "./fixture/global"
import { tempLocationLayer } from "./fixture/location"

test("explicit admission uses the heavy lane while diagnostics remain ordinary", () => {
  for (const command of [
    "amc admission exec --contract tool -- cargo check",
    "/nix/store/example/bin/amc admission exec --contract tool -- true",
    "amc --config /example/policy.toml admission exec --contract tool -- true",
    "amc admission --config /example/policy.toml exec --contract tool -- true",
  ])
    expect(ProcessGovernor.classifyShell(command)).toBe("heavy")
  for (const command of [
    "amc admission status --json",
    "amc inspect opencode.service",
    "amc watch selected.service --seconds 1 --output /example/capture",
    "amc exec --slice agent-tools.slice --memory-max 1024 --memory-swap-max 0 -- true",
    "echo amc admission exec",
    "git status --short --branch",
  ])
    expect(ProcessGovernor.classifyShell(command)).toBe("ordinary")
})

test("six admission submissions cannot consume ordinary diagnostic slots", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "opencode-amc-governor-"))
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const governor = ProcessGovernor.make({ ordinary: 6, heavy: 1, dir })
          const processClass = ProcessGovernor.classifyShell("amc admission exec --contract tool -- true")
          const running = yield* governor.acquire(processClass)
          const waiters = []
          for (let count = 0; count < 5; count++)
            waiters.push(yield* governor.acquire(processClass).pipe(Effect.forkScoped))
          yield* Effect.gen(function* () {
            while ((yield* governor.status()).heavy.queued !== 5) yield* Effect.sleep("5 millis")
          }).pipe(Effect.timeout("2 seconds"))
          const diagnostic = yield* governor
            .acquire(ProcessGovernor.classifyShell("git status"))
            .pipe(Effect.timeout("1 second"))
          expect((yield* governor.status()).ordinary.running).toBe(1)
          yield* diagnostic.release
          for (const waiter of waiters) yield* Fiber.interrupt(waiter)
          yield* running.release
        }),
      ),
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}, 5000)

test("V2 shell diagnostics execute while admission waits time out or cancel", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const shell = yield* Shell.Service
        const lease = yield* ProcessGovernor.acquire("heavy")
        yield* Effect.addFinalizer(() => lease.release)
        const waitForQueue = Effect.gen(function* () {
          while ((yield* ProcessGovernor.status()).heavy.queued !== 1) yield* Effect.sleep("5 millis")
        }).pipe(Effect.timeout("2 seconds"))
        const pending = yield* shell
          .create({ shell: "sh", command: "amc admission exec --contract tool -- true", timeout: 0 })
          .pipe(Effect.forkScoped)
        yield* waitForQueue
        const diagnostic = yield* shell
          .create({ shell: "sh", command: "printf diagnostic", timeout: 1000 })
          .pipe(Effect.timeout("2 seconds"))
        expect(yield* shell.result(diagnostic)).toMatchObject({
          info: { status: "exited", exit: 0 },
          capture: { output: "diagnostic" },
        })
        yield* Fiber.interrupt(pending)
        const error = yield* shell
          .create({ shell: "sh", command: "amc admission exec --contract tool -- true", timeout: 50 })
          .pipe(Effect.flip, Effect.timeout("2 seconds"))
        expect(error.message).toContain("Timed out waiting for process governor")
        expect((yield* ProcessGovernor.status()).heavy.queued).toBe(0)
      }).pipe(
        Effect.provide(
          AppNodeBuilder.build(Shell.node, [
            Location.node.replace(tempLocationLayer),
            Global.node.replace(tempGlobalLayer),
            Config.node.replace(Config.testLayer()),
            Environment.node.replace(hostEnvironmentLayer),
          ]),
        ),
      ),
    ),
  )
}, 10000)
