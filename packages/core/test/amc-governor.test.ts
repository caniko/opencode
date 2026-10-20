import { expect, test } from "bun:test"
import path from "node:path"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import { Deferred, Effect, Fiber, Layer } from "effect"
import { ChildProcessSpawner } from "effect/unstable/process"
import { ProcessGovernor } from "@opencode/util/process-governor"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Config } from "@opencode/core/config"
import { Environment } from "@opencode/core/environment/index"
import { Location } from "@opencode/core/location"
import { PluginHooks } from "@opencode/core/plugin/hooks"
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
          .create({ shell: "sh", command: "amc admission exec --contract tool -- true", queueTimeout: 50 })
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

test("queued shells have a cancellable handle and queue waits do not spend execution time", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const shell = yield* Shell.Service
        const leases = yield* Effect.forEach(Array.from({ length: 6 }), () => ProcessGovernor.acquire("ordinary"))
        yield* Effect.addFinalizer(() => Effect.forEach(leases, (lease) => lease.release))
        const queued = yield* shell.create({ shell: "sh", command: "printf admitted", timeout: 500, background: true })
        expect(queued).toMatchObject({ status: "queued" })
        expect(queued.time.started).toBeUndefined()
        expect(queued.time.queued).toBeNumber()
        expect((yield* shell.list()).map((entry) => entry.id)).toContain(queued.id)
        expect(yield* shell.output(queued.id)).toMatchObject({ output: "", size: 0 })
        yield* Effect.sleep("550 millis")
        expect((yield* shell.get(queued.id)).status).toBe("queued")
        const cancelled = yield* shell.create({ shell: "sh", command: "printf must-not-run", background: true })
        yield* shell.remove(cancelled.id)
        expect((yield* shell.list()).map((entry) => entry.id)).not.toContain(cancelled.id)
        yield* Effect.forEach(leases, (lease) => lease.release)
        const result = yield* shell.result(queued).pipe(Effect.timeout("3 seconds"))
        expect(result).toMatchObject({ info: { status: "exited", exit: 0 }, capture: { output: "admitted" } })
        expect(result.info.time.started).toBeGreaterThan(queued.time.queued ?? 0)
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

test("shell completion waits for native process scope cleanup", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const cleaning = yield* Deferred.make<void>()
        const cleaned = yield* Deferred.make<void>()
        const environment = Layer.effect(
          Environment.Service,
          Effect.gen(function* () {
            const host = yield* Environment.Service
            return Environment.Service.of({
              ...host,
              spawner: ChildProcessSpawner.make((command) =>
                host.spawner
                  .spawn(command)
                  .pipe(
                    Effect.tap(() =>
                      Effect.addFinalizer(() =>
                        Deferred.succeed(cleaning, undefined).pipe(Effect.andThen(Deferred.await(cleaned))),
                      ),
                    ),
                  ),
              ),
            })
          }),
        ).pipe(Layer.provide(hostEnvironmentLayer))
        yield* Effect.gen(function* () {
          const shell = yield* Shell.Service
          const info = yield* shell.create({ shell: "sh", command: "printf finished" })
          yield* Deferred.await(cleaning)
          yield* shell.wait(info.id).pipe(
            Effect.timeoutOption("20 millis"),
            Effect.tap((result) => Effect.sync(() => expect(result._tag).toBe("None"))),
            Effect.ensuring(Deferred.succeed(cleaned, undefined)),
          )
          expect(yield* shell.wait(info.id)).toMatchObject({ status: "exited", exit: 0 })
        }).pipe(
          Effect.provide(
            AppNodeBuilder.build(Shell.node, [
              Location.node.replace(tempLocationLayer),
              Global.node.replace(tempGlobalLayer),
              Config.node.replace(Config.testLayer()),
              Environment.node.replace(environment),
            ]),
          ),
        )
      }),
    ),
  )
}, 10000)

test("background shells are registered and cancellable during preparation", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const shell = yield* Shell.Service
        const hooks = yield* PluginHooks.Service
        const preparing = yield* Deferred.make<void>()
        const aborted = yield* Deferred.make<void>()
        const signals: AbortSignal[] = []
        yield* hooks.register("shell", "create.before", (event) =>
          Deferred.succeed(preparing, undefined).pipe(
            Effect.tap(() => Effect.sync(() => signals.push(event.signal!))),
            Effect.andThen(Effect.never),
            Effect.ensuring(Deferred.succeed(aborted, undefined)),
          ),
        )
        const accepted = yield* shell
          .create({ shell: "sh", command: "printf must-not-run", background: true })
          .pipe(Effect.timeout("1 second"))
        yield* Deferred.await(preparing)
        expect(yield* shell.get(accepted.id)).toMatchObject({ status: "queued", command: "printf must-not-run" })
        const duplicate = yield* shell
          .create({ id: accepted.id, shell: "sh", command: "printf duplicate", background: true })
          .pipe(Effect.flip)
        expect(duplicate.message).toContain("Shell ID already accepted")
        yield* shell.remove(accepted.id)
        yield* Deferred.await(aborted)
        expect(signals[0]?.aborted).toBe(true)
        expect(yield* shell.list()).toEqual([])
        expect((yield* ProcessGovernor.status()).ordinary.running).toBe(0)
      }).pipe(
        Effect.provide(
          AppNodeBuilder.build(LayerNode.group([Shell.node, PluginHooks.node]), [
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

test("native admission readiness, not shim spawn, starts the shell execution clock", async () => {
  if (process.platform === "win32") return
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const shell = yield* Shell.Service
        const hooks = yield* PluginHooks.Service
        yield* hooks.register("shell", "create.before", (event) =>
          Effect.sync(() => {
            event.env.OPENCODE_SHELL_NOTIFY_START = "1"
          }),
        )
        const marker = `printf '\\036' >&2; sleep .02; printf between; sleep .02; printf '%s' "$OPENCODE_SHELL_START_TOKEN" >&2; sleep .02; printf '\\037' >&2`
        const queued = yield* shell.create({
          shell: "sh",
          command: `printf before; sleep .8; ${marker}; printf after`,
          timeout: 200,
          background: true,
        })
        yield* Effect.sleep("300 millis")
        expect(yield* shell.get(queued.id)).toMatchObject({ status: "queued" })
        expect((yield* shell.get(queued.id)).time.started).toBeUndefined()
        expect(yield* shell.result(queued)).toMatchObject({
          info: { status: "exited", exit: 0 },
          capture: { output: "beforebetweenafter" },
        })
        expect((yield* shell.started(queued.id)).time.started! - queued.time.queued!).toBeGreaterThanOrEqual(750)

        const slow = yield* shell.create({ shell: "sh", command: `${marker}; sleep 2`, timeout: 100, background: true })
        expect((yield* shell.result(slow)).info.status).toBe("timeout")

        const rejected = yield* shell.create({ shell: "sh", command: "printf rejected; exit 17", background: true })
        const error = yield* shell.started(rejected.id).pipe(Effect.flip)
        expect(error.message).toContain("before native admission")
        expect(yield* shell.result(rejected)).toMatchObject({
          info: { status: "failed" },
          capture: { output: "rejected" },
        })

        const expired = yield* shell.create({
          shell: "sh",
          command: `sleep .8; ${marker}; printf must-not-run`,
          queueTimeout: 100,
          background: true,
        })
        const expiredError = yield* shell.started(expired.id).pipe(Effect.flip)
        expect(expiredError.message).toContain("waiting for native admission")
        expect(yield* shell.result(expired)).toMatchObject({
          info: { status: "failed" },
          capture: { output: "(no output)" },
        })

        const cancelled = yield* shell.create({ shell: "sh", command: `sleep 2; ${marker}`, background: true })
        yield* Effect.sleep("100 millis")
        expect((yield* shell.get(cancelled.id)).status).toBe("queued")
        yield* shell.remove(cancelled.id)
        expect(yield* shell.list()).toEqual([])
        expect((yield* ProcessGovernor.status()).ordinary.running).toBe(0)
      }).pipe(
        Effect.provide(
          AppNodeBuilder.build(LayerNode.group([Shell.node, PluginHooks.node]), [
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
