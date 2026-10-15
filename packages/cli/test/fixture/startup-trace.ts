// Test-only preload: keep lifecycle evidence on stderr without retaining the process.
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

if (process.env.OPENCODE_TEST_STARTUP_PRELOAD !== "none") {
  report("solid-preload-start")
  const { ensureSolidTransformPlugin } = await import("@opentui/solid/bun-plugin")
  ensureSolidTransformPlugin()
  report("solid-preload-ready")
}
