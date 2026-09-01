import { describe, expect } from "bun:test"
import { randomUUID } from "node:crypto"
import { spawn, spawnSync } from "node:child_process"
import { mkdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Effect, Fiber } from "effect"
import { ProcessGovernor } from "@opencode-ai/core/process-governor"
import { it } from "./lib/effect"

describe("process governor", () => {
  it.effect("classifies parsed build commands without substring matching", () => {
    return Effect.sync(() => {
      expect(ProcessGovernor.classify(["cargo", "check", "--workspace"])).toBe("heavy")
      expect(ProcessGovernor.classify(["cargo", "+nightly", "build"])).toBe("heavy")
      expect(ProcessGovernor.classify(["sudo", "nix", "flake", "check"])).toBe("heavy")
      expect(ProcessGovernor.classify(["sudo", "--user=root", "cargo", "test"])).toBe("heavy")
      expect(ProcessGovernor.classify(["nix", "--offline", "build"])).toBe("heavy")
      expect(ProcessGovernor.classify(["canix", "--output", "json", "repo", "check"])).toBe("heavy")
      expect(ProcessGovernor.classify(["bun", "run", "typecheck"])).toBe("heavy")
      expect(ProcessGovernor.classify(["rg", "cargo", "build"])).toBe("ordinary")
      expect(ProcessGovernor.classify(["echo", "make"])).toBe("ordinary")
      expect(ProcessGovernor.classify(["nix", "eval", ".#packages"])).toBe("ordinary")
      expect(ProcessGovernor.classifyShell('bash -lc "cargo build"')).toBe("heavy")
      expect(ProcessGovernor.classifyShell("echo cargo build")).toBe("ordinary")
      expect(ProcessGovernor.classifyShell("cd /tmp && cargo test")).toBe("heavy")
      expect(ProcessGovernor.classifyShell("echo one\ncargo check")).toBe("heavy")
    })
  })

  const fixture = Effect.acquireRelease(
    Effect.gen(function* () {
      const dir = path.join(os.tmpdir(), `opencode-governor-${randomUUID()}`)
      yield* Effect.promise(() => mkdir(dir, { recursive: true }))
      return dir
    }),
    (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true })),
  )

  const waitFor = (effect: Effect.Effect<boolean>) =>
    Effect.gen(function* () {
      while (!(yield* effect)) yield* Effect.sleep("5 millis")
    }).pipe(Effect.timeout("5 seconds"))

  const worker = path.join(import.meta.dir, "fixture/process-governor-worker.ts")

  const groupAlive = (pid: number) => {
    try {
      process.kill(-pid, 0)
      return true
    } catch {
      return false
    }
  }

  it.live("queues fairly across governor instances and releases cancelled waiters", () =>
    Effect.gen(function* () {
      const dir = yield* fixture
      const one = ProcessGovernor.make({ ordinary: 1, heavy: 1, dir })
      const two = ProcessGovernor.make({ ordinary: 1, heavy: 1, dir })
      const first = yield* one.acquire("ordinary")
      const order: number[] = []
      const wait = (id: number) =>
        Effect.gen(function* () {
          const lease = yield* two.acquire("ordinary")
          order.push(id)
          yield* lease.release
        })
      const second = yield* wait(2).pipe(Effect.forkScoped)
      yield* waitFor(two.status().pipe(Effect.map((status) => status.ordinary.queued === 1)))
      const cancelled = yield* wait(3).pipe(Effect.forkScoped)
      yield* waitFor(two.status().pipe(Effect.map((status) => status.ordinary.queued === 2)))
      const fourth = yield* wait(4).pipe(Effect.forkScoped)
      yield* waitFor(two.status().pipe(Effect.map((status) => status.ordinary.queued === 3)))
      yield* Fiber.interrupt(cancelled)
      yield* waitFor(two.status().pipe(Effect.map((status) => status.ordinary.queued === 2)))
      expect((yield* two.status()).ordinary).toEqual({ queued: 2, running: 1, limit: 1 })
      yield* first.release
      yield* Fiber.join(second)
      yield* Fiber.join(fourth)
      expect(order).toEqual([2, 4])
      expect((yield* two.status()).ordinary).toEqual({ queued: 0, running: 0, limit: 1 })
    }),
  )

  it.live("keeps ordinary and heavy permits independent", () =>
    Effect.gen(function* () {
      const dir = yield* fixture
      const governor = ProcessGovernor.make({ ordinary: 1, heavy: 1, dir })
      const ordinary = yield* governor.acquire("ordinary")
      const heavy = yield* governor.acquire("heavy")
      expect(yield* governor.status()).toEqual({
        ordinary: { queued: 0, running: 1, limit: 1 },
        heavy: { queued: 0, running: 1, limit: 1 },
      })
      yield* ordinary.release
      yield* heavy.release
    }),
  )

  it.live("shares running and cancelled state across governor instances", () =>
    Effect.gen(function* () {
      const dir = yield* fixture
      const one = ProcessGovernor.make({ ordinary: 1, heavy: 1, dir })
      const lease = yield* one.acquire("heavy")
      const restarted = ProcessGovernor.make({ ordinary: 1, heavy: 1, dir })
      expect((yield* restarted.status()).heavy).toEqual({ queued: 0, running: 1, limit: 1 })

      const waiting = yield* restarted.acquire("heavy").pipe(Effect.forkScoped)
      yield* waitFor(restarted.status().pipe(Effect.map((status) => status.heavy.queued === 1)))
      yield* Fiber.interrupt(waiting)
      yield* waitFor(restarted.status().pipe(Effect.map((status) => status.heavy.queued === 0)))

      yield* lease.release
      expect((yield* restarted.status()).heavy).toEqual({ queued: 0, running: 0, limit: 1 })
    }),
  )

  it.live("release does not delete a slot reclaimed after its owner read", () =>
    Effect.gen(function* () {
      if (process.platform !== "linux") return
      const dir = yield* fixture
      const governor = ProcessGovernor.make({ ordinary: 1, heavy: 1, dir })
      const lease = yield* governor.acquire("ordinary")
      const ownerFile = path.join(lease.slot, "owner.json")
      const previous = yield* Effect.promise(() => readFile(ownerFile, "utf8"))
      yield* Effect.promise(() => rm(ownerFile))
      const fifo = spawnSync("mkfifo", [ownerFile])
      if (fifo.status !== 0) return yield* Effect.die(new Error(`mkfifo failed: ${fifo.stderr.toString()}`))

      const releasing = yield* lease.release.pipe(Effect.forkScoped)
      const ready = path.join(dir, "release-read")
      const writer = spawn(
        process.execPath,
        [
          "-e",
          `const fs = require("node:fs"); const fd = fs.openSync(${JSON.stringify(ownerFile)}, "w"); fs.writeSync(fd, ${JSON.stringify(previous)}); fs.writeFileSync(${JSON.stringify(ready)}, ""); setInterval(() => {}, 30_000)`,
        ],
        { stdio: "ignore" },
      )
      yield* Effect.addFinalizer(() => Effect.sync(() => writer.kill("SIGKILL")).pipe(Effect.ignore))
      yield* waitFor(
        Effect.promise(() =>
          stat(ready).then(
            () => true,
            () => false,
          ),
        ),
      )

      yield* Effect.promise(() => rm(lease.slot, { recursive: true, force: true }))
      yield* Effect.promise(() => mkdir(lease.slot, { mode: 0o700 }))
      const successor = { pid: process.pid, token: randomUUID() }
      yield* Effect.promise(() => writeFile(ownerFile, JSON.stringify(successor), { mode: 0o600 }))
      yield* Effect.promise(() => writeFile(path.join(lease.slot, "token"), successor.token, { mode: 0o600 }))

      yield* Effect.sync(() => writer.kill("SIGTERM"))
      yield* waitFor(Effect.sync(() => writer.exitCode !== null || writer.signalCode !== null))
      yield* Fiber.join(releasing).pipe(Effect.timeout("5 seconds"))
      expect(JSON.parse(yield* Effect.promise(() => readFile(ownerFile, "utf8")))).toEqual(successor)
    }),
  )

  it.live("serializes stale cleaners before breaker replacement", () =>
    Effect.gen(function* () {
      if (process.platform !== "linux") return
      const dir = yield* fixture
      const governor = ProcessGovernor.make({ ordinary: 1, heavy: 1, dir })
      const lease = yield* governor.acquire("ordinary")
      const dead = { pid: 2_147_483_647, start: "0", token: randomUUID() }
      yield* Effect.promise(() => writeFile(path.join(lease.slot, "owner.json"), JSON.stringify(dead)))

      const breaker = `${lease.slot}.breaker`
      yield* Effect.promise(() => writeFile(breaker, JSON.stringify(dead), { mode: 0o600 }))
      const reclaim = `${lease.slot}.breaker-reclaim`
      yield* Effect.promise(() => mkdir(reclaim, { mode: 0o700 }))
      yield* Effect.promise(() =>
        writeFile(path.join(reclaim, "1.ticket"), JSON.stringify({ pid: process.pid, token: randomUUID() }), {
          mode: 0o600,
        }),
      )

      const first = yield* governor.status().pipe(Effect.forkScoped)
      const second = yield* governor.status().pipe(Effect.forkScoped)
      yield* waitFor(
        Effect.promise(() =>
          Promise.all(
            ["2.ticket", "3.ticket"].map((ticket) =>
              stat(path.join(reclaim, ticket)).then(
                () => true,
                () => false,
              ),
            ),
          ).then((ready) => ready.every(Boolean)),
        ),
      )

      const successor = { pid: process.pid, token: randomUUID() }
      yield* Effect.promise(() => rm(breaker))
      yield* Effect.promise(() => writeFile(breaker, JSON.stringify(successor), { mode: 0o600 }))
      yield* Effect.promise(() => writeFile(path.join(reclaim, "1.ticket.done"), "", { mode: 0o600 }))

      const snapshots = yield* Effect.all([Fiber.join(first), Fiber.join(second)])
      expect(snapshots.every((snapshot) => snapshot.ordinary.running === 1)).toBe(true)
      expect(JSON.parse(yield* Effect.promise(() => readFile(breaker, "utf8")))).toEqual(successor)
    }),
  )

  it.live("keeps an adopted slot until the detached process group exits", () =>
    Effect.gen(function* () {
      if (process.platform !== "linux") return
      const dir = yield* fixture
      const governor = ProcessGovernor.make({ ordinary: 1, heavy: 1, dir })
      const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30_000)"], {
        detached: true,
        stdio: "ignore",
      })
      if (!child.pid) return yield* Effect.die(new Error("test child did not start"))
      yield* Effect.addFinalizer(() =>
        Effect.try({ try: () => process.kill(-child.pid!, "SIGKILL"), catch: () => undefined }).pipe(Effect.ignore),
      )
      const lease = yield* governor.acquire("heavy")
      yield* lease.adopt(child.pid, true)
      yield* lease.release
      expect((yield* governor.status()).heavy.running).toBe(1)

      yield* Effect.sync(() => process.kill(-child.pid!, "SIGKILL"))
      yield* waitFor(governor.status().pipe(Effect.map((status) => status.heavy.running === 0)))
    }),
  )

  it.live("keeps a slot when its owner crashes after child handoff", () =>
    Effect.gen(function* () {
      if (process.platform !== "linux") return
      const dir = yield* fixture
      const ready = path.join(dir, "ready.json")
      const started = path.join(dir, "started")
      const owner = spawn(process.execPath, [worker, JSON.stringify({ dir, ready, started, mode: "after" })], {
        cwd: path.join(import.meta.dir, ".."),
        stdio: "ignore",
      })
      yield* Effect.addFinalizer(() => Effect.sync(() => owner.kill("SIGKILL")).pipe(Effect.ignore))
      yield* waitFor(
        Effect.promise(() =>
          stat(ready).then(
            () => true,
            () => false,
          ),
        ),
      )
      const child = JSON.parse(yield* Effect.promise(() => readFile(ready, "utf8"))) as { child: number }
      yield* Effect.addFinalizer(() =>
        Effect.try({ try: () => process.kill(-child.child, "SIGKILL"), catch: () => undefined }).pipe(Effect.ignore),
      )

      yield* Effect.sync(() => owner.kill("SIGKILL"))
      yield* waitFor(Effect.sync(() => owner.exitCode !== null || owner.signalCode !== null))

      const governors = Array.from({ length: 8 }, () => ProcessGovernor.make({ ordinary: 1, heavy: 1, dir }))
      const snapshots = yield* Effect.all(
        governors.map((governor) => governor.status()),
        { concurrency: "unbounded" },
      )
      expect(snapshots.every((status) => status.heavy.running === 1)).toBe(true)

      const waiting = yield* governors[0].acquire("heavy").pipe(Effect.forkScoped)
      yield* waitFor(governors[0].status().pipe(Effect.map((status) => status.heavy.queued === 1)))
      yield* Effect.sync(() => process.kill(-child.child, "SIGKILL"))
      const next = yield* Fiber.join(waiting).pipe(Effect.timeout("5 seconds"))
      expect((yield* governors[0].status()).heavy).toEqual({ queued: 0, running: 1, limit: 1 })
      yield* next.release
    }),
  )

  it.live("keeps a slot when its owner crashes during child handoff", () =>
    Effect.gen(function* () {
      if (process.platform !== "linux") return
      const dir = yield* fixture
      const ready = path.join(dir, "ready.json")
      const started = path.join(dir, "started")
      const owner = spawn(process.execPath, [worker, JSON.stringify({ dir, ready, started, mode: "during" })], {
        cwd: path.join(import.meta.dir, ".."),
        stdio: "ignore",
      })
      yield* Effect.addFinalizer(() => Effect.sync(() => owner.kill("SIGKILL")).pipe(Effect.ignore))
      yield* waitFor(
        Effect.promise(() =>
          stat(ready).then(
            () => true,
            () => false,
          ),
        ),
      )
      const child = JSON.parse(yield* Effect.promise(() => readFile(ready, "utf8"))) as {
        child: number
        fifo: string
        token: string
      }
      yield* Effect.addFinalizer(() =>
        Effect.try({ try: () => process.kill(-child.child, "SIGKILL"), catch: () => undefined }).pipe(Effect.ignore),
      )

      yield* Effect.sync(() => owner.kill("SIGKILL"))
      yield* waitFor(Effect.sync(() => owner.exitCode !== null || owner.signalCode !== null))
      const old = new Date(0)
      yield* Effect.promise(() => utimes(`${path.dirname(child.fifo)}.breaker`, old, old))

      const governor = ProcessGovernor.make({ ordinary: 1, heavy: 1, dir })
      expect((yield* governor.status()).heavy).toEqual({ queued: 0, running: 1, limit: 1 })
      const waiting = yield* governor.acquire("heavy").pipe(Effect.forkScoped)
      yield* waitFor(governor.status().pipe(Effect.map((status) => status.heavy.queued === 1)))

      yield* Effect.promise(() => writeFile(child.fifo, child.token))
      yield* waitFor(
        Effect.promise(() =>
          stat(started).then(
            () => true,
            () => false,
          ),
        ),
      )
      expect((yield* governor.status()).heavy).toEqual({ queued: 1, running: 1, limit: 1 })

      yield* Effect.sync(() => process.kill(-child.child, "SIGKILL"))
      const next = yield* Fiber.join(waiting).pipe(Effect.timeout("5 seconds"))
      expect((yield* governor.status()).heavy).toEqual({ queued: 0, running: 1, limit: 1 })
      yield* next.release
    }),
  )

  it.live("does not start a child when stale cleanup wins before handoff", () =>
    Effect.gen(function* () {
      if (process.platform !== "linux") return
      const dir = yield* fixture
      const ready = path.join(dir, "ready.json")
      const started = path.join(dir, "started")
      const owner = spawn(process.execPath, [worker, JSON.stringify({ dir, ready, started, mode: "before" })], {
        cwd: path.join(import.meta.dir, ".."),
        stdio: "ignore",
      })
      yield* Effect.addFinalizer(() => Effect.sync(() => owner.kill("SIGKILL")).pipe(Effect.ignore))
      yield* waitFor(
        Effect.promise(() =>
          stat(ready).then(
            () => true,
            () => false,
          ),
        ),
      )
      const child = JSON.parse(yield* Effect.promise(() => readFile(ready, "utf8"))) as { child: number }
      yield* Effect.addFinalizer(() =>
        Effect.try({ try: () => process.kill(-child.child, "SIGKILL"), catch: () => undefined }).pipe(Effect.ignore),
      )

      yield* Effect.sync(() => owner.kill("SIGKILL"))
      yield* waitFor(Effect.sync(() => owner.exitCode !== null || owner.signalCode !== null))
      const governor = ProcessGovernor.make({ ordinary: 1, heavy: 1, dir })
      const replacement = yield* governor.acquire("heavy")

      yield* Effect.sync(() => process.kill(-child.child, "SIGCONT"))
      yield* waitFor(Effect.sync(() => !groupAlive(child.child)))
      expect(
        yield* Effect.promise(() =>
          stat(started).then(
            () => true,
            () => false,
          ),
        ),
      ).toBe(false)
      expect((yield* governor.status()).heavy).toEqual({ queued: 0, running: 1, limit: 1 })
      yield* replacement.release
    }),
  )
})
