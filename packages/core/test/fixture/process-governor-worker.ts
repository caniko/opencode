import { spawn, spawnSync } from "node:child_process"
import { rm, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import { Effect } from "effect"
import { ProcessGovernor } from "@opencode-ai/core/process-governor"

const input = JSON.parse(process.argv[2] ?? "") as {
  dir: string
  ready: string
  started: string
  mode: "before" | "during" | "after"
}
const lease = await Effect.runPromise(ProcessGovernor.make({ ordinary: 1, heavy: 1, dir: input.dir }).acquire("heavy"))
const fifo = path.join(lease.slot, "token")
if (input.mode === "during") {
  await rm(fifo)
  const result = spawnSync("mkfifo", [fifo])
  if (result.status !== 0) throw new Error(`mkfifo failed: ${result.stderr.toString()}`)
}
const guarded = ProcessGovernor.handoff(
  lease,
  process.execPath,
  ["-e", `require("node:fs").writeFileSync(${JSON.stringify(input.started)}, ""); setTimeout(() => {}, 30_000)`],
  undefined,
)
const paused = `${input.ready}.paused`
const child = spawn(
  input.mode === "before" ? "/bin/sh" : guarded.command,
  input.mode === "before"
    ? [
        "-c",
        'printf ready > "$1"; kill -STOP $$; shift; exec "$@"',
        "opencode-governor-test",
        paused,
        guarded.command,
        ...guarded.args,
      ]
    : guarded.args,
  {
    detached: true,
    stdio: "ignore",
  },
)
if (!child.pid) throw new Error("test child did not start")
child.unref()
const marker = input.mode === "before" ? paused : input.mode === "during" ? `${lease.slot}.breaker` : input.started
while (
  !(await stat(marker).then(
    () => true,
    () => false,
  ))
)
  await Bun.sleep(5)
await writeFile(
  input.ready,
  JSON.stringify({ child: child.pid, fifo: input.mode === "during" ? fifo : undefined, token: lease.token }),
)
setInterval(() => {}, 30_000)
