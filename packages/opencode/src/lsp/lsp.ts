import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { EventV2Bridge } from "@/event-v2-bridge"
import * as LSPClient from "./client"
import path from "path"
import { pathToFileURL, fileURLToPath } from "url"
import * as LSPServer from "./server"
import { Config } from "@/config/config"
import { Process } from "@/util/process"
import { Plugin } from "@/plugin"
import { spawn as lspspawn } from "./launch"
import { Effect, Layer, Context, Schema, Option } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { containsPath } from "@/project/instance-context"
import { NonNegativeInt } from "@opencode-ai/core/schema"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { LspEvent } from "@opencode-ai/schema/lsp-event"

export const Event = LspEvent

const Position = Schema.Struct({
  line: NonNegativeInt,
  character: NonNegativeInt,
})

export const Range = Schema.Struct({
  start: Position,
  end: Position,
}).annotate({ identifier: "Range" })
export type Range = typeof Range.Type

export const Symbol = Schema.Struct({
  name: Schema.String,
  kind: NonNegativeInt,
  location: Schema.Struct({
    uri: Schema.String,
    range: Range,
  }),
}).annotate({ identifier: "Symbol" })
export type Symbol = typeof Symbol.Type

export const DocumentSymbol = Schema.Struct({
  name: Schema.String,
  detail: Schema.optional(Schema.String),
  kind: NonNegativeInt,
  range: Range,
  selectionRange: Range,
}).annotate({ identifier: "DocumentSymbol" })
export type DocumentSymbol = typeof DocumentSymbol.Type

export const Status = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  root: Schema.String,
  status: Schema.Literals(["connected", "error"]),
}).annotate({ identifier: "LSPStatus" })
export type Status = typeof Status.Type

enum SymbolKind {
  File = 1,
  Module = 2,
  Namespace = 3,
  Package = 4,
  Class = 5,
  Method = 6,
  Property = 7,
  Field = 8,
  Constructor = 9,
  Enum = 10,
  Interface = 11,
  Function = 12,
  Variable = 13,
  Constant = 14,
  String = 15,
  Number = 16,
  Boolean = 17,
  Array = 18,
  Object = 19,
  Key = 20,
  Null = 21,
  EnumMember = 22,
  Struct = 23,
  Event = 24,
  Operator = 25,
  TypeParameter = 26,
}

const kinds = [
  SymbolKind.Class,
  SymbolKind.Function,
  SymbolKind.Method,
  SymbolKind.Interface,
  SymbolKind.Variable,
  SymbolKind.Constant,
  SymbolKind.Struct,
  SymbolKind.Enum,
]

const filterExperimentalServers = (servers: Record<string, LSPServer.Info>, flags: RuntimeFlags.Info) => {
  if (flags.experimentalLspTy) {
    if (servers["pyright"]) {
      delete servers["pyright"]
    }
  } else {
    if (servers["ty"]) {
      delete servers["ty"]
    }
  }
}

type LocInput = { file: string; line: number; character: number }

interface State {
  clients: LSPClient.Info[]
  servers: Record<string, LSPServer.Info>
  broken: Map<string, string | undefined>
  spawning: Map<string, Promise<LSPClient.Info | undefined>>
  sessions: Map<LSPClient.Info, string | undefined>
  envSig: Map<LSPClient.Info, string>
  released: Set<string>
}

export interface Interface {
  readonly init: () => Effect.Effect<void>
  /**
   * Session-specific inventory: with a session ID lists that session's
   * servers, otherwise only the shared baseline pool. Sessionless callers
   * (HTTP endpoint, debug CLI) therefore never see session-owned servers.
   */
  readonly status: (sessionID?: string) => Effect.Effect<Status[]>
  readonly hasClients: (file: string, sessionID?: string) => Effect.Effect<boolean>
  readonly touchFile: (input: string, diagnostics?: "document" | "full", sessionID?: string) => Effect.Effect<void>
  readonly diagnostics: (sessionID?: string) => Effect.Effect<Record<string, LSPClient.Diagnostic[]>>
  readonly hover: (input: LocInput, sessionID?: string) => Effect.Effect<any>
  readonly definition: (input: LocInput, sessionID?: string) => Effect.Effect<any[]>
  readonly references: (input: LocInput, sessionID?: string) => Effect.Effect<any[]>
  readonly implementation: (input: LocInput, sessionID?: string) => Effect.Effect<any[]>
  readonly documentSymbol: (uri: string, sessionID?: string) => Effect.Effect<(DocumentSymbol | Symbol)[]>
  readonly workspaceSymbol: (query: string, sessionID?: string) => Effect.Effect<Symbol[]>
  readonly prepareCallHierarchy: (input: LocInput, sessionID?: string) => Effect.Effect<any[]>
  readonly incomingCalls: (input: LocInput, sessionID?: string) => Effect.Effect<any[]>
  readonly outgoingCalls: (input: LocInput, sessionID?: string) => Effect.Effect<any[]>
  /** Shut down and drop every client owned by a session (e.g. on session delete). */
  readonly releaseSession: (sessionID: string) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/LSP") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const flags = yield* RuntimeFlags.Service
    const events = yield* EventV2Bridge.Service

    const state = yield* InstanceState.make<State>(
      Effect.fn("LSP.state")(function* (ctx) {
        const cfg = yield* config.get()

        const servers: Record<string, LSPServer.Info> = {}

        if (!cfg.lsp) {
          yield* Effect.logInfo("all LSPs are disabled")
        } else {
          for (const server of Object.values(LSPServer)) {
            servers[server.id] = server
          }

          filterExperimentalServers(servers, flags)

          if (cfg.lsp !== true) {
            for (const [name, item] of Object.entries(cfg.lsp)) {
              const existing = servers[name]
              if (item.disabled) {
                yield* Effect.logInfo(`LSP server ${name} is disabled`)
                delete servers[name]
                continue
              }
              servers[name] = {
                ...existing,
                id: name,
                root: existing?.root ?? (async (_file, ctx) => ctx.directory),
                extensions: item.extensions ?? existing?.extensions ?? [],
                spawn: async (root, _ctx, _flags, env) => ({
                  process: lspspawn(item.command[0], item.command.slice(1), {
                    cwd: root,
                    env: { ...(env ?? process.env), ...item.env },
                    extendEnv: false,
                  }),
                  initialization: item.initialization,
                }),
              }
            }
          }

          yield* Effect.logInfo("enabled LSP servers", {
            serverIds: Object.values(servers)
              .map((server) => server.id)
              .join(", "),
          })
        }

        const s: State = {
          clients: [],
          servers,
          broken: new Map(),
          spawning: new Map(),
          sessions: new Map(),
          envSig: new Map(),
          released: new Set(),
        }

        yield* Effect.addFinalizer(() =>
          Effect.promise(async () => {
            await Promise.all(s.clients.map((client) => client.shutdown()))
          }),
        )

        return s
      }),
    )

    // Resolve the language-server environment through the explicit
    // `lsp.env` contract. `shell.env` plugins are never consulted here.
    // Hook failures fail the operation; only the absence of any plugin
    // falls back to the process baseline (unchanged legacy behavior).
    // Resolved at execution time: sibling layers are invisible at build time.
    const resolveEnv = Effect.fnUntraced(function* (file: string, sessionID?: string) {
      const plugin = yield* Effect.serviceOption(Plugin.Service)
      const inherited = Object.fromEntries(
        Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
      )
      return yield* Option.match(plugin, {
        onNone: () => Effect.succeed({ env: { ...inherited }, sig: JSON.stringify({ ...inherited }) }),
        onSome: (plugin) =>
          Effect.gen(function* () {
            const output: { env: Record<string, string>; unset?: string[]; replace?: boolean } = { env: {} }
            const extra = yield* plugin.trigger(
              "lsp.env",
              { cwd: path.dirname(file), sessionID, env: Object.freeze({ ...inherited }) },
              output,
            )
            if (extra.replace) return { env: { ...extra.env }, sig: JSON.stringify({ ...extra.env }) }
            const env = { ...inherited }
            for (const key of extra.unset ?? []) if (!Object.hasOwn(extra.env, key)) delete env[key]
            const resolved = { ...env, ...extra.env }
            return { env: resolved, sig: JSON.stringify(resolved) }
          }),
      })
    })

    const getClients = Effect.fnUntraced(function* (file: string, sessionID?: string) {
      const ctx = yield* InstanceState.context
      if (!containsPath(file, ctx)) return [] as LSPClient.Info[]
      const projectEnv = yield* resolveEnv(file, sessionID)
      const s = yield* InstanceState.get(state)
      if (sessionID && s.released.has(sessionID)) return [] as LSPClient.Info[]
      // Identity covers root, server, session AND environment signature, so a
      // reselect never reuses an in-flight start from the previous selection.
      const keyFor = (root: string, serverID: string) => root + serverID + (sessionID ?? "") + projectEnv.sig
      const clients = yield* Effect.promise(async () => {
        const extension = path.parse(file).ext || file
        const result: LSPClient.Info[] = []
        let updated = 0

          // Client identity includes the session: environments are approved
          // per session, so one session's server is never reused by another.
          async function schedule(server: LSPServer.Info, root: string) {
          const key = keyFor(root, server.id)
          const fail = () => {
            s.broken.set(key, sessionID)
          }
          const handle = await server
            .spawn(root, ctx, flags, projectEnv.env)
            .then((value) => {
              if (!value) fail()
              return value
            })
            .catch(() => {
              fail()
              return undefined
            })

          if (!handle) return undefined
          if (sessionID && s.released.has(sessionID)) {
            await Process.stop(handle.process)
            return undefined
          }
          const client = await LSPClient.create({
            serverID: server.id,
            server: handle,
            root,
            directory: ctx.directory,
            instance: ctx,
          }).catch(async () => {
            s.broken.set(key, sessionID)
            await Process.stop(handle.process)
            return undefined
          })

          if (!client) return undefined
          if (sessionID && s.released.has(sessionID)) {
            await client.shutdown().catch(() => undefined)
            return undefined
          }

          const existing = s.clients.find(
            (x) =>
              x.root === root &&
              x.serverID === server.id &&
              s.sessions.get(x) === sessionID &&
              s.envSig.get(x) === projectEnv.sig,
          )
          if (existing) {
            await Process.stop(handle.process)
            return existing
          }

          s.clients.push(client)
          s.sessions.set(client, sessionID)
          s.envSig.set(client, projectEnv.sig)
          return client
        }

        const dropClient = async (client: LSPClient.Info) => {
          try {
            await client.shutdown()
          } catch {
            // Already gone; state cleanup below still applies.
          }
          const idx = s.clients.indexOf(client)
          if (idx !== -1) s.clients.splice(idx, 1)
          s.sessions.delete(client)
          s.envSig.delete(client)
        }

        for (const server of Object.values(s.servers)) {
          if (server.extensions.length && !server.extensions.includes(extension)) continue

          const root = await server.root(file, ctx)
          if (!root) continue
          const key = keyFor(root, server.id)
          // Identity covers the environment signature, so past failures only
          // suppress retries under the same selection, and live clients from
          // a previous selection (reselect/clear) are retired below.
          for (const stale of s.clients.filter(
            (x) =>
              x.root === root &&
              x.serverID === server.id &&
              s.sessions.get(x) === sessionID &&
              s.envSig.get(x) !== projectEnv.sig,
          )) {
            await dropClient(stale)
          }
          if (s.broken.has(key)) continue

          const match = s.clients.find(
            (x) =>
              x.root === root &&
              x.serverID === server.id &&
              s.sessions.get(x) === sessionID &&
              s.envSig.get(x) === projectEnv.sig,
          )
          if (match) {
            result.push(match)
            continue
          }

          const inflight = s.spawning.get(key)
          if (inflight) {
            const client = await inflight
            if (!client) continue
            result.push(client)
            continue
          }

          const task = schedule(server, root)
          s.spawning.set(key, task)

          task.finally(() => {
            if (s.spawning.get(key) === task) {
              s.spawning.delete(key)
            }
          })

          const client = await task
          if (!client) continue

          result.push(client)
          updated++
        }

        return { result, updated }
      })
      yield* Effect.forEach(Array.from({ length: clients.updated }), () => events.publish(Event.Updated, {}), {
        discard: true,
      })
      return clients.result
    })

    const run = Effect.fnUntraced(function* <T>(file: string, fn: (client: LSPClient.Info) => Promise<T>, sessionID?: string) {
      const clients = yield* getClients(file, sessionID)
      return yield* Effect.promise(() => Promise.all(clients.map((x) => fn(x))))
    })

    const runAll = Effect.fnUntraced(function* <T>(fn: (client: LSPClient.Info) => Promise<T>, sessionID?: string) {
      const s = yield* InstanceState.get(state)
      const owned = s.clients.filter((x) => s.sessions.get(x) === sessionID)
      return yield* Effect.promise(() => Promise.all(owned.map((x) => fn(x))))
    })

    const releaseSession = Effect.fn("LSP.releaseSession")(function* (sessionID: string) {
      const s = yield* InstanceState.get(state)
      s.released.add(sessionID)
      for (const client of s.clients.filter((x) => s.sessions.get(x) === sessionID)) {
        try {
          yield* Effect.promise(() => client.shutdown())
        } catch {
          // Already gone; state cleanup below still applies.
        }
        const idx = s.clients.indexOf(client)
        if (idx !== -1) s.clients.splice(idx, 1)
        s.sessions.delete(client)
        s.envSig.delete(client)
      }
      for (const [key, owner] of s.broken) if (owner === sessionID) s.broken.delete(key)
    })

    const init = Effect.fn("LSP.init")(function* () {
      yield* InstanceState.get(state)
    })

    const status = Effect.fn("LSP.status")(function* (sessionID?: string) {
      const ctx = yield* InstanceState.context
      const s = yield* InstanceState.get(state)
      const result: Status[] = []
      for (const client of s.clients) {
        if (s.sessions.get(client) !== sessionID) continue
        result.push({
          id: client.serverID,
          name: s.servers[client.serverID].id,
          root: path.relative(ctx.directory, client.root),
          status: "connected",
        })
      }
      return result
    })

    // Availability probe on the same resolution path as getClients: hook
    // failures fail the probe, and a changed selection heals past failures.
    const hasClients = Effect.fn("LSP.hasClients")(function* (file: string, sessionID?: string) {
      const ctx = yield* InstanceState.context
      if (!containsPath(file, ctx)) return false
      const projectEnv = yield* resolveEnv(file, sessionID)
      const keyFor = (root: string, serverID: string) => root + serverID + (sessionID ?? "") + projectEnv.sig
      const s = yield* InstanceState.get(state)
      return yield* Effect.promise(async () => {
        const extension = path.parse(file).ext || file
        for (const server of Object.values(s.servers)) {
          if (server.extensions.length && !server.extensions.includes(extension)) continue
          const root = await server.root(file, ctx)
          if (!root) continue
          if (s.broken.has(keyFor(root, server.id))) continue
          return true
        }
        return false
      })
    })

    const touchFile = Effect.fn("LSP.touchFile")(function* (input: string, diagnostics?: "document" | "full", sessionID?: string) {
      yield* Effect.logInfo("touching file", { file: input })
      const clients = yield* getClients(input, sessionID)
      yield* Effect.promise(() =>
        Promise.all(
          clients.map(async (client) => {
            const after = Date.now()
            const version = await client.notify.open({ path: input })
            if (!diagnostics) return
            return client.waitForDiagnostics({
              path: input,
              version,
              mode: diagnostics,
              after,
            })
          }),
        ).catch(() => {}),
      )
    })

    const diagnostics = Effect.fn("LSP.diagnostics")(function* (sessionID?: string) {
      const results: Record<string, LSPClient.Diagnostic[]> = {}
      const all = yield* runAll(async (client) => client.diagnostics, sessionID)
      for (const result of all) {
        for (const [p, diags] of result.entries()) {
          const arr = results[p] || []
          arr.push(...diags)
          results[p] = arr
        }
      }
      return results
    })

    const hover = Effect.fn("LSP.hover")(function* (input: LocInput, sessionID?: string) {
      return yield* run(input.file, (client) =>
        client.connection
          .sendRequest("textDocument/hover", {
            textDocument: { uri: pathToFileURL(input.file).href },
            position: { line: input.line, character: input.character },
          })
          .catch(() => null),
        sessionID,
      )
    })

    const definition = Effect.fn("LSP.definition")(function* (input: LocInput, sessionID?: string) {
      const results = yield* run(input.file, (client) =>
        client.connection
          .sendRequest("textDocument/definition", {
            textDocument: { uri: pathToFileURL(input.file).href },
            position: { line: input.line, character: input.character },
          })
          .catch(() => null),
        sessionID,
      )
      return results.flat().filter(Boolean)
    })

    const references = Effect.fn("LSP.references")(function* (input: LocInput, sessionID?: string) {
      const results = yield* run(input.file, (client) =>
        client.connection
          .sendRequest("textDocument/references", {
            textDocument: { uri: pathToFileURL(input.file).href },
            position: { line: input.line, character: input.character },
            context: { includeDeclaration: true },
          })
          .catch(() => []),
        sessionID,
      )
      return results.flat().filter(Boolean)
    })

    const implementation = Effect.fn("LSP.implementation")(function* (input: LocInput, sessionID?: string) {
      const results = yield* run(input.file, (client) =>
        client.connection
          .sendRequest("textDocument/implementation", {
            textDocument: { uri: pathToFileURL(input.file).href },
            position: { line: input.line, character: input.character },
          })
          .catch(() => null),
        sessionID,
      )
      return results.flat().filter(Boolean)
    })

    const documentSymbol = Effect.fn("LSP.documentSymbol")(function* (uri: string, sessionID?: string) {
      const file = fileURLToPath(uri)
      const results = yield* run(file, (client) =>
        client.connection.sendRequest("textDocument/documentSymbol", { textDocument: { uri } }).catch(() => []),
        sessionID,
      )
      return (results.flat() as (DocumentSymbol | Symbol)[]).filter(Boolean)
    })

    const workspaceSymbol = Effect.fn("LSP.workspaceSymbol")(function* (query: string, sessionID?: string) {
      const results = yield* runAll((client) =>
        client.connection
          .sendRequest<Symbol[]>("workspace/symbol", { query })
          .then((result) => result.filter((x) => kinds.includes(x.kind)).slice(0, 10))
          .catch(() => [] as Symbol[]),
        sessionID,
      )
      return results.flat()
    })

    const prepareCallHierarchy = Effect.fn("LSP.prepareCallHierarchy")(function* (input: LocInput, sessionID?: string) {
      const results = yield* run(input.file, (client) =>
        client.connection
          .sendRequest("textDocument/prepareCallHierarchy", {
            textDocument: { uri: pathToFileURL(input.file).href },
            position: { line: input.line, character: input.character },
          })
          .catch(() => []),
        sessionID,
      )
      return results.flat().filter(Boolean)
    })

    const callHierarchyRequest = Effect.fnUntraced(function* (
      input: LocInput,
      direction: "callHierarchy/incomingCalls" | "callHierarchy/outgoingCalls",
      sessionID?: string,
    ) {
      const results = yield* run(input.file, async (client) => {
        const items = await client.connection
          .sendRequest<unknown[] | null>("textDocument/prepareCallHierarchy", {
            textDocument: { uri: pathToFileURL(input.file).href },
            position: { line: input.line, character: input.character },
          })
          .catch(() => [] as unknown[])
        if (!items?.length) return []
        return client.connection.sendRequest(direction, { item: items[0] }).catch(() => [])
      }, sessionID)
      return results.flat().filter(Boolean)
    })

    const incomingCalls = Effect.fn("LSP.incomingCalls")(function* (input: LocInput, sessionID?: string) {
      return yield* callHierarchyRequest(input, "callHierarchy/incomingCalls", sessionID)
    })

    const outgoingCalls = Effect.fn("LSP.outgoingCalls")(function* (input: LocInput, sessionID?: string) {
      return yield* callHierarchyRequest(input, "callHierarchy/outgoingCalls", sessionID)
    })

    return Service.of({
      init,
      status,
      hasClients,
      touchFile,
      diagnostics,
      hover,
      definition,
      references,
      implementation,
      documentSymbol,
      workspaceSymbol,
      prepareCallHierarchy,
      incomingCalls,
      outgoingCalls,
      releaseSession,
    })
  }),
)

export * as Diagnostic from "./diagnostic"

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [Config.node, RuntimeFlags.node, FSUtil.node, EventV2Bridge.node],
})

export * as LSP from "./lsp"
