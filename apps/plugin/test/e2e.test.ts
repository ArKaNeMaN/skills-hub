import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { ensureDataDirs, loadConfig } from "../../server/src/config.js"
import { openDatabase } from "../../server/src/db.js"
import { createToken, type Principal } from "../../server/src/auth.js"
import { createBucket } from "../../server/src/indexer.js"
import { putSkillFile } from "../../server/src/write.js"
import { createApp } from "../../server/src/http.js"

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, "../../..")
const pluginEntry = path.join(repo, "apps/plugin/src/index.ts")
const opencode = process.env.OPENCODE_BIN ?? "opencode"

const admin: Principal = {
  kind: "admin",
  id: "e2e",
  scopes: ["admin"],
  bucketIds: new Set(),
  allBuckets: true,
}

function runProcess(
  command: string,
  args: string[],
  options: { cwd?: string; env: NodeJS.ProcessEnv },
): Promise<{ status: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env })
    let stdout = ""
    let stderr = ""
    const timer = setTimeout(() => child.kill("SIGTERM"), 60_000)
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")))
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")))
    child.on("error", (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on("close", (status, signal) => {
      clearTimeout(timer)
      resolve({ status, signal, stdout, stderr })
    })
  })
}

test("opencode debug skill sees a synced skill and survives offline", async (t) => {
  const check = await runProcess(opencode, ["--version"], { env: process.env })
  if (check.status !== 0) {
    t.skip("opencode binary is not available")
    return
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "skills-hub-e2e-"))
  const home = path.join(root, "home")
  const project = path.join(root, "project")
  const data = path.join(root, "data")
  fs.mkdirSync(path.join(home, ".config", "opencode"), { recursive: true })
  fs.mkdirSync(path.join(project, ".opencode", "plugins"), { recursive: true })
  const config = loadConfig({ dataDir: data, adminToken: "e2e-admin", requireTls: false })
  ensureDataDirs(config)
  const db = openDatabase(config)
  let app
  try {
    createBucket(config, db, { slug: "default", name: "Default" })
    putSkillFile(config, db, admin, {
      bucket: "default",
      name: "e2e-skill",
      path: "SKILL.md",
      content: "---\nname: e2e-skill\ndescription: E2E skill\n---\n\nBody\n",
    })
    const token = createToken(db, {
      label: "e2e",
      scopes: ["skills:read", "buckets:read"],
      buckets: ["default"],
    }).token
    app = await createApp({ config, db })
    await app.listen({ host: "127.0.0.1", port: 0 })
    const address = app.server.address()
    if (!address || typeof address === "string") throw new Error("no address")
    const apiUrl = `http://127.0.0.1:${address.port}`
    const cacheDir = path.join(home, ".cache", "skills-hub")
    fs.writeFileSync(
      path.join(home, ".config", "opencode", "skills-hub.json"),
      JSON.stringify({ apiUrl, token, buckets: ["default"], cacheDir, firstSyncTimeoutMs: 10_000, connectTimeoutMs: 5_000, timeoutMs: 5_000 }, null, 2),
    )
    fs.writeFileSync(
      path.join(project, ".opencode", "plugins", "skills-hub.ts"),
      `export { default } from ${JSON.stringify(pluginEntry)}\n`,
    )
    const env = {
      PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
      HOME: home,
      PWD: project,
      XDG_CONFIG_HOME: path.join(home, ".config"),
      XDG_CACHE_HOME: path.join(home, ".cache"),
      XDG_DATA_HOME: path.join(home, ".local", "share"),
      XDG_STATE_HOME: path.join(home, ".local", "state"),
      OPENCODE_DISABLE_AUTOUPDATE: "1",
      SKILLS_HUB_DEBUG: "1",
    }
    const run = () => runProcess(opencode, ["debug", "skill"], { cwd: project, env })
    const first = await run()
    if (first.status !== 0) {
      throw new Error(`opencode debug skill failed: status=${first.status} signal=${first.signal}\nstderr=${first.stderr}\nstdout=${first.stdout}`)
    }
    const firstJson = JSON.parse(first.stdout.slice(first.stdout.indexOf("["))) as Array<{ name: string }>
    assert.ok(firstJson.some((skill) => skill.name === "e2e-skill"), `stdout=${first.stdout}\nstderr=${first.stderr}`)
    await app.close()
    app = undefined
    const offline = await run()
    if (offline.status !== 0) {
      throw new Error(`offline opencode debug skill failed: ${offline.stderr || offline.stdout}\nstdout: ${offline.stdout}`)
    }
    const offlineJson = JSON.parse(offline.stdout.slice(offline.stdout.indexOf("["))) as Array<{ name: string }>
    assert.ok(offlineJson.some((skill) => skill.name === "e2e-skill"), `stdout=${offline.stdout}\nstderr=${offline.stderr}`)
  } finally {
    if (app) await app.close()
    db.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})
