import { describe, expect, test } from "bun:test"
import { existsSync } from "fs"
import path from "path"
import { pathToFileURL } from "url"
import { Effect, Exit, Layer } from "effect"
import * as TestConsole from "effect/testing/TestConsole"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Account } from "../../src/account/account"
import { Auth } from "../../src/auth"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { Npm } from "@opencode-ai/core/npm"
import { LSP } from "@/lsp/lsp"
import { Plugin } from "@/plugin/index"
import { TestInstance, withTmpdirInstance } from "../fixture/fixture"
import { AccountTest } from "../fake/account"
import { AuthTest } from "../fake/auth"
import { NpmTest } from "../fake/npm"

// Session-scoped Harbor selection through the real fork/plugin/adapter stack.
// The plugin file re-exports the real Harbor adapter (resolved against the
// canonical checkout layout); the language server is a fixture script that
// answers hover with the GATE_SENTINEL it was spawned with, so every
// assertion observes the environment the backend actually passed down.
// No model or provider is involved: the session identity is a plain string,
// exactly as the hook contracts consume it.
const harborAdapter = path.resolve(
  import.meta.dir,
  "../../../../../../repos/owned/harbor-canix-llm/src/adapter.mjs",
)
const hasHarbor = existsSync(harborAdapter)

const layer = Layer.provideMerge(
  AppNodeBuilder.build(LayerNode.group([LSP.node, Plugin.node, CrossSpawnSpawner.node]), [
    [Auth.node, AuthTest.empty],
    [Account.node, AccountTest.empty],
    [Npm.node, NpmTest.noop],
    [RuntimeFlags.node, RuntimeFlags.layer({ disableDefaultPlugins: true })],
  ]),
  TestConsole.layer,
)

const runGate = (body: Effect.Effect<any, any, any>) =>
  Effect.runPromise(
    Effect.provide(
      Effect.scoped(withTmpdirInstance()(body) as Effect.Effect<any, any, never>),
      layer as Layer.Layer<never>,
    ),
  )

const harborAdapterUrl = pathToFileURL(harborAdapter).href

const drv = (tag: string) => `/nix/store/00000000000000000000000000000000-${tag}.drv`

const fakeServer = (log: string) => `
import { appendFileSync } from "node:fs"
const log = ${JSON.stringify(log)}
let buffer = Buffer.alloc(0)
const send = (obj) => {
  const body = Buffer.from(JSON.stringify(obj))
  process.stdout.write(Buffer.concat([Buffer.from("Content-Length: " + body.length + "\\r\\n\\r\\n"), body]))
}
process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk])
  for (;;) {
    const at = buffer.indexOf("\\r\\n\\r\\n")
    if (at === -1) return
    const match = /Content-Length: (\\d+)/i.exec(buffer.subarray(0, at).toString())
    if (!match) return
    const length = Number(match[1])
    if (buffer.length < at + 4 + length) return
    const msg = JSON.parse(buffer.subarray(at + 4, at + 4 + length).toString())
    buffer = buffer.subarray(at + 4 + length)
    if (msg.method === "initialize") {
      appendFileSync(log, "start " + process.pid + " " + (process.env.GATE_SENTINEL ?? "none") + "\\n")
      send({ jsonrpc: "2.0", id: msg.id, result: { capabilities: { hoverProvider: true } } })
    } else if (msg.method === "textDocument/hover") {
      send({ jsonrpc: "2.0", id: msg.id, result: { contents: { kind: "markdown", value: process.env.GATE_SENTINEL ?? "none" } } })
    } else if (msg.method === "shutdown") {
      send({ jsonrpc: "2.0", id: msg.id, result: null })
    } else if (msg.method === "exit") {
      appendFileSync(log, "stop " + process.pid + "\\n")
      process.exit(0)
    }
  }
})
`

const pluginSource = (dir: string, hooks: string[]) => `
import { createAdapter } from ${JSON.stringify(harborAdapterUrl)}
const prepared = { n: 0 }
const adapter = createAdapter(
  { version: 1, projects: [{ name: "gate", root: ${JSON.stringify(dir)}, shells: { one: ${JSON.stringify(drv("one"))}, two: ${JSON.stringify(drv("two"))} } }] },
  async () => ({ ...process.env, GATE_SENTINEL: "shell-" + (++prepared.n) }),
)
const gate = (globalThis.__harborGate ??= {})
gate.adapter = adapter
gate.select = (sessionID, shell) =>
  adapter
    // An ordinary shell-environment resolution precedes selection at
  // runtime and verifies the replacement contract for the session.
    .shellEnvironment({ cwd: ${JSON.stringify(dir)}, sessionID, harborCanixLlm: 1 }, { env: {} })
    .then(() =>
      adapter.execute(
        { action: "select", project: "gate", shell },
        { sessionID, directory: ${JSON.stringify(dir)}, worktree: ${JSON.stringify(dir)}, abort: undefined, ask: async () => { if (gate.deny) throw new Error("denied") } },
      ),
    )
gate.clear = (sessionID) => adapter.execute({ action: "clear", project: "gate" }, { sessionID })
const hooks = {}
${hooks.includes("shell") ? `hooks["shell.env"] = adapter.shellEnvironment` : ""}
${hooks.includes("lsp") ? `hooks["lsp.env"] = adapter.lspEnvironment` : ""}
export default async () => hooks
`

function withGateProject<A, E, R>(hooks: string[], self: Effect.Effect<A, E, R>) {
  return Effect.gen(function* () {
    const test = yield* TestInstance
    const dir = test.directory
    const log = path.join(dir, "fake-lsp.log")
    yield* Effect.all(
      [
        Effect.promise(() => Bun.write(path.join(dir, "fake-lsp.mjs"), fakeServer(log))),
        Effect.promise(() => Bun.write(path.join(dir, "plugin.ts"), pluginSource(dir, hooks))),
        Effect.promise(() => Bun.write(path.join(dir, "probe.gate"), "x")),
        Effect.promise(() =>
          Bun.write(
            path.join(dir, "opencode.json"),
            JSON.stringify({
              $schema: "https://opencode.ai/config.json",
              lsp: {
                gatesrv: {
                  command: [process.execPath, path.join(dir, "fake-lsp.mjs"), log],
                  extensions: [".gate"],
                },
              },
              plugin: [pathToFileURL(path.join(dir, "plugin.ts")).href],
            }),
          ),
        ),
      ],
      { discard: true, concurrency: 2 },
    )
    return yield* self
  })
}

const gate = () => (globalThis as any).__harborGate as {
  select: (sessionID: string, shell: string) => Promise<unknown>
  clear: (sessionID: string) => Promise<unknown>
  deny: boolean
}

const waitForDeath = (pid: number) =>
  Effect.promise(async () => {
    const start = Date.now()
    for (;;) {
      try {
        process.kill(pid, 0)
      } catch {
        return
      }
      if (Date.now() - start > 10_000) throw new Error(`server ${pid} did not retire`)
      await new Promise((r) => setTimeout(r, 50))
    }
  })

const hoverValue = (file: string, sessionID: string) =>
  LSP.Service.use((lsp) =>
    Effect.gen(function* () {
      // The session must ride along on touch: a sessionless touch spawns a
      // baseline server that the session-scoped hover would then ignore.
      yield* lsp.touchFile(file, undefined, sessionID)
      const [result] = yield* lsp.hover({ file, line: 0, character: 0 }, sessionID)
      return result?.contents?.value as string | undefined
    }),
  )

const starts = (dir: string) =>
  Effect.promise(() =>
    Bun.file(path.join(dir, "fake-lsp.log"))
      .text()
      .then((text) =>
        text
          .split("\n")
          .filter((line) => line.startsWith("start "))
          .map((line) => ({ pid: Number(line.split(" ")[1]), sentinel: line.split(" ")[2] })),
      )
      .catch(() => [] as Array<{ pid: number; sentinel: string }>),
  )

describe("harbor selection", () => {
  test.skipIf(!hasHarbor)("select/reselect/clear/isolate through real hooks and servers", () =>
    runGate(
      withGateProject(
        ["shell", "lsp"],
        Effect.gen(function* () {
        const test = yield* TestInstance
        const file = path.join(test.directory, "probe.gate")
        // Load the file plugin before touching the adapter it owns.
        yield* (yield* Plugin.Service).init()
        const g = gate()

        yield* Effect.promise(() => g.select("hs1", "one"))
        expect(yield* hoverValue(file, "hs1")).toBe("shell-1")

        // Reselect spawns a new server with the new environment and retires the old one.
        yield* Effect.promise(() => g.select("hs1", "two"))
        expect(yield* hoverValue(file, "hs1")).toBe("shell-2")
        const seen = yield* starts(test.directory)
        expect(seen.map((s) => s.sentinel)).toEqual(["shell-1", "shell-2"])
        expect(seen[0]!.pid).not.toBe(seen[1]!.pid)
        yield* waitForDeath(seen[0]!.pid)

        // The shell hook honors the same selection; sessionless callers get the baseline.
        // The harborCanixLlm marker mirrors the packaged runtime contract.
        const plugin = yield* Plugin.Service
        const withSession: { env: Record<string, string> } = { env: {} }
        yield* plugin.trigger(
          "shell.env",
          { cwd: test.directory, sessionID: "hs1", harborCanixLlm: 1 },
          withSession,
        )
        expect(withSession.env.GATE_SENTINEL).toBe("shell-2")
        const sessionless: { env: Record<string, string> } = { env: {} }
        yield* plugin.trigger("shell.env", { cwd: test.directory, harborCanixLlm: 1 }, sessionless)
        expect(sessionless.env.GATE_SENTINEL).toBeUndefined()

        // A second session is isolated from the first.
        yield* Effect.promise(() => g.select("hs2", "one"))
        expect(yield* hoverValue(file, "hs2")).toBe("shell-3")
        expect(yield* hoverValue(file, "hs1")).toBe("shell-2")

        // Clear restores the baseline and retires the selected server.
        yield* Effect.promise(() => g.clear("hs1"))
        expect(yield* hoverValue(file, "hs1")).toBe("none")
        yield* waitForDeath(seen[1]!.pid)

        // Denied authorization selects nothing and stays on the baseline.
        g.deny = true
        try {
          const exit = yield* Effect.exit(Effect.promise(() => g.select("hs3", "one")))
          expect(Exit.isFailure(exit)).toBe(true)
        } finally {
          g.deny = false
        }
        expect(yield* hoverValue(file, "hs3")).toBe("none")
        }),
      ),
    ),
  )

  test.skipIf(!hasHarbor)("without the lsp.env hook the server runs on the baseline", () =>
    runGate(
      withGateProject(
        ["shell"],
        Effect.gen(function* () {
        const test = yield* TestInstance
        const file = path.join(test.directory, "probe.gate")
        yield* (yield* Plugin.Service).init()
        const g = gate()
        // Selection still succeeds (shell hook present), but the language
        // server must not inherit it: this is the negative control that
        // fails if selection ever leaks through another path.
        yield* Effect.promise(() => g.select("hs1", "one"))
        expect(yield* hoverValue(file, "hs1")).toBe("none")
        }),
      ),
    ),
  )
})
