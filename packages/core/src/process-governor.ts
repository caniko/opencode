export * as ProcessGovernor from "./process-governor"

import { randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import { link, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Effect } from "effect"
import type { ChildProcess } from "effect/unstable/process"

export type Class = "ordinary" | "heavy"

export const CLASS_ENV = "OPENCODE_INTERNAL_PROCESS_CLASS"

const BROKEN_GRACE_MS = 5_000
const POLL_MS = 50

const standalone = new Set([
  "bazel",
  "bazelisk",
  "cmake",
  "make",
  "meson",
  "ninja",
  "nixos-rebuild",
  "node-gyp",
  "nox",
  "pytest",
  "rustc",
  "scons",
  "tox",
])

const subcommands = new Map([
  ["bun", new Set(["build", "test", "typecheck"])],
  ["canix", new Set(["crossbow", "rebuild"])],
  ["cargo", new Set(["bench", "build", "check", "clippy", "install", "nextest", "run", "test"])],
  ["go", new Set(["build", "install", "test"])],
  ["dotnet", new Set(["build", "publish", "test"])],
  ["gradle", new Set(["assemble", "build", "check", "test"])],
  ["gradlew", new Set(["assemble", "build", "check", "test"])],
  ["mvn", new Set(["compile", "install", "package", "test", "verify"])],
  ["mvnw", new Set(["compile", "install", "package", "test", "verify"])],
  ["npm", new Set(["build", "test", "typecheck"])],
  ["pnpm", new Set(["build", "test", "typecheck"])],
  ["yarn", new Set(["build", "test", "typecheck"])],
  ["zig", new Set(["build", "test"])],
])

const wrappers = new Map<string, ReadonlyMap<string, number>>([
  ["command", new Map()],
  ["doas", new Map([["-u", 1]])],
  ["exec", new Map()],
  ["nice", new Map([["-n", 1]])],
  ["nohup", new Map()],
  [
    "sudo",
    new Map([
      ["-u", 1],
      ["--user", 1],
      ["-g", 1],
      ["--group", 1],
      ["-D", 1],
      ["--chdir", 1],
    ]),
  ],
  [
    "time",
    new Map([
      ["-f", 1],
      ["--format", 1],
      ["-o", 1],
      ["--output", 1],
    ]),
  ],
  [
    "timeout",
    new Map([
      ["-k", 1],
      ["--kill-after", 1],
      ["-s", 1],
      ["--signal", 1],
    ]),
  ],
])

const globalOptions = new Map<string, ReadonlyMap<string, number>>([
  [
    "cargo",
    new Map([
      ["--config", 1],
      ["--color", 1],
      ["--jobs", 1],
      ["-j", 1],
      ["--manifest-path", 1],
      ["--target-dir", 1],
      ["-Z", 1],
    ]),
  ],
  [
    "nix",
    new Map([
      ["--builders", 1],
      ["--connect-timeout", 1],
      ["--eval-store", 1],
      ["--extra-experimental-features", 1],
      ["--log-format", 1],
      ["--max-jobs", 1],
      ["--option", 2],
      ["--store", 1],
      ["--system", 1],
    ]),
  ],
  ["canix", new Map([["--output", 1]])],
  ["go", new Map([["-C", 1]])],
])

type Owner = {
  pid: number
  start: string | undefined
  token: string
  group?: boolean
}

export interface Lease {
  readonly token: string
  readonly slot: string
  adopt(pid: number, group?: boolean): Effect.Effect<void>
  release: Effect.Effect<void>
}

export interface GuardedCommand {
  readonly command: string
  readonly args: ReadonlyArray<string>
  readonly shell: boolean | string | undefined
}

export interface Status {
  ordinary: { queued: number; running: number; limit: number }
  heavy: { queued: number; running: number; limit: number }
}

function name(token: string) {
  return path
    .basename(token.replace(/^(['"])(.*)\1$/, "$2"))
    .replace(/\.exe$/i, "")
    .toLowerCase()
}

function next(tokens: ReadonlyArray<string>, start: number, values: ReadonlyMap<string, number> = new Map()) {
  for (let index = start; index < tokens.length; index++) {
    const token = tokens[index]
    if (token === "--") return tokens[index + 1] ? { value: tokens[index + 1], index: index + 1 } : undefined
    if (token.startsWith("+") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) continue
    if (!token.startsWith("-")) return { value: token, index }
    const inline = token.includes("=")
    const option = inline ? token.slice(0, token.indexOf("=")) : token
    if (!inline) index += values.get(option) ?? 0
  }
}

function unwrap(tokens: ReadonlyArray<string>) {
  let index = 0
  while (index < tokens.length) {
    const command = name(tokens[index])
    if (command === "env") {
      const nextCommand = next(
        tokens,
        index + 1,
        new Map([
          ["-u", 1],
          ["--unset", 1],
          ["-C", 1],
          ["--chdir", 1],
        ]),
      )
      if (!nextCommand) return
      index = nextCommand.index
      continue
    }
    const options = wrappers.get(command)
    if (!options) return { command, index }
    const nextCommand = next(tokens, index + 1, options)
    if (!nextCommand) return
    index = nextCommand.index
    if (command === "timeout") index++
  }
}

export function classify(tokens: ReadonlyArray<string>): Class {
  const normalized = tokens.map((token) => token.replace(/^(['"])(.*)\1$/, "$2"))
  const executable = unwrap(normalized)
  if (!executable) return "ordinary"
  if (["bash", "dash", "fish", "sh", "zsh", "pwsh", "powershell"].includes(executable.command)) {
    const flag = normalized.findIndex((token, index) => index > executable.index && /^-[^-]*c/.test(token))
    return flag >= 0 && normalized[flag + 1] ? classifyShell(normalized[flag + 1]) : "ordinary"
  }
  if (standalone.has(executable.command)) return "heavy"
  if (["python", "python3", "python3.12", "python3.13", "python3.14"].includes(executable.command)) {
    const module = normalized.indexOf("-m", executable.index + 1)
    if (module >= 0 && normalized[module + 1] === "pytest") return "heavy"
  }
  const action = next(normalized, executable.index + 1, globalOptions.get(executable.command))
  if (!action) return "ordinary"
  if (executable.command === "nix") {
    if (["build", "develop", "run", "shell"].includes(action.value)) return "heavy"
    if (action.value === "flake" && next(normalized, action.index + 1)?.value === "check") return "heavy"
    return "ordinary"
  }
  if (executable.command === "canix") {
    if (["crossbow", "deploy", "rebuild"].includes(action.value)) return "heavy"
    if (action.value === "repo" && next(normalized, action.index + 1)?.value === "check") return "heavy"
    return "ordinary"
  }
  const heavy = subcommands.get(executable.command)
  if (!heavy) return "ordinary"
  if (action.value !== "run") return heavy.has(action.value) ? "heavy" : "ordinary"
  const script = next(normalized, action.index + 1)
  if (executable.command === "cargo") return "heavy"
  if (script && heavy.has(script.value)) return "heavy"
  return "ordinary"
}

export function classifyShell(command: string): Class {
  const commands: string[][] = [[]]
  let token = ""
  let quote = ""
  let escaped = false
  const push = () => {
    if (!token) return
    commands.at(-1)?.push(token)
    token = ""
  }
  const split = () => {
    push()
    if (commands.at(-1)?.length) commands.push([])
  }
  for (const char of command) {
    if (escaped) {
      token += char
      escaped = false
      continue
    }
    if (char === "\\" && quote !== "'") {
      escaped = true
      continue
    }
    if (quote) {
      if (char === quote) quote = ""
      else token += char
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      continue
    }
    if (char === "\n") {
      split()
      continue
    }
    if (/\s/.test(char)) {
      push()
      continue
    }
    if ([";", "&", "|", "(", ")"].includes(char)) {
      split()
      continue
    }
    token += char
  }
  split()
  return commands.some(
    (tokens) =>
      classify(
        tokens.filter(
          (value) => !["!", "{", "}", "do", "done", "elif", "else", "if", "then", "until", "while"].includes(value),
        ),
      ) === "heavy",
  )
    ? "heavy"
    : "ordinary"
}

export function mark(command: ChildProcess.Command, processClass: Class): ChildProcess.Command {
  if (command._tag === "PipedCommand") {
    return { ...command, left: mark(command.left, processClass), right: mark(command.right, processClass) }
  }
  return {
    ...command,
    options: {
      ...command.options,
      env: { ...command.options.env, [CLASS_ENV]: processClass },
      extendEnv: command.options.env === undefined ? true : command.options.extendEnv,
    },
  }
}

function limit(key: string, fallback: number, max?: number) {
  const raw = process.env[key]
  if (raw === undefined) return fallback
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < 1 || (max !== undefined && value > max)) {
    throw new Error(`${key} must be an integer between 1 and ${max ?? Number.MAX_SAFE_INTEGER}`)
  }
  return value
}

function runtimeRoot() {
  const uid = process.getuid?.()
  const systemd = uid === undefined ? undefined : `/run/user/${uid}`
  const base = systemd && existsSync(systemd) ? systemd : path.join(os.tmpdir(), `opencode-${uid ?? "user"}`)
  return path.join(base, "opencode", "tool-governor")
}

function code(error: unknown) {
  if (!error || typeof error !== "object" || !("code" in error)) return
  return typeof error.code === "string" ? error.code : undefined
}

async function processStart(pid: number) {
  if (process.platform !== "linux") return
  return readFile(`/proc/${pid}/stat`, "utf8")
    .then((value) => value.slice(value.lastIndexOf(")") + 2).split(" ")[19])
    .catch(() => undefined)
}

function owner(raw: string): Owner | undefined {
  const value = (() => {
    try {
      return JSON.parse(raw)
    } catch {
      return undefined
    }
  })()
  if (!value || typeof value !== "object") return
  if (!("pid" in value) || !Number.isSafeInteger(value.pid) || value.pid < 1) return
  if (!("token" in value) || typeof value.token !== "string") return
  if ("start" in value && value.start !== undefined && typeof value.start !== "string") return
  if ("group" in value && value.group !== undefined && typeof value.group !== "boolean") return
  return {
    pid: value.pid,
    start: "start" in value ? value.start : undefined,
    token: value.token,
    group: "group" in value ? value.group : undefined,
  }
}

async function alive(value: Owner) {
  if (process.platform === "linux" && value.group) {
    try {
      process.kill(-value.pid, 0)
      return true
    } catch (error) {
      return code(error) === "EPERM"
    }
  }
  if (process.platform === "linux" && value.start !== undefined) return (await processStart(value.pid)) === value.start
  try {
    process.kill(value.pid, 0)
    return true
  } catch (error) {
    return code(error) === "EPERM"
  }
}

async function readOwner(file: string) {
  return readFile(file, "utf8")
    .then(owner)
    .catch(() => undefined)
}

function sameOwner(left: Owner | undefined, right: Owner | undefined) {
  return (
    left !== undefined &&
    right !== undefined &&
    left.pid === right.pid &&
    left.start === right.start &&
    left.token === right.token &&
    left.group === right.group
  )
}

async function removeStale(file: string, ownerFile = file) {
  const current = await readOwner(ownerFile)
  if (current) {
    if (await alive(current)) return false
    await rm(file, { recursive: true, force: true })
    return true
  }
  const info = await stat(file).catch(() => undefined)
  if (!info || Date.now() - info.mtimeMs < BROKEN_GRACE_MS) return false
  await rm(file, { recursive: true, force: true })
  return true
}

async function claimOwner(file: string, value: Owner) {
  const candidate = `${file}.${value.token}.tmp`
  await writeFile(candidate, JSON.stringify(value), { flag: "wx", mode: 0o600 })
  return link(candidate, file)
    .then(
      () => true,
      (error) => {
        if (code(error) === "EEXIST") return false
        throw error
      },
    )
    .finally(() => rm(candidate, { force: true }))
}

function sequence(file: string) {
  const match = /^(\d+)\.ticket$/.exec(file)
  if (!match) return
  const value = Number(match[1])
  return Number.isSafeInteger(value) ? value : undefined
}

async function finishReclaimer(ticket: string) {
  await writeFile(`${ticket}.done`, "", { flag: "wx", mode: 0o600 }).catch((error) => {
    if (code(error) !== "EEXIST") throw error
  })
}

async function claimReclaimer(file: string) {
  const dir = `${file}.breaker-reclaim`
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const value = { pid: process.pid, start: await processStart(process.pid), token: randomUUID() }
  // ponytail: stale-recovery tickets are append-only per boot; use kernel flock if crash volume makes scans material.
  while (true) {
    const entries = await readdir(dir)
    const highest = entries.reduce((max, entry) => Math.max(max, sequence(entry) ?? 0), 0)
    if (highest >= Number.MAX_SAFE_INTEGER) throw new Error("process governor breaker sequence exhausted")
    const current = highest + 1
    const ticket = path.join(dir, `${current}.ticket`)
    if (!(await claimOwner(ticket, value))) continue
    while (true) {
      const lower = (await readdir(dir))
        .map((entry) => ({ entry, sequence: sequence(entry) }))
        .filter(
          (entry): entry is { entry: string; sequence: number } =>
            entry.sequence !== undefined && entry.sequence < current,
        )
      let blocked = false
      for (const entry of lower) {
        const previous = path.join(dir, entry.entry)
        const done = await stat(`${previous}.done`).catch(() => undefined)
        if (done) continue
        const owner = await readOwner(previous)
        if (owner && (await alive(owner))) {
          blocked = true
          break
        }
        await finishReclaimer(previous)
      }
      if (!blocked) return ticket
      await new Promise((resolve) => setTimeout(resolve, POLL_MS))
    }
  }
}

async function reclaimBreaker(file: string) {
  const breaker = `${file}.breaker`
  const ticket = await claimReclaimer(file)
  try {
    const current = await readOwner(breaker)
    if (current && (await alive(current))) return true
    const info = await stat(breaker).catch(() => undefined)
    if (!info) return false
    if (!current && Date.now() - info.mtimeMs < BROKEN_GRACE_MS) return true
    await rm(breaker, { recursive: true, force: true })
    return false
  } finally {
    await finishReclaimer(ticket)
  }
}

async function breakerActive(file: string) {
  const breaker = `${file}.breaker`
  const current = await readOwner(breaker)
  if (current && (await alive(current))) return true
  const info = await stat(breaker).catch(() => undefined)
  if (!info) return false
  if (!current && Date.now() - info.mtimeMs < BROKEN_GRACE_MS) return true
  return reclaimBreaker(file)
}

async function claimBreaker(file: string) {
  if (await breakerActive(file)) return
  const breaker = `${file}.breaker`
  const value = { pid: process.pid, start: await processStart(process.pid), token: randomUUID() }
  return (await claimOwner(breaker, value)) ? value : undefined
}

async function ownsBreaker(file: string, value: Owner) {
  return sameOwner(value, await readOwner(`${file}.breaker`))
}

async function releaseBreaker(file: string, value: Owner) {
  if (!(await ownsBreaker(file, value))) return
  await rm(`${file}.breaker`, { recursive: true, force: true })
}

async function removeStaleSlot(file: string) {
  const claimed = await claimBreaker(file)
  if (!claimed) return false
  try {
    const current = await readOwner(path.join(file, "owner.json"))
    if (current && (await alive(current))) return false
    if (!current) {
      const info = await stat(file).catch(() => undefined)
      if (!info || Date.now() - info.mtimeMs < BROKEN_GRACE_MS) return false
    }
    const latest = await readOwner(path.join(file, "owner.json"))
    if (current && (!sameOwner(current, latest) || (latest && (await alive(latest))))) return false
    if (!(await ownsBreaker(file, claimed))) return false
    await rm(file, { recursive: true, force: true })
    return true
  } finally {
    await releaseBreaker(file, claimed)
  }
}

function sleep(signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason ?? new Error("Aborted"))
    const timer = setTimeout(done, POLL_MS)
    function done() {
      signal.removeEventListener("abort", abort)
      resolve()
    }
    function abort() {
      clearTimeout(timer)
      signal.removeEventListener("abort", abort)
      reject(signal.reason ?? new Error("Aborted"))
    }
    signal.addEventListener("abort", abort, { once: true })
  })
}

async function writeAtomic(file: string, value: Owner) {
  const tmp = path.join(path.dirname(file), `.tmp-${value.token}`)
  await writeFile(tmp, JSON.stringify(value), { flag: "wx", mode: 0o600 })
  await rename(tmp, file).catch(async (error) => {
    await rm(tmp, { force: true })
    throw error
  })
}

async function queue(root: string, processClass: Class) {
  const dir = path.join(root, `${processClass}-queue`)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const entries = (await readdir(dir)).filter((entry) => entry.endsWith(".json")).sort()
  const live: string[] = []
  for (const entry of entries) {
    const file = path.join(dir, entry)
    if (!(await removeStale(file))) live.push(entry)
  }
  return { dir, entries: live }
}

async function slots(root: string, processClass: Class, count: number) {
  const result: Array<{ file: string; free: boolean }> = []
  for (let index = 0; index < count; index++) {
    const file = path.join(root, `${processClass}-${index}.lock`)
    if (await breakerActive(file)) {
      result.push({ file, free: false })
      continue
    }
    const exists = await stat(file).then(
      () => true,
      () => false,
    )
    result.push({ file, free: !exists || (await removeStaleSlot(file)) })
  }
  return result
}

async function trySlot(file: string, value: Owner) {
  const tmp = `${file}.${value.token}.tmp`
  await mkdir(tmp, { mode: 0o700 })
  await writeFile(path.join(tmp, "owner.json"), JSON.stringify(value), { mode: 0o600 })
  await writeFile(path.join(tmp, "token"), value.token, { mode: 0o600 })
  return rename(tmp, file).then(
    () => true,
    async (error) => {
      await rm(tmp, { recursive: true, force: true })
      if (["EEXIST", "ENOTEMPTY", "EPERM"].includes(code(error) ?? "")) return false
      throw error
    },
  )
}

async function claimLeaseBreaker(file: string, token: string) {
  const ownerFile = path.join(file, "owner.json")
  while (true) {
    const breaker = await claimBreaker(file)
    if (breaker) return breaker
    const current = await readOwner(ownerFile)
    if (!current || current.token !== token) return
    await new Promise((resolve) => setTimeout(resolve, POLL_MS))
  }
}

async function release(file: string, token: string) {
  const ownerFile = path.join(file, "owner.json")
  const claimed = await claimLeaseBreaker(file, token)
  if (!claimed) return
  try {
    const current = await readOwner(ownerFile)
    if (!current || current.token !== token) return
    if (current.group && (await alive(current))) return
    const latest = await readOwner(ownerFile)
    if (!sameOwner(current, latest) || (latest?.group && (await alive(latest)))) return
    if (!(await ownsBreaker(file, claimed))) return
    await rm(file, { recursive: true, force: true })
  } finally {
    await releaseBreaker(file, claimed)
  }
}

async function adopt(file: string, token: string, pid: number, group?: boolean) {
  const ownerFile = path.join(file, "owner.json")
  const claimed = await claimLeaseBreaker(file, token)
  if (!claimed) throw new Error("process governor lease is no longer owned by this process")
  try {
    const current = await readOwner(ownerFile)
    if (!current || current.token !== token || !(await ownsBreaker(file, claimed))) {
      throw new Error("process governor lease is no longer owned by this process")
    }
    await writeAtomic(ownerFile, { pid, start: await processStart(pid), token, group })
  } finally {
    await releaseBreaker(file, claimed)
  }
}

export function make(input: { ordinary: number; heavy: number; dir?: string }) {
  const root = input.dir ?? runtimeRoot()
  const counts = { ordinary: input.ordinary, heavy: input.heavy }

  const acquire = (processClass: Class) =>
    Effect.promise(async (signal) => {
      await mkdir(root, { recursive: true, mode: 0o700 })
      const token = randomUUID()
      const value = { pid: process.pid, start: await processStart(process.pid), token }
      const pending = await queue(root, processClass)
      const ticket = `${String(Date.now()).padStart(13, "0")}-${token}.json`
      const ticketPath = path.join(pending.dir, ticket)
      let slot: string | undefined
      let transferred = false
      await writeAtomic(ticketPath, value)
      try {
        while (true) {
          signal.throwIfAborted()
          const waiting = await queue(root, processClass)
          const available = await slots(root, processClass, counts[processClass])
          const free = available.filter((item) => item.free)
          // ponytail: O(n) runtime-dir scan; replace with a broker only if queue volume becomes material.
          const position = waiting.entries.indexOf(ticket)
          if (position >= 0 && position < free.length) {
            for (const item of free) {
              if (!(await trySlot(item.file, value))) continue
              slot = item.file
              await rm(ticketPath, { force: true })
              signal.throwIfAborted()
              let released = false
              transferred = true
              return {
                token,
                slot: item.file,
                adopt: (pid: number, group?: boolean) => Effect.promise(() => adopt(item.file, token, pid, group)),
                release: Effect.promise(async () => {
                  if (released) return
                  released = true
                  await release(item.file, token)
                }),
              } satisfies Lease
            }
          }
          await sleep(signal)
        }
      } finally {
        await rm(ticketPath, { force: true })
        if (slot && !transferred) await release(slot, token)
      }
    })

  const status = () =>
    Effect.promise(async () => {
      await mkdir(root, { recursive: true, mode: 0o700 })
      const snapshot = async (processClass: Class) => {
        const waiting = await queue(root, processClass)
        const current = await slots(root, processClass, counts[processClass])
        return {
          queued: waiting.entries.length,
          running: current.filter((item) => !item.free).length,
          limit: counts[processClass],
        }
      }
      return {
        ordinary: await snapshot("ordinary"),
        heavy: await snapshot("heavy"),
      } satisfies Status
    })

  return { acquire, status }
}

const HANDOFF = `slot=$1
token=$2
shift 2
breaker="$slot.breaker"
breaker_token="$token-$$"
process_start() {
  raw=$(cat "/proc/$$/stat" 2>/dev/null) || return
  rest=\${raw##*) }
  set -- $rest
  printf %s "\${20}"
}
start=$(process_start)
if [ -n "$start" ]; then
  breaker_owner=$(printf '{"pid":%s,"start":"%s","token":"%s"}' "$$" "$start" "$breaker_token")
else
  breaker_owner=$(printf '{"pid":%s,"token":"%s"}' "$$" "$breaker_token")
fi
candidate="$breaker.$breaker_token.tmp"
attempts=0
while :; do
  printf %s "$breaker_owner" > "$candidate" || exit 125
  if ln "$candidate" "$breaker" 2>/dev/null; then
    rm -f "$candidate"
    break
  fi
  rm -f "$candidate"
  [ -d "$slot" ] || exit 125
  attempts=$((attempts + 1))
  [ "$attempts" -lt 500 ] || exit 125
  sleep 0.01
done
owned() { [ "$(cat "$breaker" 2>/dev/null)" = "$breaker_owner" ]; }
cleanup() {
  rm -f "$candidate"
  if owned; then rm -f "$breaker"; fi
}
trap cleanup EXIT
trap 'exit 125' HUP INT TERM
[ "$(cat "$slot/token" 2>/dev/null)" = "$token" ] || exit 125
owned || exit 125
tmp="$slot/.owner-$token"
printf '{"pid":%s,"token":"%s","group":true}' "$$" "$token" > "$tmp" || exit 125
owned || exit 125
mv "$tmp" "$slot/owner.json" || exit 125
owned || exit 125
cleanup
trap - EXIT HUP INT TERM
exec "$@"`

export function handoff(
  lease: Lease,
  command: string,
  args: ReadonlyArray<string>,
  shell: boolean | string | undefined,
): GuardedCommand {
  if (process.platform === "win32") return { command, args, shell }
  const target = shell ? [typeof shell === "string" ? shell : "/bin/sh", "-c", command] : [command, ...args]
  return {
    command: "/bin/sh",
    args: ["-c", HANDOFF, "opencode-governor", lease.slot, lease.token, ...target],
    shell: false,
  }
}

const governor = make({
  ordinary: limit("OPENCODE_TOOL_ORDINARY_CONCURRENCY", 6, 6),
  heavy: limit("OPENCODE_TOOL_HEAVY_CONCURRENCY", 1, 2),
})

export const acquire = governor.acquire
export const status = governor.status
