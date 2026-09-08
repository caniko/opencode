import whichPkg from "which"
import path from "path"
import { Global } from "../global"

export function which(cmd: string, env?: NodeJS.ProcessEnv, cwd?: string) {
  const base = cwd ? (env?.PATH ?? env?.Path) : (env?.PATH ?? env?.Path ?? process.env.PATH ?? process.env.Path)
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
    pathExt: cwd
      ? (env?.PATHEXT ?? env?.PathExt ?? "")
      : (env?.PATHEXT ?? env?.PathExt ?? process.env.PATHEXT ?? process.env.PathExt),
  })
  return typeof result === "string" ? result : null
}
