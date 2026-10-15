import path from "node:path"

export function startupArgs(env: Record<string, string | undefined> = process.env) {
  if (env.OPENCODE_TEST_STARTUP_TRACE !== "1") return []
  // Start tracing before loading the configured Solid plugin, including its own module graph.
  return [
    `--config=${path.join(import.meta.dir, "../../../../bunfig.toml")}`,
    "--preload",
    path.join(import.meta.dir, "startup-trace.ts"),
  ]
}
