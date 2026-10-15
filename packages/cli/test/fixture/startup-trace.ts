// Test-only preload: keep lifecycle evidence on stderr without retaining the process.
import path from "node:path"
import { startupArgs } from "./startup-args"

process.env.OPENCODE_PRINT_LOGS = "1"
process.env.OPENCODE_LOG_LEVEL = "DEBUG"
const started = performance.now()
let previous = started

function report(phase: string) {
  const now = performance.now()
  console.error(
    "subprocess-startup",
    JSON.stringify({
      phase,
      pid: process.pid,
      ppid: process.ppid,
      timestamp: new Date().toISOString(),
      elapsed: now - started,
      gap: now - previous,
      cpu: process.cpuUsage(),
      rss: process.memoryUsage.rss(),
    }),
  )
  previous = now
}

report("preload")
setInterval(() => report("heartbeat"), 500).unref()
process.on("exit", () => report("exit"))

// selfCommand starts ACP's private server without forwarding execArgv. Bun's
// documented environment route keeps the same tracer/config in that descendant.
const inherited = startupArgs()
  .map((arg) => JSON.stringify(arg.replaceAll("\\", "/")))
  .join(" ")
if (inherited && !process.env.BUN_OPTIONS?.includes(inherited)) {
  process.env.BUN_OPTIONS = [process.env.BUN_OPTIONS, inherited].filter(Boolean).join(" ")
}

if (process.env.OPENCODE_TEST_STARTUP_PROFILE_DIR) {
  const { profile } = await import("bun:jsc")
  const directory = process.env.OPENCODE_TEST_STARTUP_PROFILE_DIR
  async function sample() {
    // Flush bounded chunks while the child is alive: SIGKILL cannot flush an
    // exit-only CPU profile. Timers stay unref'd so profiling never owns its life.
    for (const index of [0, 1, 2, 3, 4]) {
      const begin = performance.now()
      const result = await profile(() => new Promise<void>((resolve) => setTimeout(resolve, 4000).unref()), 10_000)
      await Bun.write(
        path.join(directory, `child-${process.pid}-${index}.json`),
        JSON.stringify({
          pid: process.pid,
          ppid: process.ppid,
          argv: process.argv,
          begin,
          end: performance.now(),
          ...result,
        }),
      )
      report("profile-chunk")
    }
  }
  void sample().catch((error) => console.error("subprocess-startup-profile-error", error))
}

if (process.env.OPENCODE_TEST_STARTUP_PRELOAD !== "none") {
  report("solid-preload-start")
  const { ensureSolidTransformPlugin } = await import("@opentui/solid/bun-plugin")
  ensureSolidTransformPlugin()
  report("solid-preload-ready")
}
