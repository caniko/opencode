import { NodeFileSystem } from "@effect/platform-node"
import { Service } from "@opencode/client/effect/service"
import { Global } from "@opencode/util/global"
import { expect, test } from "bun:test"
import { Effect } from "effect"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { serviceFixture } from "../../client/test/fixture/service-fixture"
import { ServiceConfig } from "../src/services/service-config"

test.each([
  { key: "hostname", value: "127.0.0.1" },
  { key: "port", value: "4096" },
  { key: "password", value: "private" },
  { key: "cors", value: "https://example.com" },
  { key: "env", value: "EXAMPLE", nested: "value" },
  { key: "disabled", value: "false" },
])("setting unchanged $key preserves the server and private configuration", async ({ key, value, nested }) => {
  await using fixture = await serviceFixture()
  const owner = fixture.spawn("compatible")
  await fixture.waitForFile()
  const registration = await readFile(fixture.registration, "utf8")
  await writeFile(join(fixture.directory, ServiceConfig.filename()), registration)
  const config = join(fixture.directory, "config", ServiceConfig.filename())
  const original = JSON.stringify({
    hostname: "127.0.0.1",
    port: 4096,
    password: "private",
    cors: ["https://example.com"],
    env: { EXAMPLE: "value", OTHER: "preserved" },
  })
  await Bun.write(config, original)
  await Effect.runPromise(
    ServiceConfig.set(key, value, nested).pipe(
      Effect.provide(Global.layerWith({ config: join(fixture.directory, "config"), state: fixture.directory })),
      Effect.provide(NodeFileSystem.layer),
    ),
  )
  expect(owner.exitCode).toBeNull()
  expect(await readFile(config, "utf8")).toBe(original)
  expect(await readFile(join(fixture.directory, ServiceConfig.filename()), "utf8")).toBe(registration)
})

test("a changed endpoint stops the server and preserves unrelated configuration", async () => {
  await using fixture = await serviceFixture()
  const owner = fixture.spawn("compatible")
  await fixture.waitForFile()
  await writeFile(join(fixture.directory, ServiceConfig.filename()), await readFile(fixture.registration))
  const config = join(fixture.directory, "config", ServiceConfig.filename())
  await Bun.write(config, JSON.stringify({ port: 4096, password: "private", env: { OTHER: "preserved" } }))
  await Effect.runPromise(
    ServiceConfig.set("port", "4098").pipe(
      Effect.provide(Global.layerWith({ config: join(fixture.directory, "config"), state: fixture.directory })),
      Effect.provide(NodeFileSystem.layer),
    ),
  )
  expect(await owner.exited).toBe(0)
  expect(await Bun.file(config).json()).toEqual({ port: 4098, password: "private", env: { OTHER: "preserved" } })
})

test.each(["ready", "starting", "wrong-pid", "wrong-version", "unauthorized", "failed", "hanging", "missing"])(
  "readiness is bounded, authenticated and non-starting: %s",
  async (mode) => {
    const root = await mkdtemp(join(tmpdir(), "opencode-readiness-"))
    const file = join(root, "service.json")
    const started = Date.now()
    const listener = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        if (request.headers.get("authorization") !== "Basic " + btoa("opencode:private"))
          return new Response(null, { status: 401 })
        if (mode === "hanging") return new Promise<Response>(() => {})
        return Response.json(
          { version: "test", pid: process.pid },
          { status: mode === "failed" ? 500 : mode === "starting" && Date.now() - started < 150 ? 503 : 200 },
        )
      },
    })
    const original = JSON.stringify({
      url: listener.url.toString(),
      pid: process.pid,
      version: "test",
      password: mode === "unauthorized" ? "wrong" : "private",
    })
    try {
      if (mode !== "missing") await writeFile(file, original)
      const result = Effect.runPromise(
        Service.wait({
          file,
          pid: mode === "wrong-pid" ? process.pid + 1 : process.pid,
          version: mode === "wrong-version" ? "other" : "test",
          timeout: 400,
        }).pipe(Effect.provide(NodeFileSystem.layer)),
      )
      if (mode === "ready" || mode === "starting") expect((await result).url).toBe(listener.url.toString())
      else await expect(result).rejects.toThrow("Timed out waiting for background service")
      expect(Date.now() - started).toBeLessThan(2_000)
      if (mode === "missing") expect(await Bun.file(file).exists()).toBe(false)
      else expect(await readFile(file, "utf8")).toBe(original)
    } finally {
      listener.stop(true)
      await rm(root, { recursive: true, force: true })
    }
  },
)
