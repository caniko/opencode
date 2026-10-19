import { mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"

// Shell tests must never acquire or reclaim the live backend's governor leases.
const governor = mkdtempSync(path.join(os.tmpdir(), "opencode-test-governor-"))
process.env.OPENCODE_TOOL_GOVERNOR_DIRECTORY = governor
process.once("exit", () => rmSync(governor, { recursive: true, force: true }))

process.env.OPENCODE_DB = ":memory:"
process.env.NPM_CONFIG_AUDIT = "false"
