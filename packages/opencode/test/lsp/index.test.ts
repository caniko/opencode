import { describe, expect, spyOn } from "bun:test"
import { mkdtemp, writeFile, chmod, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "path"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Deferred, Effect, Fiber, Layer } from "effect"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Plugin } from "@/plugin"
import { LSP } from "@/lsp/lsp"
import * as LSPServer from "@/lsp/server"
import { LANGUAGE_EXTENSIONS } from "@/lsp/language"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { TestInstance } from "../fixture/fixture"
import { awaitWithTimeout, testEffect } from "../lib/effect"

const lspLayer = (flags: Parameters<typeof RuntimeFlags.layer>[0] = {}) =>
  LayerNode.compile(LayerNode.group([LSP.node, Config.node, RuntimeFlags.node, EventV2Bridge.node]), [
    [RuntimeFlags.node, RuntimeFlags.layer(flags)],
  ])

const it = testEffect(Layer.mergeAll(lspLayer(), LayerNode.compile(CrossSpawnSpawner.node)))
const experimentalTyIt = testEffect(
  Layer.mergeAll(lspLayer({ experimentalLspTy: true }), LayerNode.compile(CrossSpawnSpawner.node)),
)
const fakeServerPath = path.join(__dirname, "../fixture/lsp/fake-lsp-server.js")
const disabledDownloadIt = testEffect(
  Layer.mergeAll(lspLayer({ disableLspDownload: true }), LayerNode.compile(CrossSpawnSpawner.node)),
)
// Stand-in for an approved project environment. The hook reads the stub
// directory from PKL_STUB_DIR at trigger time so each test can point it at a
// fresh stub without rebuilding the layer. PKL_HOOK_MODE selects the contract:
// "replace" (default) resolves to exactly the hook env; "overlay" merges the
// hook env over the inherited snapshot after removals.
const projectEnvPlugin = {
  trigger: ((name: string, _input: any, output: any) => {
    if (name === "lsp.env") {
      const stubDir = process.env.PKL_STUB_DIR
      const overlay = { PATH: `${stubDir}:${output.env.PATH ?? ""}`, LSP_OVERLAY_PROBE: "yes" }
      if (process.env.PKL_HOOK_MODE === "overlay") {
        output.env = stubDir ? overlay : {}
      } else {
        output.env = stubDir ? { PATH: `${stubDir}:${output.env.PATH ?? ""}` } : {}
        output.replace = true
      }
    }
    return Effect.succeed(output)
  }) as Plugin.Interface["trigger"],
  list: () => Effect.succeed([]),
  init: () => Effect.void,
}
const itProjectEnv = testEffect(
  Layer.mergeAll(lspLayer(), LayerNode.compile(CrossSpawnSpawner.node), Layer.succeed(Plugin.Service, projectEnvPlugin)),
)
// A stub pkl-lsp that records its spawn environment, answers the LSP
// handshake, and stays alive until shutdown. Every real-spawn test uses it
// so client creation never hangs. `tag` identifies the stub in hover results,
// `delayMs` postpones the initialize answer to force handshake races.
const stubServer = (marker: string, tag = "pkl-stub", delayMs = 0) =>
  `#!${process.execPath}
const fs = require("node:fs")
fs.writeFileSync(${JSON.stringify(marker)},
  "argv=" + process.argv.slice(2).join(" ") + "\\n" +
  "secret=" + (process.env.LSP_PROBE_SECRET ?? "absent") + "\\n" +
  "overlay=" + (process.env.LSP_OVERLAY_PROBE ?? "absent") + "\\n")
const DELAY = ${JSON.stringify(delayMs)}
let buf = Buffer.alloc(0)
const send = (m) => {
  const json = JSON.stringify(m)
  process.stdout.write("Content-Length: " + Buffer.byteLength(json) + "\\r\\n\\r\\n" + json)
}
process.stdin.on("data", (chunk) => {
  buf = Buffer.concat([buf, chunk])
  for (;;) {
    const idx = buf.indexOf("\\r\\n\\r\\n")
    if (idx === -1) return
    const len = parseInt(/Content-Length:\\s*(\\d+)/i.exec(buf.slice(0, idx).toString())?.[1] ?? "0", 10)
    if (buf.length < idx + 4 + len) return
    const msg = JSON.parse(buf.slice(idx + 4, idx + 4 + len).toString())
    buf = buf.slice(idx + 4 + len)
    if (msg.method === "initialize") {
      const reply = () => send({ jsonrpc: "2.0", id: msg.id, result: { capabilities: { hoverProvider: true } } })
      if (DELAY > 0) setTimeout(reply, DELAY)
      else reply()
    }
    else if (msg.method === "textDocument/hover") send({ jsonrpc: "2.0", id: msg.id, result: { contents: ${JSON.stringify(tag + "-hover")} } })
    else if (msg.method === "shutdown") send({ jsonrpc: "2.0", id: msg.id, result: null })
    else if (msg.method === "exit") process.exit(0)
  }
})
`
const writeStub = (stubDir: string, marker: string, tag = "pkl-stub", delayMs = 0, binName = "pkl-lsp") =>
  Effect.promise(() => {
    const stubPath = path.join(stubDir, binName)
    return writeFile(stubPath, stubServer(marker, tag, delayMs)).then(() => chmod(stubPath, 0o755))
  })
const denyingPlugin = {
  trigger: ((_name: string, _input: any, _output: any) =>
    Effect.fail(new Error("not authorized"))) as unknown as Plugin.Interface["trigger"],
  list: () => Effect.succeed([]),
  init: () => Effect.void,
}
const itDeniedEnv = testEffect(
  Layer.mergeAll(lspLayer(), LayerNode.compile(CrossSpawnSpawner.node), Layer.succeed(Plugin.Service, denyingPlugin)),
)

describe("lsp.spawn", () => {
  it.effect("maps PKL files to the pkl language id", () =>
    Effect.sync(() => {
      expect(LANGUAGE_EXTENSIONS[".pkl"]).toBe("pkl")
    }),
  )

  it.instance(
    "does not spawn builtin LSP for files outside instance",
    () =>
      LSP.Service.use((lsp) =>
        Effect.gen(function* () {
          const dir = (yield* TestInstance).directory
          const spy = spyOn(LSPServer.Typescript, "spawn").mockResolvedValue(undefined)

          try {
            yield* lsp.touchFile(path.join(dir, "..", "outside.ts"))
            yield* lsp.hover({
              file: path.join(dir, "..", "hover.ts"),
              line: 0,
              character: 0,
            })
            expect(spy).toHaveBeenCalledTimes(0)
          } finally {
            spy.mockRestore()
          }
        }),
      ),
    { config: { lsp: true } },
  )

  it.instance("does not spawn builtin LSP for files inside instance when LSP is unset", () =>
    LSP.Service.use((lsp) =>
      Effect.gen(function* () {
        const dir = (yield* TestInstance).directory
        const spy = spyOn(LSPServer.Typescript, "spawn").mockResolvedValue(undefined)

        try {
          yield* lsp.hover({
            file: path.join(dir, "src", "inside.ts"),
            line: 0,
            character: 0,
          })
          expect(spy).toHaveBeenCalledTimes(0)
        } finally {
          spy.mockRestore()
        }
      }),
    ),
  )

  it.instance(
    "would spawn builtin LSP for files inside instance when lsp is true",
    () =>
      LSP.Service.use((lsp) =>
        Effect.gen(function* () {
          const dir = (yield* TestInstance).directory
          const spy = spyOn(LSPServer.Typescript, "spawn").mockResolvedValue(undefined)

          try {
            yield* lsp.hover({
              file: path.join(dir, "src", "inside.ts"),
              line: 0,
              character: 0,
            })
            expect(spy).toHaveBeenCalledTimes(1)
          } finally {
            spy.mockRestore()
          }
        }),
      ),
    { config: { lsp: true } },
  )

  it.instance(
    "publishes lsp.updated after custom LSP initialization",
    () =>
      Effect.gen(function* () {
        const dir = (yield* TestInstance).directory
        const lsp = yield* LSP.Service
        const updated = yield* Deferred.make<void>()
        const events = yield* EventV2Bridge.Service
        const unsubscribe = yield* events.listen((event) => {
          if (event.type === LSP.Event.Updated.type) Deferred.doneUnsafe(updated, Effect.void)
          return Effect.void
        })
        yield* Effect.addFinalizer(() => unsubscribe)

        const file = path.join(dir, "sample.repro")
        yield* Effect.promise(() => Bun.write(file, "sample\n"))
        yield* lsp.touchFile(file)
        yield* awaitWithTimeout(Deferred.await(updated), "lsp.updated event was not published")
      }),
    {
      config: {
        lsp: {
          fake: {
            command: [process.execPath, fakeServerPath],
            extensions: [".repro"],
          },
        },
      },
    },
  )

  it.instance(
    "would spawn builtin LSP for files inside instance when config object is provided",
    () =>
      LSP.Service.use((lsp) =>
        Effect.gen(function* () {
          const dir = (yield* TestInstance).directory
          const spy = spyOn(LSPServer.Typescript, "spawn").mockResolvedValue(undefined)

          try {
            yield* lsp.hover({
              file: path.join(dir, "src", "inside.ts"),
              line: 0,
              character: 0,
            })
            expect(spy).toHaveBeenCalledTimes(1)
          } finally {
            spy.mockRestore()
          }
        }),
      ),
    {
      config: {
        lsp: {
          eslint: { disabled: true },
        },
      },
    },
  )

  it.instance(
    "uses pyright instead of ty by default",
    () =>
      LSP.Service.use((lsp) =>
        Effect.gen(function* () {
          const dir = (yield* TestInstance).directory
          const ty = spyOn(LSPServer.Ty, "spawn").mockResolvedValue(undefined)
          const pyright = spyOn(LSPServer.Pyright, "spawn").mockResolvedValue(undefined)

          try {
            yield* lsp.hover({
              file: path.join(dir, "src", "inside.py"),
              line: 0,
              character: 0,
            })
            expect(ty).toHaveBeenCalledTimes(0)
            expect(pyright).toHaveBeenCalledTimes(1)
          } finally {
            ty.mockRestore()
            pyright.mockRestore()
          }
        }),
      ),
    { config: { lsp: true } },
  )

  experimentalTyIt.instance(
    "uses ty instead of pyright when experimentalLspTy is enabled",
    () =>
      LSP.Service.use((lsp) =>
        Effect.gen(function* () {
          const dir = (yield* TestInstance).directory
          const ty = spyOn(LSPServer.Ty, "spawn").mockResolvedValue(undefined)
          const pyright = spyOn(LSPServer.Pyright, "spawn").mockResolvedValue(undefined)

          try {
            yield* lsp.hover({
              file: path.join(dir, "src", "inside.py"),
              line: 0,
              character: 0,
            })
            expect(ty).toHaveBeenCalledTimes(1)
            expect(pyright).toHaveBeenCalledTimes(0)
          } finally {
            ty.mockRestore()
            pyright.mockRestore()
          }
        }),
      ),
    { config: { lsp: true } },
  )

  disabledDownloadIt.instance(
    "passes disableLspDownload to builtin LSP spawn",
    () =>
      LSP.Service.use((lsp) =>
        Effect.gen(function* () {
          const dir = (yield* TestInstance).directory
          const pyright = spyOn(LSPServer.Pyright, "spawn").mockResolvedValue(undefined)

          try {
            yield* lsp.hover({
              file: path.join(dir, "src", "inside.py"),
              line: 0,
              character: 0,
            })
            expect(pyright).toHaveBeenCalledTimes(1)
            expect(pyright.mock.calls[0]?.[2]).toMatchObject({ disableLspDownload: true })
          } finally {
            pyright.mockRestore()
          }
        }),
      ),
    { config: { lsp: true } },
  )

  it.instance(
    "would spawn builtin PKL LSP for PKL files when lsp is true",
    () =>
      LSP.Service.use((lsp) =>
        Effect.gen(function* () {
          const dir = (yield* TestInstance).directory
          const spy = spyOn(LSPServer.Pkl, "spawn").mockResolvedValue(undefined)

          try {
            yield* lsp.hover({
              file: path.join(dir, "config.pkl"),
              line: 0,
              character: 0,
            })
            expect(spy).toHaveBeenCalledTimes(1)
          } finally {
            spy.mockRestore()
          }
        }),
      ),
    { config: { lsp: true } },
  )

  it.instance(
    "passes resolved project environment to builtin spawn",
    () =>
      LSP.Service.use((lsp) =>
        Effect.gen(function* () {
          const dir = (yield* TestInstance).directory
          const spy = spyOn(LSPServer.Pkl, "spawn").mockResolvedValue(undefined)

          try {
            yield* lsp.hover(
              {
                file: path.join(dir, "config.pkl"),
                line: 0,
                character: 0,
              },
              "test-session",
            )
            expect(spy).toHaveBeenCalledTimes(1)
            const env = spy.mock.calls[0]?.[3] as NodeJS.ProcessEnv | undefined
            expect(env).toBeDefined()
            expect(typeof (env?.PATH ?? env?.Path)).toBe("string")
          } finally {
            spy.mockRestore()
          }
        }),
      ),
    { config: { lsp: true } },
  )

  it.instance(
    "never reuses one session's server for another",
    () =>
      LSP.Service.use((lsp) =>
        Effect.gen(function* () {
          const dir = (yield* TestInstance).directory
          const spy = spyOn(LSPServer.Pkl, "spawn").mockResolvedValue(undefined)

          try {
            const file = {
              file: path.join(dir, "config.pkl"),
              line: 0,
              character: 0,
            }
            yield* lsp.hover(file, "session-a")
            yield* lsp.hover(file, "session-a")
            expect(spy).toHaveBeenCalledTimes(1)
            yield* lsp.hover(file, "session-b")
            expect(spy).toHaveBeenCalledTimes(2)
          } finally {
            spy.mockRestore()
          }
        }),
      ),
    { config: { lsp: true } },
  )

  itProjectEnv.instance(
    "spawns project-provided pkl-lsp through the resolved environment",
    () =>
      LSP.Service.use((lsp) =>
        Effect.gen(function* () {
          const dir = (yield* TestInstance).directory
          // Stand-in for an approved project environment: a stub pkl-lsp that
          // is only visible through the resolved PATH, never the baseline.
          const stubDir = yield* Effect.promise(() => mkdtemp(path.join(tmpdir(), "pkl-stub-")))
          const marker = path.join(stubDir, "spawned.txt")
          const stub = `#!${process.execPath}
const fs = require("node:fs")
fs.writeFileSync(${JSON.stringify(marker)},
  "argv=" + process.argv.slice(2).join(" ") + "\\n" +
  "secret=" + (process.env.LSP_PROBE_SECRET ?? "absent") + "\\n" +
  "overlay=" + (process.env.LSP_OVERLAY_PROBE ?? "absent") + "\\n")
let buf = Buffer.alloc(0)
const send = (m) => {
  const json = JSON.stringify(m)
  process.stdout.write("Content-Length: " + Buffer.byteLength(json) + "\\r\\n\\r\\n" + json)
}
process.stdin.on("data", (chunk) => {
  buf = Buffer.concat([buf, chunk])
  for (;;) {
    const idx = buf.indexOf("\\r\\n\\r\\n")
    if (idx === -1) return
    const len = parseInt(/Content-Length:\\s*(\\d+)/i.exec(buf.slice(0, idx).toString())?.[1] ?? "0", 10)
    if (buf.length < idx + 4 + len) return
    const msg = JSON.parse(buf.slice(idx + 4, idx + 4 + len).toString())
    buf = buf.slice(idx + 4 + len)
    if (msg.method === "initialize") send({ jsonrpc: "2.0", id: msg.id, result: { capabilities: { hoverProvider: true } } })
    else if (msg.method === "textDocument/hover") send({ jsonrpc: "2.0", id: msg.id, result: { contents: "pkl-stub-hover" } })
    else if (msg.method === "shutdown") send({ jsonrpc: "2.0", id: msg.id, result: null })
    else if (msg.method === "exit") process.exit(0)
  }
})
`
          const stubPath = path.join(stubDir, "pkl-lsp")
          yield* Effect.promise(() => writeFile(stubPath, stub).then(() => chmod(stubPath, 0o755)))
          process.env.PKL_STUB_DIR = stubDir
          try {
            const result = yield* lsp.hover(
              {
                file: path.join(dir, "config.pkl"),
                line: 0,
                character: 0,
              },
              "stub-session",
            )
            const seen = yield* Effect.promise(() => readFile(marker, "utf8").catch(() => ""))
            expect(seen).toContain("argv=--stdio")
            expect(JSON.stringify(result)).toContain("pkl-stub-hover")
          } finally {
            delete process.env.PKL_STUB_DIR
          }
        }),
      ),
    { config: { lsp: true } },
  )

  itProjectEnv.instance(
    "retires the client when the resolved environment changes",
    () =>
      LSP.Service.use((lsp) =>
        Effect.gen(function* () {
          const dir = (yield* TestInstance).directory
          const file = { file: path.join(dir, "config.pkl"), line: 0, character: 0 }
          const makeStub = (tag: string) =>
            Effect.promise(async () => {
              const stubDir = await mkdtemp(path.join(tmpdir(), `pkl-${tag}-`))
              const marker = path.join(stubDir, "spawned.txt")
              const stubPath = path.join(stubDir, "pkl-lsp")
              await writeFile(stubPath, stubServer(marker, `${tag}-stub`)).then(() => chmod(stubPath, 0o755))
              return { stubDir, marker }
            })
          // Phase one: select shell A.
          const a = yield* makeStub("a")
          process.env.PKL_STUB_DIR = a.stubDir
          try {
            const first = yield* lsp.hover(file, "reselect-session")
            expect(JSON.stringify(first)).toContain("a-stub-hover")
            const seenA = yield* Effect.promise(() => readFile(a.marker, "utf8").catch(() => ""))
            expect(seenA).toContain("argv=--stdio")
            expect(yield* lsp.status("reselect-session")).toHaveLength(1)
            // Phase two: reselect shell B. The stale client must not be reused.
            const b = yield* makeStub("fast")
            process.env.PKL_STUB_DIR = b.stubDir
            const second = yield* lsp.hover(file, "reselect-session")
            expect(JSON.stringify(second)).toContain("fast-stub-hover")
            const seenB = yield* Effect.promise(() => readFile(b.marker, "utf8").catch(() => ""))
            expect(seenB).toContain("argv=--stdio")
            expect(yield* lsp.status("reselect-session")).toHaveLength(1)
          } finally {
            delete process.env.PKL_STUB_DIR
          }
        }),
      ),
    { config: { lsp: true } },
  )

  itProjectEnv.instance(
    "a later selection heals a previously failed lookup",
    () =>
      LSP.Service.use((lsp) =>
        Effect.gen(function* () {
          const dir = (yield* TestInstance).directory
          const file = { file: path.join(dir, "config.pkl"), line: 0, character: 0 }
          const spy = spyOn(LSPServer.Pkl, "spawn")
          try {
            // No selection: the Pkl server is registered, but the baseline
            // PATH has no pkl-lsp binary, so the spawn fails.
            // The tool path probes availability first, so assert through it.
            delete process.env.PKL_STUB_DIR
            expect(yield* lsp.hasClients(file.file, "heal-session")).toBe(true)
            yield* lsp.hover(file, "heal-session").pipe(Effect.catch(() => Effect.succeed([])))
            expect(spy).toHaveBeenCalledTimes(1)
            // Select a shell providing pkl-lsp: the probe recovers first,
            // then the same session retries the spawn.
            const stubDir = yield* Effect.promise(() => mkdtemp(path.join(tmpdir(), "pkl-heal-")))
            const marker = path.join(stubDir, "spawned.txt")
            yield* writeStub(stubDir, marker)
            process.env.PKL_STUB_DIR = stubDir
            try {
              expect(yield* lsp.hasClients(file.file, "heal-session")).toBe(true)
              const healed = yield* lsp.hover(file, "heal-session")
              expect(spy).toHaveBeenCalledTimes(2)
              expect(JSON.stringify(healed)).toContain("pkl-stub-hover")
              const seen = yield* Effect.promise(() => readFile(marker, "utf8").catch(() => ""))
              expect(seen).toContain("argv=--stdio")
            } finally {
              delete process.env.PKL_STUB_DIR
            }
          } finally {
            spy.mockRestore()
          }
        }),
      ),
    { config: { lsp: true } },
  )

  itProjectEnv.instance(
    "replaced environments do not leak backend-only variables",
    () =>
      LSP.Service.use((lsp) =>
        Effect.gen(function* () {
          const dir = (yield* TestInstance).directory
          const stubDir = yield* Effect.promise(() => mkdtemp(path.join(tmpdir(), "pkl-noleak-")))
          const marker = path.join(stubDir, "spawned.txt")
          yield* writeStub(stubDir, marker)
          process.env.PKL_STUB_DIR = stubDir
          process.env.LSP_PROBE_SECRET = "backend-only"
          try {
            yield* lsp.hover({ file: path.join(dir, "config.pkl"), line: 0, character: 0 }, "noleak-session").pipe(
              Effect.catch(() => Effect.succeed([])),
            )
            const seen = yield* Effect.promise(() => readFile(marker, "utf8").catch(() => ""))
            expect(seen).toContain("secret=absent")
          } finally {
            delete process.env.PKL_STUB_DIR
            delete process.env.LSP_PROBE_SECRET
          }
        }),
      ),
    { config: { lsp: true } },
  )

  itProjectEnv.instance(
    "overlay environments merge over the inherited snapshot",
    () =>
      LSP.Service.use((lsp) =>
        Effect.gen(function* () {
          const dir = (yield* TestInstance).directory
          const stubDir = yield* Effect.promise(() => mkdtemp(path.join(tmpdir(), "pkl-overlay-")))
          const marker = path.join(stubDir, "spawned.txt")
          yield* writeStub(stubDir, marker)
          process.env.PKL_STUB_DIR = stubDir
          process.env.PKL_HOOK_MODE = "overlay"
          try {
            yield* lsp.hover({ file: path.join(dir, "config.pkl"), line: 0, character: 0 }, "overlay-session").pipe(
              Effect.catch(() => Effect.succeed([])),
            )
            const seen = yield* Effect.promise(() => readFile(marker, "utf8").catch(() => ""))
            expect(seen).toContain("overlay=yes")
          } finally {
            delete process.env.PKL_STUB_DIR
            delete process.env.PKL_HOOK_MODE
          }
        }),
      ),
    { config: { lsp: true } },
  )

  itDeniedEnv.instance(
    "a rejected environment fails the operation without spawning",
    () =>
      LSP.Service.use((lsp) =>
        Effect.gen(function* () {
          const dir = (yield* TestInstance).directory
          const spy = spyOn(LSPServer.Pkl, "spawn").mockResolvedValue(undefined)
          try {
            const exit = yield* lsp
              .hover({ file: path.join(dir, "config.pkl"), line: 0, character: 0 }, "denied-session")
              .pipe(Effect.exit)
            expect(exit._tag).toBe("Failure")
            expect(spy).toHaveBeenCalledTimes(0)
          } finally {
            spy.mockRestore()
          }
        }),
      ),
    { config: { lsp: true } },
  )

  it.instance(
    "releaseSession drops the session clients without respawn",
    () =>
      LSP.Service.use((lsp) =>
        Effect.gen(function* () {
          const dir = (yield* TestInstance).directory
          const spy = spyOn(LSPServer.Pkl, "spawn").mockResolvedValue(undefined)
          try {
            const file = { file: path.join(dir, "config.pkl"), line: 0, character: 0 }
            yield* lsp.hover(file, "doomed-session")
            expect(spy).toHaveBeenCalledTimes(1)
            yield* lsp.releaseSession("doomed-session")
            expect(yield* lsp.status("doomed-session")).toEqual([])
            // A released session is dead: no client is ever spawned for it again.
            yield* lsp.hover(file, "doomed-session").pipe(Effect.catch(() => Effect.succeed([])))
            expect(spy).toHaveBeenCalledTimes(1)
          } finally {
            spy.mockRestore()
          }
        }),
      ),
    { config: { lsp: true } },
  )

  itProjectEnv.instance(
    "configured commands spawn with the exact resolved environment",
    () =>
      LSP.Service.use((lsp) =>
        Effect.gen(function* () {
          const dir = (yield* TestInstance).directory
          const stubDir = yield* Effect.promise(() => mkdtemp(path.join(tmpdir(), "pkl-custom-")))
          const marker = path.join(stubDir, "spawned.txt")
          yield* writeStub(stubDir, marker, "custom-stub", 0, "env-probe-stub")
          process.env.PKL_STUB_DIR = stubDir
          process.env.LSP_PROBE_SECRET = "backend-only"
          try {
            const result = yield* lsp.hover(
              { file: path.join(dir, "probe", "dummy.probe"), line: 0, character: 0 },
              "custom-session",
            )
            expect(JSON.stringify(result)).toContain("custom-stub-hover")
            const seen = yield* Effect.promise(() => readFile(marker, "utf8").catch(() => ""))
            expect(seen).toContain("secret=absent")
          } finally {
            delete process.env.PKL_STUB_DIR
            delete process.env.LSP_PROBE_SECRET
          }
        }),
      ),
    {
      config: {
        lsp: {
          envprobe: { command: ["env-probe-stub"], extensions: [".probe"] },
        },
      },
    },
  )

  itProjectEnv.instance(
    "a reselect never joins the previous selection's pending start",
    () =>
      LSP.Service.use((lsp) =>
        Effect.gen(function* () {
          const dir = (yield* TestInstance).directory
          const file = { file: path.join(dir, "config.pkl"), line: 0, character: 0 }
          const slowDir = yield* Effect.promise(() => mkdtemp(path.join(tmpdir(), "pkl-slow-")))
          const slowMarker = path.join(slowDir, "spawned.txt")
          yield* writeStub(slowDir, slowMarker, "slow-stub", 1500)
          const fastDir = yield* Effect.promise(() => mkdtemp(path.join(tmpdir(), "pkl-fast-")))
          const fastMarker = path.join(fastDir, "spawned.txt")
          yield* writeStub(fastDir, fastMarker, "fast-stub")
          const waitFor = (marker: string) =>
            Effect.promise(async () => {
              for (let n = 0; n < 100; n++) {
                try {
                  await readFile(marker, "utf8")
                  return
                } catch {
                  await new Promise((r) => setTimeout(r, 50))
                }
              }
              throw new Error(`stub never spawned: ${marker}`)
            })
          process.env.PKL_STUB_DIR = slowDir
          try {
            const first = yield* Effect.forkChild(lsp.hover(file, "race-session"))
            yield* waitFor(slowMarker)
            // Reselect while the first handshake is still pending.
            process.env.PKL_STUB_DIR = fastDir
            const second = yield* lsp.hover(file, "race-session")
            expect(JSON.stringify(second)).toContain("fast-stub-hover")
            const firstResult = yield* Fiber.join(first)
            // The first operation legitimately used its own selection.
            expect(JSON.stringify(firstResult)).toContain("slow-stub-hover")
            // Convergence: exactly one live client, no further spawns.
            const after = yield* lsp.hover(file, "race-session")
            expect(JSON.stringify(after)).toContain("fast-stub-hover")
            expect(yield* lsp.status("race-session")).toHaveLength(1)
            const seenFast = yield* Effect.promise(() => readFile(fastMarker, "utf8"))
            expect(seenFast).toContain("argv=--stdio")
          } finally {
            delete process.env.PKL_STUB_DIR
          }
        }),
      ),
    { config: { lsp: true } },
  )

  itProjectEnv.instance(
    "deleting a session during initialization leaves no client behind",
    () =>
      LSP.Service.use((lsp) =>
        Effect.gen(function* () {
          const dir = (yield* TestInstance).directory
          const file = { file: path.join(dir, "config.pkl"), line: 0, character: 0 }
          const stubDir = yield* Effect.promise(() => mkdtemp(path.join(tmpdir(), "pkl-doomed-")))
          const marker = path.join(stubDir, "spawned.txt")
          yield* writeStub(stubDir, marker, "doomed-stub", 1200)
          process.env.PKL_STUB_DIR = stubDir
          try {
            const pending = yield* Effect.forkChild(lsp.hover(file, "midflight-session").pipe(Effect.exit))
            yield* Effect.sleep("300 millis")
            yield* lsp.releaseSession("midflight-session")
            const exit = yield* Fiber.join(pending)
            expect(yield* lsp.status("midflight-session")).toEqual([])
            // The process did start (proves the race was real), but no
            // client survived the release.
            const seen = yield* Effect.promise(() => readFile(marker, "utf8").catch(() => ""))
            expect(seen).toContain("argv=--stdio")
            void exit
          } finally {
            delete process.env.PKL_STUB_DIR
          }
        }),
      ),
    { config: { lsp: true } },
  )
})
