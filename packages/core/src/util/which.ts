import whichPkg from "which"
import path from "path"
import { Global } from "../global"

export function which(cmd: string, env?: NodeJS.ProcessEnv, cwd?: string) {
  // An explicitly provided environment is complete: a missing PATH means
  // "no search path", never "restore the backend PATH". Only an absent env
  // falls back to the process. An empty PATH still resolves the cwd itself.
  const base = env ? (env.PATH ?? env.Path) : (process.env.PATH ?? process.env.Path)
  const full = cwd
    ? [
        ...(base === undefined ? [] : base.split(path.delimiter).map((dir) => path.resolve(cwd, dir))),
        Global.Path.bin,
      ].join(path.delimiter)
    : base
      ? base + path.delimiter + Global.Path.bin
      : Global.Path.bin
  const command =
    cwd && (cmd.includes("/") || (process.platform === "win32" && cmd.includes("\\"))) ? path.resolve(cwd, cmd) : cmd
  const result = whichPkg.sync(command, {
    nothrow: true,
    path: full,
    pathExt: env ? (env.PATHEXT ?? env.PathExt ?? "") : (process.env.PATHEXT ?? process.env.PathExt ?? ""),
  })
  return typeof result === "string" ? result : null
}
