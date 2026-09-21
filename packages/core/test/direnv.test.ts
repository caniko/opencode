import { test } from "node:test"
import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { environment } from "../src/direnv.ts"

test("direnv isolates workdirs, preserves unsets, checks approval and rejects broken environments", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-direnv-"))
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DIRENV_CONFIG: path.join(root, "config"),
    XDG_DATA_HOME: path.join(root, "data"),
    XDG_CACHE_HOME: path.join(root, "cache"),
    OPENCODE_DIRENV_REMOVE: "inherited",
  }
  delete env.DIRENV_DIFF
  delete env.DIRENV_DIR
  delete env.DIRENV_WATCHES
  try {
    for (const name of ["first", "second", "plain"]) await mkdir(path.join(root, name))
    const first = path.join(root, "first")
    const second = path.join(root, "second")
    await writeFile(path.join(first, ".envrc"), "export OPENCODE_DIRENV_TEST=first\nunset OPENCODE_DIRENV_REMOVE\n")
    await writeFile(path.join(second, ".envrc"), "export OPENCODE_DIRENV_TEST=second\n")
    await assert.rejects(environment(first, env), /not approved/)
    // Approvals are confined to these test-owned fixtures, never a real project.
    await promisify(execFile)("direnv", ["allow", first], { env })
    await promisify(execFile)("direnv", ["allow", second], { env })
    const [a, b] = await Promise.all([environment(first, env), environment(second, env)])
    assert.equal(a.OPENCODE_DIRENV_TEST, "first")
    assert.equal(b.OPENCODE_DIRENV_TEST, "second")
    assert.equal(a.OPENCODE_DIRENV_REMOVE, undefined)
    assert.equal(b.OPENCODE_DIRENV_REMOVE, "inherited")
    assert.equal(env.OPENCODE_DIRENV_REMOVE, "inherited")
    assert.equal((await environment(path.join(root, "plain"), env)).OPENCODE_DIRENV_TEST, undefined)
    await writeFile(path.join(first, ".envrc"), "strict_env\nreturn 1\n")
    await promisify(execFile)("direnv", ["allow", first], { env })
    await assert.rejects(environment(first, env), /Cannot load direnv/)
    await writeFile(path.join(first, ".envrc"), "export NIX_DIRENV_DID_FALLBACK=1\n")
    await promisify(execFile)("direnv", ["allow", first], { env })
    await assert.rejects(environment(first, env), /stale fallback/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
