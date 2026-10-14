// Run with Bun's --cpu-prof flags to retain the application-import cost separately from CLI help.
const started = performance.now()
const timer = setTimeout(() => {
  console.error(JSON.stringify({ phase: "routes", status: "timeout", elapsedMs: performance.now() - started }))
  process.exit(1)
}, 30_000)

try {
  await import("../src/routes")
  console.log(JSON.stringify({ phase: "routes", status: "loaded", elapsedMs: performance.now() - started }))
} finally {
  clearTimeout(timer)
}
