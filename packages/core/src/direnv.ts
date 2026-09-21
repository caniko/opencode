export * as Direnv from "./direnv.ts"

import { execFile } from "node:child_process"
import { constants } from "node:fs"
import { access } from "node:fs/promises"
import path from "node:path"
import { promisify } from "node:util"

const exec = promisify(execFile)

/** Resolve a child environment without changing the shared backend's environment. */
export async function environment(cwd: string, base: NodeJS.ProcessEnv = process.env, signal?: AbortSignal) {
  const env = Object.fromEntries(Object.entries(base).filter((entry): entry is [string, string] => entry[1] !== undefined))
  const options = { cwd, env, signal, timeout: 120_000, maxBuffer: 8 * 1024 * 1024 }
  const status = await exec("direnv", ["status", "--json"], options).catch(async (error) => {
    if (error.code !== "ENOENT") throw new Error(`Cannot inspect direnv in ${cwd}; run direnv status in that directory.`)
    // Direnv is optional outside projects that declare an environment.
    for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
      const found = await access(path.join(dir, ".envrc")).then(() => true, () => false)
      if (found) throw new Error(`direnv is missing from the backend PATH; required by ${dir}/.envrc`)
      if (path.dirname(dir) === dir) return undefined
    }
  })
  if (!status) return env
  const state = JSON.parse(status.stdout)?.state
  if (!state || !("foundRC" in state)) throw new Error(`Invalid direnv status in ${cwd}`)
  if (state.foundRC && state.foundRC.allowed !== 0) {
    throw new Error(`direnv environment is not approved in ${cwd}; review its .envrc and approve it explicitly.`)
  }
  if (!state.foundRC && !state.loadedRC) return env
  const dump = (await Promise.all((env.PATH ?? "").split(path.delimiter).filter(Boolean).map(async (dir) => {
    const file = path.resolve(dir, "env")
    return access(file, constants.X_OK).then(() => file, () => undefined)
  }))).find((file) => file !== undefined)
  if (!dump) throw new Error("env is missing from the backend PATH; required to read the direnv environment")
  // `export json` can exit successfully after an .envrc failure. `exec` fails closed.
  const result = await exec("direnv", ["exec", cwd, dump, "-0"], options).catch(() => {
    throw new Error(`Cannot load direnv in ${cwd}; repair its environment before running project commands.`)
  })
  const resolved = Object.fromEntries(result.stdout.split("\0").filter(Boolean).map((entry) => {
    const separator = entry.indexOf("=")
    if (separator < 1) throw new Error(`Invalid direnv environment in ${cwd}`)
    return [entry.slice(0, separator), entry.slice(separator + 1)]
  }))
  if (resolved.NIX_DIRENV_DID_FALLBACK === "1") {
    throw new Error(`direnv used a stale fallback in ${cwd}; refresh the development environment before continuing.`)
  }
  return resolved
}
