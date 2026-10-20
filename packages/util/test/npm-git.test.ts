import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import { createRequire } from "node:module"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"

const git = createRequire(import.meta.resolve("pacote"))("@npmcli/git") as {
  clone(repository: string, ref: string, target: string, options: { env: NodeJS.ProcessEnv }): Promise<string>
}

test.each(["HEAD", "fixture-branch"])(
  "clones %s without starting submodule processes for a repository without submodules",
  async (ref) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-npm-git-"))
    const repository = path.join(root, "repository")
    const trace = path.join(root, "git-trace.jsonl")
    const env = { ...process.env, GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: "1" }
    try {
      await Bun.$`git init -q -b main ${repository}`.env(env)
      await Bun.write(path.join(repository, "package.json"), '{"name":"fixture-git-plugin","version":"1.0.0"}\n')
      await Bun.$`git -C ${repository} add .`.env(env)
      await Bun.$`git -C ${repository} -c user.name=fixture -c user.email=fixture@example.com commit -qm fixture`.env(
        env,
      )
      await Bun.$`git -C ${repository} branch fixture-branch`.env(env)
      await Bun.write(path.join(repository, "main-only"), "main\n")
      await Bun.$`git -C ${repository} add .`.env(env)
      await Bun.$`git -C ${repository} -c user.name=fixture -c user.email=fixture@example.com commit -qm main`.env(env)

      const expected = (await Bun.$`git -C ${repository} rev-parse ${ref}`.env(env).text()).trim()
      const target = path.join(root, "clone")
      expect(
        await git.clone(pathToFileURL(repository).href, ref, target, { env: { ...env, GIT_TRACE2_EVENT: trace } }),
      ).toBe(expected)
      expect(await Bun.file(path.join(target, "package.json")).json()).toEqual({
        name: "fixture-git-plugin",
        version: "1.0.0",
      })
      expect((await Bun.$`git -C ${target} config --get submodule.active`.env(env).text()).trim()).toBe(".")
      const events = (await Bun.file(trace).text())
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { event: string; argv?: string[] })
      expect(events.some((event) => event.event === "start")).toBe(true)
      expect(
        events.filter((event) => event.argv?.some((arg) => arg === "submodule" || arg === "submodule--helper")),
      ).toEqual([])
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  },
)

test.each([
  { ref: "HEAD", active: "." },
  { ref: "fixture-branch", active: "." },
  { ref: "HEAD", active: "unrelated" },
  { ref: "fixture-branch", active: "unrelated" },
])(
  "preserves recursive selection when cloning $ref with submodule.active=$active",
  async (input) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-npm-submodules-"))
    const env = { ...process.env, GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: "1", GIT_ALLOW_PROTOCOL: "file" }
    try {
      for (const name of ["leaf", "middle", "repository"]) {
        const directory = path.join(root, name)
        await Bun.$`git init -q -b main ${directory}`.env(env)
        await Bun.write(path.join(directory, "content"), `${name}\n`)
        if (name !== "leaf") {
          const child = path.join(root, name === "middle" ? "leaf" : "middle")
          await Bun.$`git -C ${directory} submodule add -q ${pathToFileURL(child).href} child`.env(env)
        }
        await Bun.$`git -C ${directory} add .`.env(env)
        await Bun.$`git -C ${directory} -c user.name=fixture -c user.email=fixture@example.com commit -qm fixture`.env(
          env,
        )
      }
      const repository = path.join(root, "repository")
      await Bun.$`git -C ${repository} branch fixture-branch`.env(env)
      await Bun.write(path.join(repository, "main-only"), "main\n")
      await Bun.$`git -C ${repository} add .`.env(env)
      await Bun.$`git -C ${repository} -c user.name=fixture -c user.email=fixture@example.com commit -qm main`.env(env)
      const expected = (await Bun.$`git -C ${repository} rev-parse ${input.ref}`.env(env).text()).trim()
      const target = path.join(root, "clone")
      const config = path.join(root, "gitconfig")
      await Bun.write(config, `[submodule]\nactive = ${input.active}\n`)
      expect(
        await git.clone(pathToFileURL(repository).href, input.ref, target, {
          env: { ...env, GIT_CONFIG_GLOBAL: config },
        }),
      ).toBe(expected)
      expect(await Bun.file(path.join(target, "child", "content")).text()).toBe("middle\n")
      // Recursive clone selects every root submodule, while nested modules retain the inherited selection.
      const nested = Bun.file(path.join(target, "child", "child", "content"))
      expect(await nested.exists()).toBe(input.active === ".")
      if (input.active === ".") expect(await nested.text()).toBe("leaf\n")
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  },
  30_000,
)
