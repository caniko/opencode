import { spawn as create } from "bun-pty"
import type { Opts, Proc } from "./pty"
import { which } from "../util/which"

export type { Disp, Exit, Opts, Proc } from "./pty"

export function spawn(file: string, args: string[], opts: Opts): Proc {
  // bun-pty 0.4.8 inherits in its native CommandBuilder. Remove omitted keys
  // without putting their values in argv. Retire when bun-pty supports env_clear.
  const unset = opts.exactEnv ? Object.keys(process.env).filter((key) => !Object.hasOwn(opts.env ?? {}, key)) : []
  if (unset.length) {
    const env = which("env")
    if (!env) throw new Error("Exact PTY environments require the host env executable")
    args = [...unset.flatMap((key) => ["-u", key]), "--", file, ...args]
    file = env
  }
  const pty = create(file, args, opts)
  return {
    pid: pty.pid,
    onData(listener) {
      return pty.onData(listener)
    },
    onExit(listener) {
      return pty.onExit(listener)
    },
    write(data) {
      pty.write(data)
    },
    resize(cols, rows) {
      pty.resize(cols, rows)
    },
    kill(signal) {
      pty.kill(signal)
    },
  }
}
