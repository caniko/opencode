import { expect, test } from "bun:test"
import { Deferred, Effect, Layer, Schedule } from "effect"
import { ChildProcessSpawner } from "effect/unstable/process"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Config } from "@opencode/core/config"
import { Environment } from "@opencode/core/environment/index"
import { Location } from "@opencode/core/location"
import { PluginHooks } from "@opencode/core/plugin/hooks"
import { Shell } from "@opencode/core/shell"
import { Job } from "@opencode/core/job"
import { Global } from "@opencode/util/global"
import { hostEnvironmentLayer } from "./fixture/environment"
import { tempGlobalLayer } from "./fixture/global"
import { tempLocationLayer } from "./fixture/location"

test("native admission waiters do not occupy lifetime slots needed by control calls", async () => {
  if (process.platform === "win32") return
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const shell = yield* Shell.Service
        const hooks = yield* PluginHooks.Service
        yield* hooks.register("shell", "create.before", (event) =>
          Effect.sync(() => {
            event.env.OPENCODE_SHELL_NOTIFY_START = event.command.startsWith("printf waiting") ? "1" : undefined
          }),
        )
        const queued = yield* Effect.forEach(Array.from({ length: 8 }), () =>
          shell.create({ shell: "sh", command: "printf waiting; sleep 30", background: true }),
        )
        yield* Effect.forEach(queued, (info) =>
          shell
            .output(info.id)
            .pipe(
              Effect.repeat({ until: (output) => output.output === "waiting", schedule: Schedule.spaced("5 millis") }),
            ),
        ).pipe(Effect.timeout("2 seconds"))
        expect((yield* shell.list()).every((info) => info.status === "queued")).toBe(true)
        const control = yield* shell.create({ shell: "sh", command: "printf control", timeout: 1000 })
        expect((yield* shell.result(control)).capture?.output).toBe("control")
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

test("direct shell submissions remain bounded before preparation or native dispatch", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const shell = yield* Shell.Service
        const hooks = yield* PluginHooks.Service
        yield* hooks.register("shell", "create.before", () => Effect.never)
        const queued = yield* Effect.forEach(Array.from({ length: Job.ACTIVE_LIMIT }), () =>
          shell.create({ shell: "sh", command: "printf must-not-run", background: true }),
        )
        const error = yield* shell
          .create({ shell: "sh", command: "printf overflow", background: true })
          .pipe(Effect.flip)
        expect(error.cause).toBeInstanceOf(Job.CapacityError)
        expect(yield* shell.list()).toHaveLength(Job.ACTIVE_LIMIT)
        yield* shell.remove(queued[0]!.id)
        expect((yield* shell.create({ shell: "sh", command: "printf replacement", background: true })).status).toBe(
          "queued",
        )
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

test("queued shells have a cancellable handle and queue waits do not spend execution time", async () => {
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
        const marker = `printf '\\036%s\\037' "$OPENCODE_SHELL_START_TOKEN" >&2`
        const queued = yield* shell.create({
          shell: "sh",
          command: `sleep .7; ${marker}; printf admitted`,
          timeout: 500,
          background: true,
        })
        expect(queued).toMatchObject({ status: "queued" })
        expect(queued.time.started).toBeUndefined()
        expect(queued.time.queued).toBeNumber()
        expect((yield* shell.list()).map((entry) => entry.id)).toContain(queued.id)
        expect(yield* shell.output(queued.id)).toMatchObject({ output: "", size: 0 })
        yield* Effect.sleep("550 millis")
        expect((yield* shell.get(queued.id)).status).toBe("queued")
        const cancelled = yield* shell.create({
          shell: "sh",
          command: `sleep 30; ${marker}; printf must-not-run`,
          background: true,
        })
        expect((yield* shell.kill(cancelled.id)).status).toBe("killed")
        expect((yield* shell.list()).map((entry) => entry.id)).not.toContain(cancelled.id)
        const result = yield* shell.result(queued).pipe(Effect.timeout("3 seconds"))
        expect(result).toMatchObject({ info: { status: "exited", exit: 0 }, capture: { output: "admitted" } })
        expect(result.info.time.started).toBeGreaterThan(queued.time.queued ?? 0)
        const retained = yield* shell.create({
          shell: "sh",
          command: `${marker}; printf cancellation-evidence; sleep 20`,
          background: true,
        })
        yield* shell.output(retained.id).pipe(
          Effect.tap(() => Effect.sleep("5 millis")),
          Effect.repeat({ until: (output) => output.output === "cancellation-evidence" }),
          Effect.timeout("2 seconds"),
        )
        expect((yield* shell.kill(retained.id)).status).toBe("killed")
        expect(yield* shell.result(retained)).toMatchObject({ capture: { output: "cancellation-evidence" } })
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

test("typed nonacceptance preserves the queued shell without a waiting process or blind replay", async () => {
  if (process.platform === "win32") return
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const shell = yield* Shell.Service
        const hooks = yield* PluginHooks.Service
        const global = yield* Global.Service
        const attempts = `${global.data}/attempts`
        const original: string[] = []
        yield* hooks.register("shell", "create.before", (event) =>
          Effect.sync(() => {
            original.push(event.command)
            event.env.OPENCODE_SHELL_NOTIFY_START = "1"
            event.command = `
        if [ ! -f '${attempts}' ]; then
          printf first > '${attempts}'
          printf '\\036%s:back' "$OPENCODE_SHELL_START_TOKEN" >&2
          sleep .02
          printf between
          printf 'pressure:500\\037' >&2
          exit 75
        fi
        printf '\\036%s\\037' "$OPENCODE_SHELL_START_TOKEN" >&2
        printf executed
      `
          }),
        )
        const queued = yield* shell.create({ shell: "sh", command: "original", background: true, timeout: 100 })
        yield* Effect.sleep("200 millis")
        expect(yield* shell.get(queued.id)).toMatchObject({ status: "queued" })
        expect((yield* shell.get(queued.id)).pid).toBeUndefined()
        expect((yield* shell.get(queued.id)).time.started).toBeUndefined()
        expect(yield* shell.result(queued)).toMatchObject({
          info: { status: "exited", exit: 0 },
          capture: { output: "betweenexecuted" },
        })
        expect(original).toEqual(["original", "original"])

        yield* hooks.register("shell", "create.before", (event) =>
          Effect.sync(() => {
            event.env.OPENCODE_SHELL_NOTIFY_START = "1"
            event.command = `printf '\\036%s:backpressure:5000\\037' "$OPENCODE_SHELL_START_TOKEN" >&2; exit 75`
          }),
        )
        const cancelled = yield* shell.create({ shell: "sh", command: "cancelled", background: true })
        yield* Effect.sleep("100 millis")
        expect((yield* shell.get(cancelled.id)).status).toBe("queued")
        yield* shell.kill(cancelled.id)
        expect((yield* shell.get(cancelled.id)).status).toBe("killed")

        const expired = yield* shell.create({ shell: "sh", command: "expired", background: true, queueTimeout: 100 })
        expect((yield* shell.result(expired)).info.status).toBe("failed")
        for (const script of [
          `printf '\\036%s:backpressure:1\\037' "$OPENCODE_SHELL_START_TOKEN" >&2; exit 1`,
          `printf '\\036wrong-token:backpressure:1\\037' >&2; exit 75`,
          `printf '\\036%s:backpressure:1\\037' "$OPENCODE_SHELL_START_TOKEN"; exit 75`,
          `printf '\\036%s:backpressure:0\\037' "$OPENCODE_SHELL_START_TOKEN" >&2; exit 75`,
          `printf '\\036%s:backpressure:60001\\037' "$OPENCODE_SHELL_START_TOKEN" >&2; exit 75`,
          `printf '\\036%s\\037\\036%s:backpressure:1\\037' "$OPENCODE_SHELL_START_TOKEN" "$OPENCODE_SHELL_START_TOKEN" >&2; exit 75`,
        ]) {
          const registration = yield* hooks.register("shell", "create.before", (event) =>
            Effect.sync(() => {
              event.command = script
            }),
          )
          const count = original.length
          const rejected = yield* shell.create({ shell: "sh", command: "no-replay", background: true })
          yield* shell.result(rejected)
          expect(original.length).toBe(count + 1)
          yield* registration.dispose
        }
      }).pipe(
        Effect.provide(
          AppNodeBuilder.build(LayerNode.group([Shell.node, PluginHooks.node, Global.node]), [
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
