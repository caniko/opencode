export * as BrowserHost from "./host.js"

import { spawn } from "node:child_process"
import type { Session } from "@opencode/schema/session"
import { Tool } from "@opencode/schema/tool"
import { Effect, Option, Schema } from "effect"
import { Browser } from "./rpc.js"

const method = Schema.Literals(Browser.Operations.map((operation) => operation.name))
export const Options = Schema.Struct({
  command: Schema.Array(Schema.String).check(Schema.isMinLength(1)),
  operations: Schema.Array(method).check(Schema.isMinLength(1)),
})
export type Options = typeof Options.Type

const ready = Schema.Struct({
  type: Schema.Literal("ready"),
  version: Schema.Literal(1),
  operations: Schema.Array(method),
})
const response = Schema.Struct({ id: Schema.String, outcome: Browser.Outcome })
const message = Schema.fromJsonString(Schema.Union([ready, response]))
const maxBytes = 8 * 1024 * 1024

export async function start(options: Options, directory: string, signal?: AbortSignal) {
  const child = spawn(options.command[0]!, options.command.slice(1), {
    cwd: directory,
    stdio: ["pipe", "pipe", "pipe"],
  })
  const readiness = Promise.withResolvers<void>()
  const pending = new Map<string, ReturnType<typeof Promise.withResolvers<Browser.Result>>>()
  let buffer = ""
  let diagnostic = ""
  let connected = false
  let failure: Error | undefined
  const fail = (error: Error) => {
    failure = error
    readiness.reject(error)
    pending.forEach((entry) => entry.reject(error))
    pending.clear()
  }
  child.on("error", fail)
  child.stderr.setEncoding("utf8")
  child.stderr.on("data", (chunk: string) => {
    diagnostic = (diagnostic + chunk).slice(-2048)
  })
  child.on("exit", () =>
    fail(
      new Error(
        connected
          ? "Browser host disconnected; an action may already have run. Call browser.tabs.list for a fresh connection before retrying."
          : `Browser host exited before readiness: ${diagnostic || "no startup diagnostic"}`,
      ),
    ),
  )
  child.stdout.setEncoding("utf8")
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk
    if (Buffer.byteLength(buffer) > maxBytes) {
      fail(new Error("Browser host response exceeds 8 MiB"))
      child.kill("SIGTERM")
      return
    }
    for (;;) {
      const newline = buffer.indexOf("\n")
      if (newline < 0) return
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      const decoded = Schema.decodeUnknownOption(message)(line)
      if (Option.isNone(decoded)) {
        fail(new Error("Browser host returned an invalid protocol message"))
        child.kill("SIGTERM")
        return
      }
      const value = decoded.value
      if ("type" in value) {
        if (
          connected ||
          !value.operations.includes("tabs.list") ||
          !options.operations.every((operation) => value.operations.includes(operation))
        ) {
          fail(new Error("Browser host capabilities do not match configured operations"))
          child.kill("SIGTERM")
          return
        }
        connected = true
        readiness.resolve()
        continue
      }
      const entry = pending.get(value.id)
      if (!entry) continue
      pending.delete(value.id)
      if (value.outcome.type === "failure") {
        entry.reject(new Error(`[browser.${value.outcome.code}] ${value.outcome.message}`))
        continue
      }
      entry.resolve(value.outcome.result)
    }
  })
  const close = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()))
    child.kill("SIGTERM")
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000)
    await exited
    clearTimeout(timer)
  }
  const timeout = setTimeout(() => {
    fail(new Error("Browser host did not become ready within 45 seconds"))
    child.kill("SIGTERM")
  }, 45000)
  const abort = () => {
    fail(new Error("Browser host connection cancelled."))
    child.kill("SIGTERM")
  }
  signal?.addEventListener("abort", abort, { once: true })
  if (signal?.aborted) abort()
  await readiness.promise
    .catch(async (error) => {
      await close()
      throw error
    })
    .finally(() => {
      clearTimeout(timeout)
      signal?.removeEventListener("abort", abort)
    })
  return {
    close,
    get disconnected() {
      return failure !== undefined
    },
    request(command: Browser.Command, signal: AbortSignal) {
      if (failure) return Promise.reject(failure)
      const id = crypto.randomUUID()
      const entry = Promise.withResolvers<Browser.Result>()
      pending.set(id, entry)
      const cancel = () => {
        fail(new Error("Browser action cancelled; its outcome is unknown. Inspect before retrying."))
        void close()
      }
      signal.addEventListener("abort", cancel, { once: true })
      const timer = setTimeout(cancel, 60000)
      const encoded = JSON.stringify({ id, command: Schema.encodeSync(Browser.Command)(command) }) + "\n"
      if (Buffer.byteLength(encoded) > maxBytes) {
        pending.delete(id)
        entry.reject(new Error("Browser host command exceeds 8 MiB"))
      } else if (signal.aborted) cancel()
      else
        child.stdin.write(encoded, (error) => {
          if (error) fail(error)
        })
      return entry.promise.finally(() => {
        clearTimeout(timer)
        signal.removeEventListener("abort", cancel)
      })
    },
  }
}

export const make = Effect.fn("BrowserHost.make")(function* (options: Options, directory: string) {
  const hosts = new Map<Session.ID, Promise<Awaited<ReturnType<typeof start>>>>()
  const close = (sessionID: Session.ID) =>
    Effect.promise(async () => {
      const host = hosts.get(sessionID)
      hosts.delete(sessionID)
      await host?.then((host) => host.close()).catch(() => {})
    })
  yield* Effect.addFinalizer(() => Effect.forEach(hosts.keys(), close, { discard: true }))
  return {
    close,
    target: Effect.fn("BrowserHost.target")(function* (sessionID: Session.ID, action: Browser.Action) {
      if (!options.operations.includes(action.type))
        return yield* new Tool.Error({
          message: `The configured browser host does not implement browser.${action.type}.`,
        })
      const host = yield* Effect.tryPromise({
        try: async (signal) => {
          const existing = hosts.get(sessionID)
          if (existing) {
            const host = await existing
            if (!host.disconnected || action.type !== "tabs.list") return host
            await host.close()
          }
          const created = start(options, directory, signal)
          hosts.set(sessionID, created)
          return created.catch((error) => {
            if (hosts.get(sessionID) === created) hosts.delete(sessionID)
            throw error
          })
        },
        catch: (error) =>
          new Tool.Error({
            message:
              error instanceof Error
                ? error.message
                : "Could not connect the default browser host. Check the configured browser and WebDriver.",
            error,
          }),
      })
      const request = (command: Browser.Command) =>
        Effect.tryPromise({
          try: (signal) => host.request(command, signal),
          catch: (error) =>
            new Tool.Error({ message: error instanceof Error ? error.message : "Browser host request failed.", error }),
        })
      const inventory = yield* request({ action: { type: "tabs.list" }, files: [] }).pipe(
        Effect.flatMap((result) => Schema.decodeUnknownEffect(Browser.State)(result.value)),
        Effect.mapError((error) => new Tool.Error({ message: "Browser host returned invalid tab inventory.", error })),
      )
      const tab = "tabID" in action ? inventory.tabs.find((tab) => tab.id === action.tabID) : undefined
      if ("tabID" in action && !tab)
        return yield* new Tool.Error({
          message: "Tab does not belong to this session. Call browser.tabs.list and use an exact returned tabID.",
        })
      return {
        tab,
        inspect: () =>
          request({ action, files: [], inspect: true }).pipe(
            Effect.flatMap((result) => Schema.decodeUnknownEffect(Browser.Target)(result.value)),
            Effect.mapError(
              (error) => new Tool.Error({ message: "Browser host returned invalid target metadata.", error }),
            ),
          ),
        request: (files: readonly Browser.File[], target?: Browser.Target) =>
          request({ action, files, ...(tab ? { generation: tab.generation } : {}), ...(target ? { target } : {}) }),
      }
    }),
  }
})
