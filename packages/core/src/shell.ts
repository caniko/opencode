export * as Shell from "./shell.js"
export { ID, Info } from "@opencode/schema/shell"

import path from "path"
import { randomUUID } from "node:crypto"
import { Cause, Context, Deferred, Duration, Effect, Exit, Fiber, Latch, Layer, Schema, Schedule, Stream } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { produce } from "immer"
import { Shell } from "@opencode/schema/shell"
import { AppProcess } from "@opencode/util/process"
import { CrossSpawnSpawner } from "@opencode/util/cross-spawn-spawner"
import { makeGlobalNode, makeLocationNode } from "@opencode/util/effect/app-node"
import { FSUtil } from "@opencode/util/fs-util"
import { Bus } from "./bus.js"
import { Environment } from "./environment/index.js"
import { FileRetention } from "./file-retention.js"
import { Location } from "./location.js"
import { Global } from "@opencode/util/global"
import { ShellSelect } from "./shell/select.js"
import type { ShellCreateBefore } from "@opencode/plugin/effect/shell"
import { PluginHooks } from "./plugin/hooks.js"
import { SessionEnvironment } from "./session/environment.js"
import { SessionSchema } from "./session/schema.js"
import { Config } from "./config.js"
import { ToolOutput } from "./tool-output.js"
import { ShellResult } from "./shell/result.js"
import { Job } from "./job.js"

export class NotFoundError extends Schema.TaggedError<NotFoundError>()("Shell.NotFoundError", {
  id: Shell.ID,
}) {}

// Keep recent exited processes observable in memory, including their file-backed output.
// The process-local cap complements the time-based sweep, which also cleans files left by restarts.
const EXITED_LIMIT = 25
export const RETENTION = Duration.days(7)
export const DIRECTORY = "shell"
// Plugin preparation or native admission waiting this long hands a foreground caller a queued handle.
export const STALL = Duration.millis(250)
export const RECONCILING =
  "Native workload completion was not proven; the outcome is reconciling and will not be replayed automatically. Inspect native execution and any side effects before retrying."

type Info = Shell.Info
type CreateInput = Shell.CreateInput & {
  id?: Shell.ID
  shell?: string
  environment?: "project" | "bootstrap"
  // Tool-owned background jobs may acknowledge original authorization before
  // preparation; transformed commands still require the final leaf check.
  prepareInBackground?: boolean
}

type Active = {
  // Immutable snapshot; lifecycle updates replace it via immer `produce`.
  info: Info
  file: string
  size: number
  newlines: number
  duration?: number
  // Resolves with the terminal Info once the command exits, times out, or is killed. A wait
  // started after termination resolves immediately from the already-completed deferred.
  done: Deferred.Deferred<Info, NotFoundError>
  started: Deferred.Deferred<Info, AppProcess.AppProcessError>
  stalled: Deferred.Deferred<void>
  stop?: Effect.Effect<void>
  timeoutFiber?: Fiber.Fiber<void>
  timeout?: (duration: number) => Effect.Effect<void>
  // Entered native work exited without matching completion proof.
  reconciling?: boolean
}

/**
 * Location-owned non-interactive shell command process service.
 *
 * Each `create` spawns one shell command, captures combined stdout/stderr to a
 * file, and returns an ID. Clients poll `get` for status and `output` for
 * file-backed output by cursor. No session, message, or permission state lives
 * here; callers (e.g. `ShellTool`) own that association and store the shell ID.
 */
export interface Interface {
  readonly create: <E = never, R = never>(
    input: CreateInput,
    before?: (input: ShellCreateBefore) => Effect.Effect<void, E, R>,
    beforePreparation?: (input: ShellCreateBefore) => Effect.Effect<void, E, R>,
  ) => Effect.Effect<Shell.Info, E | AppProcess.AppProcessError, R>
  // Queued and running commands; terminal shells are retained for get/output.
  readonly list: () => Effect.Effect<Shell.Info[]>
  readonly get: (id: Shell.ID) => Effect.Effect<Shell.Info, NotFoundError>
  // Resolves once the command reaches a terminal status, returning its final Info. Fails with
  // NotFoundError if the command is unknown or is removed before it terminates.
  readonly wait: (id: Shell.ID) => Effect.Effect<Shell.Info, NotFoundError>
  readonly started: (id: Shell.ID) => Effect.Effect<Shell.Info, NotFoundError | AppProcess.AppProcessError>
  // Resolves once plugin preparation or native admission has kept the command waiting for STALL.
  // Local authorization and spawning never count, so slow hosts do not misreport queueing.
  readonly stalled: (id: Shell.ID) => Effect.Effect<void, NotFoundError>
  // A known shell's terminal state and bounded tail. Missing capture remains distinct from its exit status.
  readonly result: (started: Shell.Info) => Effect.Effect<ShellResult.Result>
  // Replaces the running command's timeout from now; zero clears it.
  readonly timeout: (id: Shell.ID, duration: number) => Effect.Effect<Shell.Info, NotFoundError>
  // Stop accepted work and await native cleanup without deleting its output.
  readonly kill: (id: Shell.ID) => Effect.Effect<Shell.Info, NotFoundError>
  readonly output: (id: Shell.ID, input?: Shell.OutputInput) => Effect.Effect<Shell.Output, NotFoundError>
  readonly remove: (id: Shell.ID) => Effect.Effect<void, NotFoundError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Shell") {}

export const cleanup = Effect.fn("Shell.cleanup")(function* () {
  const fs = yield* FSUtil.Service
  const global = yield* Global.Service
  const directory = path.join(global.data, DIRECTORY)
  const projects = yield* fs.readDirectoryEntries(directory).pipe(
    Effect.map((entries) => entries.filter((entry) => entry.type === "directory")),
    Effect.orElseSucceed(() => []),
  )
  const files = yield* Effect.forEach(
    projects,
    (project) =>
      fs.readDirectoryEntries(path.join(directory, project.name)).pipe(
        Effect.map((entries) =>
          entries.flatMap((entry) =>
            entry.type === "file" && /^sh_[0-9a-f]{12}.*\.out$/.test(entry.name)
              ? [path.join(directory, project.name, entry.name)]
              : [],
          ),
        ),
        Effect.orElseSucceed(() => []),
      ),
    { concurrency: 8 },
  )
  yield* FileRetention.cleanup(fs, files.flat(), RETENTION)
})

const cleanupLayer = Layer.effectDiscard(
  cleanup().pipe(Effect.repeat(Schedule.spaced(Duration.hours(1))), Effect.forkScoped),
)

const cleanupNode = makeGlobalNode({
  name: "shell-output-cleanup",
  layer: cleanupLayer,
  deps: [FSUtil.node, Global.node],
})

const layer = () =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const bus = yield* Bus.Service
      const location = yield* Location.Service
      const global = yield* Global.Service
      const shell = yield* ShellSelect.Service
      const environment = yield* Environment.Service
      const hooks = yield* PluginHooks.Service
      const environments = yield* SessionEnvironment.Service
      const config = yield* Config.Service
      const context = yield* Effect.context()
      const runFork = Effect.runForkWith(context)
      const commands = new Map<Shell.ID, Active>()
      const exitOrder: Shell.ID[] = []

      const outputDir = path.join(global.data, DIRECTORY, location.project.id)
      const { mkdir, unlink } = yield* Effect.promise(() => import("fs/promises"))
      const { createWriteStream, createReadStream } = yield* Effect.promise(() => import("fs"))
      yield* Effect.promise(() => mkdir(outputDir, { recursive: true }))

      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          for (const command of commands.values()) {
            if (command.stop) yield* command.stop
            if (command.timeoutFiber) yield* Fiber.interrupt(command.timeoutFiber)
            // Teardown interrupts pending commands; it is not a terminal command failure.
            yield* Deferred.interrupt(command.done)
          }
          commands.clear()
          exitOrder.length = 0
        }),
      )

      const require = Effect.fnUntraced(function* (id: Shell.ID) {
        const command = commands.get(id)
        if (!command) return yield* new NotFoundError({ id })
        return command
      })

      const removeCommand = Effect.fnUntraced(function* (id: Shell.ID) {
        const command = commands.get(id)
        const index = exitOrder.indexOf(id)
        if (index !== -1) exitOrder.splice(index, 1)
        if (!command) return
        commands.delete(id)
        if (command.stop) yield* command.stop
        if (command.timeoutFiber) yield* Fiber.interrupt(command.timeoutFiber)
        // Unblock any wait still pending when the command is removed before it terminated.
        yield* Deferred.fail(command.done, new NotFoundError({ id }))
        yield* Effect.promise(() => unlink(command.file).catch(() => {}))
        yield* bus.publish(Shell.Event.Deleted, { id })
      })

      const remove = Effect.fn("Shell.remove")(function* (id: Shell.ID) {
        yield* require(id)
        yield* removeCommand(id)
      })

      const list = Effect.fn("Shell.list")(function* () {
        return Array.from(commands.values())
          .filter((command) => command.info.status === "queued" || command.info.status === "running")
          .map((command) => command.info)
      })

      const get = Effect.fn("Shell.get")(function* (id: Shell.ID) {
        return (yield* require(id)).info
      })

      const kill = Effect.fn("Shell.kill")(function* (id: Shell.ID) {
        const command = yield* require(id)
        if (command.stop) yield* command.stop
        return command.info
      })

      const wait = Effect.fn("Shell.wait")(function* (id: Shell.ID) {
        return yield* Deferred.await((yield* require(id)).done)
      })

      const started = Effect.fn("Shell.started")(function* (id: Shell.ID) {
        return yield* Deferred.await((yield* require(id)).started)
      })

      const stalled = Effect.fn("Shell.stalled")(function* (id: Shell.ID) {
        return yield* Deferred.await((yield* require(id)).stalled)
      })

      const timeout = Effect.fn("Shell.timeout")(function* (id: Shell.ID, duration: number) {
        const command = yield* require(id)
        if (command.info.status === "queued") {
          command.duration = duration
          return command.info
        }
        if (command.info.status !== "running" || !command.timeout) return command.info
        yield* command.timeout(duration)
        return command.info
      })

      const output = Effect.fnUntraced(function* (id: Shell.ID, input?: Shell.OutputInput) {
        const command = yield* require(id)
        const cursor = input?.cursor ?? 0
        const limit = input?.limit ?? 65536
        if (cursor >= command.size) return { output: "", cursor: command.size, size: command.size, truncated: false }
        const start = Math.max(0, cursor)
        const length = Math.min(limit, command.size - start)
        const buffer = Buffer.alloc(length)
        const bytesRead = yield* Effect.promise(
          () =>
            new Promise<number>((resolve) => {
              const stream = createReadStream(command.file, { start, end: start + length - 1 })
              let offset = 0
              stream.on("data", (chunk: string | Buffer) => {
                const bytes = Buffer.from(chunk)
                bytes.copy(buffer, offset)
                offset += bytes.length
              })
              stream.on("end", () => resolve(offset))
              stream.on("error", () => resolve(0))
            }),
        )
        return {
          output: buffer.subarray(0, bytesRead).toString("utf8"),
          cursor: start + bytesRead,
          size: command.size,
          truncated: false,
        }
      })

      const result = Effect.fn("Shell.result")(function* (started: Shell.Info) {
        // Keep the entry: retention may evict it before this waiter resumes, and the
        // reconciliation outcome must survive that eviction.
        const command = commands.get(started.id)
        const info = yield* (command ? Deferred.await(command.done) : wait(started.id)).pipe(
          Effect.catchTag("Shell.NotFoundError", () =>
            Effect.succeed({ ...started, status: "killed" as const, time: { ...started.time, completed: Date.now() } }),
          ),
        )
        const capture = yield* Effect.gen(function* () {
          const limits = Config.latest(yield* config.entries(), "tool_output")
          const maxLines = limits?.max_lines ?? ToolOutput.MAX_LINES
          const maxBytes = limits?.max_bytes ?? ToolOutput.MAX_BYTES
          const latest = yield* output(info.id, { cursor: Number.MAX_SAFE_INTEGER })
          const page = yield* output(info.id, { cursor: Math.max(0, latest.size - maxBytes), limit: maxBytes })
          const lines = page.output.split("\n")
          if (page.output.endsWith("\n")) lines.pop()
          const truncated = latest.size > maxBytes || lines.length > maxLines
          const text = lines.length > maxLines ? lines.slice(-maxLines).join("\n") : page.output
          const total = (yield* require(info.id)).newlines + (page.output.endsWith("\n") ? 0 : 1)
          const shown = Math.min(lines.length, maxLines)
          const notice = truncated
            ? `\n\n[showing lines ${total - shown + 1}-${total} of ${total}; full output saved to ${info.file}]`
            : ""
          return { output: `${text || "(no output)"}${notice}`, truncated }
        }).pipe(Effect.catchTag("Shell.NotFoundError", () => Effect.succeed(undefined)))
        return { info, capture, ...(command?.reconciling ? { reconciling: true as const } : {}) }
      })

      const create = Effect.fn("Shell.create")(function* <E = never, R = never>(
        input: CreateInput,
        before?: (input: ShellCreateBefore) => Effect.Effect<void, E, R>,
        beforePreparation?: (input: ShellCreateBefore) => Effect.Effect<void, E, R>,
      ) {
        const sessionID = input.metadata?.sessionID
        const sessionEnvironment =
          location.workspaceID === undefined && Schema.is(SessionSchema.ID)(sessionID)
            ? yield* environments.get(sessionID)
            : undefined
        const id = input.id ?? Shell.ID.create()
        const invocation: ShellCreateBefore = {
          sessionID: Schema.is(SessionSchema.ID)(sessionID) ? sessionID : undefined,
          environment: input.environment ?? "project",
          invocationID: id,
          toolCallID: typeof input.metadata?.toolCallID === "string" ? input.metadata.toolCallID : undefined,
          command: input.command,
          cwd: input.cwd ?? location.directory,
          timeout: input.timeout ?? 0,
          shell: input.shell ?? (yield* shell.resolve({ priority: "config" })),
          env: {
            ...(sessionEnvironment ?? process.env),
            TERM: "xterm-256color",
            OPENCODE_TERMINAL: "1",
            // Only a create.before hook may opt a trusted adapter into start framing;
            // an inherited flag would hand the token to an ordinary payload.
            OPENCODE_SHELL_NOTIFY_START: undefined,
            OPENCODE_SHELL_START_TOKEN: undefined,
          },
        }
        const caller = yield* Effect.context<R>()
        const prepared = Deferred.makeUnsafe<void, E>()
        const file = path.join(outputDir, `${id}.out`)

        return yield* Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const info: Info = {
              id,
              status: "queued",
              command: invocation.command,
              cwd: invocation.cwd,
              shell: invocation.shell,
              file,
              metadata: input.metadata ?? {},
              time: { queued: Date.now() },
            }

            const command: Active = {
              info,
              file,
              size: 0,
              newlines: 0,
              done: Deferred.makeUnsafe<Info, NotFoundError>(),
              started: Deferred.makeUnsafe<Info, AppProcess.AppProcessError>(),
              stalled: Deferred.makeUnsafe<void>(),
            }
            const waiting = <A, E2, R2>(effect: Effect.Effect<A, E2, R2>) =>
              Effect.suspend(() => {
                const timer = runFork(
                  Effect.sleep(STALL).pipe(Effect.andThen(Deferred.succeed(command.stalled, undefined))),
                )
                return effect.pipe(Effect.ensuring(Fiber.interrupt(timer)))
              })
            // No yielding between duplicate detection and registration: preparation
            // can suspend, but an accepted identity must already be cancellable.
            if (commands.has(id))
              return yield* new AppProcess.AppProcessError({
                command: input.command,
                cause: new Error("Shell ID already accepted"),
              })
            if (
              [...commands.values()].filter(
                (entry) => entry.info.status === "queued" || entry.info.status === "running",
              ).length >= Job.ACTIVE_LIMIT
            )
              return yield* new AppProcess.AppProcessError({
                command: input.command,
                cause: new Job.CapacityError({ retryAfterMs: 250 }),
              })
            commands.set(id, command)
            yield* bus.publish(Shell.Event.Created, { info })

            // Spawn through the Environment and stream combined output to the file. The handle is scope-bound, so
            // the managing fiber keeps its scope open until the command terminates (it awaits `done` at the
            // end). Background callers receive the registered queued command immediately.
            const worker = runFork(
              Effect.gen(function* () {
                // Original authorization belongs to the intent, not each
                // nonaccepted attempt. Never retain a prepared environment in storage.
                if (beforePreparation)
                  yield* beforePreparation(invocation).pipe(
                    Effect.provide(caller),
                    Effect.onExit((exit) => (Exit.isFailure(exit) ? Deferred.done(prepared, exit) : Effect.void)),
                  )
                if (input.background && input.prepareInBackground) yield* Deferred.succeed(prepared, undefined)
                const requested = { ...invocation, env: { ...invocation.env } }
                const waitingSince = command.info.time.queued!
                let attempt = 0
                while (true) {
                  if (input.queueTimeout && Date.now() - waitingSince >= input.queueTimeout)
                    return yield* new AppProcess.AppProcessError({
                      command: input.command,
                      cause: new Error("Timed out waiting for native admission"),
                    })
                  const outcome = yield* Effect.scoped(
                    Effect.gen(function* () {
                      const invocation = { ...requested, env: { ...requested.env } }
                      const finished = Deferred.makeUnsafe<
                        Pick<Info, "status" | "exit" | "signal">,
                        AppProcess.AppProcessError
                      >()
                      yield* Effect.gen(function* () {
                        // Permission stays leaf-owned and precedes all project effects.
                        yield* waiting(
                          Effect.acquireUseRelease(
                            Effect.sync(() => new AbortController()),
                            (controller) =>
                              hooks
                                .trigger("shell", "create.before", { ...invocation, signal: controller.signal })
                                .pipe(
                                  Effect.tap((result) =>
                                    Effect.sync(() => {
                                      invocation.command = result.command
                                      invocation.cwd = result.cwd
                                      invocation.timeout = result.timeout
                                      invocation.shell = result.shell
                                      invocation.env = result.env
                                    }),
                                  ),
                                ),
                            (controller) => Effect.sync(() => controller.abort()),
                          ),
                        )
                        if (before) yield* before(invocation)
                        command.info = produce(command.info, (draft) => {
                          draft.command = invocation.command
                          draft.cwd = invocation.cwd
                          draft.shell = invocation.shell
                        })
                      }).pipe(
                        Effect.provide(caller),
                        Effect.onExit((exit) => Deferred.done(prepared, exit)),
                      )
                      const args = ShellSelect.args(invocation.shell, invocation.command)
                      // A trusted shell adapter may opt into a private, per-invocation
                      // start frame. Spawning that adapter is not workload admission.
                      const startToken = invocation.env.OPENCODE_SHELL_NOTIFY_START === "1" ? randomUUID() : undefined
                      invocation.env.OPENCODE_SHELL_START_TOKEN = startToken
                      const marker = startToken ? Buffer.from(`\x1e${startToken}\x1f`) : undefined
                      const backpressure = startToken ? Buffer.from(`\x1e${startToken}:backpressure:`) : undefined
                      const complete = startToken ? Buffer.from(`\x1e${startToken}:complete:`) : undefined
                      // Token-bound completion frames seen after entry; settlement requires exactly one,
                      // so at most two are retained however many arrive.
                      const completions: string[] = []
                      let retryAfterMs: number | undefined
                      const nativeStarted = Deferred.makeUnsafe<void>()
                      const handle = yield* environment.spawner
                        .spawn(
                          ChildProcess.make(invocation.shell, args, {
                            cwd: invocation.cwd,
                            env: invocation.env,
                            stdin: "ignore",
                            detached: process.platform !== "win32",
                            forceKillAfter: Duration.seconds(3),
                          }),
                        )
                        .pipe(
                          Effect.mapError(
                            (cause) => new AppProcess.AppProcessError({ command: invocation.command, cause }),
                          ),
                        )
                      const stream = createWriteStream(file, { flags: attempt++ === 0 ? "w" : "a" })
                      const outputDone = Latch.makeUnsafe()
                      let pending = Buffer.alloc(0)
                      let notified = !marker
                      const write = (chunk: Uint8Array) =>
                        Effect.callback<void, Error>((resume) => {
                          // Backpressure must reach the child: a slow output file
                          // must not turn its entire output into backend RAM.
                          stream.write(chunk, (error) => {
                            if (error) return resume(Effect.fail(error))
                            command.size += chunk.length
                            // Count while streaming so truncation notices never rescan the output file.
                            for (let index = chunk.indexOf(10); index !== -1; index = chunk.indexOf(10, index + 1))
                              command.newlines++
                            resume(Effect.void)
                          })
                        })
                      // Parse only stderr: unrelated stdout can interleave with a
                      // split control frame without corrupting the notification.
                      const capture = marker
                        ? Stream.merge(
                            handle.stdout,
                            handle.stderr.pipe(
                              Stream.mapEffect((chunk) =>
                                Effect.gen(function* () {
                                  let data = Buffer.concat([pending, chunk])
                                  pending = Buffer.alloc(0)
                                  // Proof counts only after the entry marker, never before it.
                                  let entry = 0
                                  if (!notified) {
                                    const index = data.indexOf(marker)
                                    if (index === -1) {
                                      const rejected = data.indexOf(backpressure!)
                                      const end =
                                        rejected === -1 ? -1 : data.indexOf(31, rejected + backpressure!.length)
                                      if (end !== -1) {
                                        const delay = data
                                          .subarray(rejected + backpressure!.length, end)
                                          .toString("utf8")
                                        if (/^[0-9]{1,5}$/.test(delay) && Number(delay) > 0 && Number(delay) <= 60000) {
                                          retryAfterMs = Number(delay)
                                          return Buffer.concat([data.subarray(0, rejected), data.subarray(end + 1)])
                                        }
                                      }
                                      // Retain only a possible split frame, never the whole output.
                                      const held = Math.min(data.length, backpressure!.length + 5)
                                      pending = data.subarray(data.length - held)
                                      return data.subarray(0, data.length - held)
                                    }
                                    notified = true
                                    yield* Deferred.succeed(nativeStarted, undefined)
                                    data = Buffer.concat([
                                      data.subarray(0, index),
                                      data.subarray(index + marker.length),
                                    ])
                                    entry = index
                                  }
                                  // After entry, strip completion proof (a uint32 exit code, at most ten digits).
                                  // A malformed frame is recorded so it can never settle the result.
                                  const kept: Buffer[] = []
                                  let from = 0
                                  for (let index = data.indexOf(complete!, entry); index !== -1; ) {
                                    const body = index + complete!.length
                                    const end = data.subarray(body, body + 11).indexOf(31)
                                    if (end === -1 && data.length - body < 11) {
                                      kept.push(data.subarray(from, index))
                                      pending = data.subarray(index)
                                      return Buffer.concat(kept)
                                    }
                                    if (end === -1) {
                                      if (completions.length < 2) completions.push("malformed")
                                    } else {
                                      if (completions.length < 2)
                                        completions.push(data.subarray(body, body + end).toString("utf8"))
                                      kept.push(data.subarray(from, index))
                                      from = body + end + 1
                                    }
                                    index = data.indexOf(complete!, end === -1 ? body : from)
                                  }
                                  // Hold back a trailing partial frame prefix until the next chunk.
                                  const split = data.lastIndexOf(30)
                                  const tail =
                                    split >= from &&
                                    complete!.subarray(0, data.length - split).equals(data.subarray(split))
                                      ? split
                                      : data.length
                                  kept.push(data.subarray(from, tail))
                                  pending = data.subarray(tail)
                                  return Buffer.concat(kept)
                                }),
                              ),
                            ),
                          )
                        : handle.all
                      const pump = capture.pipe(Stream.runForEach(write))
                      runFork(
                        Effect.gen(function* () {
                          yield* pump
                          yield* write(pending)
                          yield* Effect.promise(
                            () =>
                              new Promise<void>((resolve) => {
                                stream.end(() => resolve())
                              }),
                          )
                        }).pipe(
                          Effect.catch((cause) =>
                            Deferred.fail(
                              finished,
                              new AppProcess.AppProcessError({ command: invocation.command, cause }),
                            ),
                          ),
                          Effect.ensuring(outputDone.open),
                        ),
                      )
                      yield* Effect.promise(
                        () =>
                          new Promise<void>((resolve) => {
                            stream.once("open", () => resolve())
                            stream.once("error", () => resolve())
                          }),
                      )

                      let finishing = false
                      const finish = (
                        status: Info["status"],
                        exit?: number,
                        beforeWait = Effect.void,
                        signal?: string,
                      ) =>
                        Effect.gen(function* () {
                          if (finishing) return
                          finishing = true
                          yield* beforeWait
                          yield* outputDone.await
                          // This only closes the worker's native scope. Publish the
                          // terminal outcome outside that scope, after cleanup completes.
                          yield* Deferred.succeed(finished, { status, exit, signal })
                        })

                      command.timeout = (duration) =>
                        Effect.gen(function* () {
                          if (command.timeoutFiber) yield* Fiber.interrupt(command.timeoutFiber)
                          command.timeoutFiber = undefined
                          if (duration === 0 || command.info.status !== "running") return
                          command.timeoutFiber = runFork(
                            Effect.sleep(Duration.millis(duration)).pipe(
                              Effect.flatMap(() =>
                                finish(
                                  "timeout",
                                  undefined,
                                  handle
                                    .kill({ forceKillAfter: Duration.seconds(3) })
                                    .pipe(Effect.catch(() => Effect.void)),
                                ),
                              ),
                            ),
                          )
                        })

                      runFork(
                        handle.exitCode.pipe(
                          Effect.flatMap((code) => finish("exited", code)),
                          Effect.catch((error) =>
                            finish(
                              "exited",
                              undefined,
                              Effect.void,
                              error.cause instanceof CrossSpawnSpawner.KilledBySignal ? error.cause.signal : undefined,
                            ),
                          ),
                        ),
                      )

                      if (marker) {
                        const entered = Effect.raceFirst(
                          Deferred.await(nativeStarted),
                          Effect.gen(function* () {
                            const result = yield* Deferred.await(finished)
                            if (
                              result.status === "exited" &&
                              result.exit === 75 &&
                              retryAfterMs !== undefined &&
                              !(yield* Deferred.isDone(nativeStarted))
                            )
                              return retryAfterMs
                            return yield* new AppProcess.AppProcessError({
                              command: invocation.command,
                              cause: new Error("Shell adapter exited before native admission"),
                            })
                          }),
                        )
                        const retry = yield* waiting(
                          !input.queueTimeout
                            ? entered
                            : entered.pipe(
                                Effect.timeoutOrElse({
                                  duration: Duration.millis(
                                    Math.max(0, input.queueTimeout - (Date.now() - waitingSince)),
                                  ),
                                  orElse: () =>
                                    Effect.fail(
                                      new AppProcess.AppProcessError({
                                        command: invocation.command,
                                        cause: new Error("Timed out waiting for native admission"),
                                      }),
                                    ),
                                }),
                              ),
                        )
                        if (retry !== undefined) return { retryAfterMs: retry }
                      }
                      command.info = produce(command.info, (draft) => {
                        draft.status = "running"
                        draft.pid = handle.pid
                        draft.time.started = Date.now()
                      })
                      yield* command.timeout(command.duration ?? invocation.timeout)
                      yield* bus.publish(Shell.Event.Started, { info: command.info })
                      yield* Deferred.succeed(command.started, command.info)
                      // Hold the handle's scope open until the command terminates; closing it earlier would
                      // release (kill) the process before its exit is observed.
                      const final = yield* Deferred.await(finished).pipe(
                        // A capture failure after entry leaves the workload outcome unknown.
                        Effect.tapError(() =>
                          Effect.sync(() => {
                            if (marker) command.reconciling = true
                          }),
                        ),
                      )
                      // An adapter exit is not workload evidence: an entered exit settles only
                      // with exactly one token-bound completion proof for the same code.
                      if (
                        marker &&
                        final.status === "exited" &&
                        // Canonical decimal only: the proof must name exactly this exit code.
                        !(completions.length === 1 && final.exit !== undefined && completions[0] === String(final.exit))
                      ) {
                        command.reconciling = true
                        return {
                          ...command.info,
                          status: "failed" as const,
                          ...(final.signal !== undefined ? { signal: final.signal } : {}),
                          error: `${RECONCILING} Adapter ${final.exit !== undefined ? `exit ${final.exit}` : `signal ${final.signal ?? "unknown"}`}, completion proof ${completions.length === 0 ? "missing" : completions.slice(0, 3).join(",")}.`,
                        }
                      }
                      return { ...command.info, ...final }
                    }),
                  )
                  if (outcome.retryAfterMs === undefined) return outcome
                  command.timeout = undefined
                  // The native scope and its output pump have closed. This is
                  // typed nonacceptance, never a retry of a possibly entered payload.
                  // Backoff after typed nonacceptance is still a native admission wait.
                  yield* waiting(
                    Effect.sleep(
                      Duration.millis(
                        input.queueTimeout
                          ? Math.min(
                              outcome.retryAfterMs,
                              Math.max(0, input.queueTimeout - (Date.now() - waitingSince)),
                            )
                          : outcome.retryAfterMs,
                      ),
                    ),
                  )
                }
              }).pipe(
                Effect.onExit((exit) =>
                  Effect.gen(function* () {
                    command.info = produce(Exit.isSuccess(exit) ? exit.value : command.info, (draft) => {
                      if (Exit.isFailure(exit)) {
                        draft.status = Cause.hasInterruptsOnly(exit.cause) ? "killed" : "failed"
                        draft.error = Cause.pretty(exit.cause)
                      }
                      draft.time.completed = Date.now()
                    })
                    if (Exit.isFailure(exit))
                      yield* Deferred.failCause(
                        command.started,
                        Cause.map(exit.cause, (cause) =>
                          cause instanceof AppProcess.AppProcessError
                            ? cause
                            : new AppProcess.AppProcessError({ command: invocation.command, cause }),
                        ),
                      )
                    if (commands.get(id) !== command) return
                    command.stop = undefined
                    command.timeout = undefined
                    if (command.timeoutFiber) yield* Fiber.interrupt(command.timeoutFiber)
                    command.timeoutFiber = undefined
                    yield* Deferred.succeed(command.done, command.info)
                    yield* bus.publish(Shell.Event.Exited, {
                      id,
                      status: command.info.status,
                      ...(command.info.exit !== undefined ? { exit: command.info.exit } : {}),
                    })
                    exitOrder.push(id)
                    while (exitOrder.length > EXITED_LIMIT) {
                      const oldest = exitOrder[0]
                      if (!oldest) break
                      yield* removeCommand(oldest)
                    }
                  }),
                ),
                Effect.ignore,
              ),
            )
            command.stop = Fiber.interrupt(worker).pipe(Effect.asVoid)

            // Foreground callbacks retain synchronous preparation errors. Explicit
            // background jobs acknowledge after original authorization instead.
            if (input.background && !before && !beforePreparation) return command.info
            return yield* restore(Deferred.await(prepared)).pipe(
              Effect.onError(() => removeCommand(id)),
              Effect.andThen(
                input.background ? Effect.sync(() => command.info) : restore(Deferred.await(command.started)),
              ),
              Effect.onInterrupt(() => removeCommand(id)),
            )
          }),
        )
      })

      return Service.of({ create, list, get, wait, started, stalled, result, timeout, kill, output, remove })
    }),
  )

export const node = makeLocationNode({
  service: Service,
  layer: layer(),
  deps: [
    Bus.node,
    Location.node,
    Global.node,
    ShellSelect.node,
    Environment.node,
    PluginHooks.node,
    SessionEnvironment.node,
    Config.node,
    cleanupNode,
  ],
})
