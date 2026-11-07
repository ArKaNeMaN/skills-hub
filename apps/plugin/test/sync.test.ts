import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { after, before, test } from "node:test"
import type { FastifyInstance } from "fastify"
import { ensureDataDirs, loadConfig, type ServerConfig } from "../../server/src/config.js"
import { openDatabase, type Db } from "../../server/src/db.js"
import { createToken, type Principal } from "../../server/src/auth.js"
import { createBucket } from "../../server/src/indexer.js"
import { deleteSkill, putSkillFile } from "../../server/src/write.js"
import { createApp } from "../../server/src/http.js"
import { Cache } from "../src/cache.js"
import { loadConfig as loadPluginConfig } from "../src/config.js"
import { sync } from "../src/sync.js"

let root: string
let serverRoot: string
let serverConfig: ServerConfig
let db: Db
let app: FastifyInstance
let apiUrl: string
let token: string
let cacheRoot: string

const admin: Principal = {
  kind: "admin",
  id: "test",
  scopes: ["admin"],
  bucketIds: new Set(),
  allBuckets: true,
}

function content(name: string, description: string): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\nBody\n`
}

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "skills-hub-plugin-"))
  serverRoot = path.join(root, "server")
  cacheRoot = path.join(root, "cache")
  serverConfig = loadConfig({ dataDir: serverRoot, adminToken: "test-admin", requireTls: false })
  ensureDataDirs(serverConfig)
  db = openDatabase(serverConfig)
  createBucket(serverConfig, db, { slug: "default", name: "Default" })
  createBucket(serverConfig, db, { slug: "team", name: "Team" })
  putSkillFile(serverConfig, db, admin, {
    bucket: "default",
    name: "code-review",
    path: "SKILL.md",
    content: content("code-review", "default version"),
  })
  putSkillFile(serverConfig, db, admin, {
    bucket: "team",
    name: "code-review",
    path: "SKILL.md",
    content: content("code-review", "team override"),
  })
  token = createToken(db, {
    label: "plugin",
    scopes: ["skills:read", "buckets:read"],
    buckets: ["default", "team"],
  }).token
  app = await createApp({ config: serverConfig, db })
  await app.listen({ host: "127.0.0.1", port: 0 })
  const address = app.server.address()
  if (!address || typeof address === "string") throw new Error("no address")
  apiUrl = `http://127.0.0.1:${address.port}`
})

after(async () => {
  await app.close()
  db.close()
  fs.rmSync(root, { recursive: true, force: true })
})

function pluginConfig(buckets: string[]) {
  return loadPluginConfig({
    directory: root,
    home: path.join(root, "home"),
    options: {
      apiUrl,
      token,
      buckets,
      cacheDir: cacheRoot,
      firstSyncTimeoutMs: 5000,
      timeoutMs: 5000,
      connectTimeoutMs: 5000,
    },
  })
}

test("sync writes cache and last bucket wins", async () => {
  const config = pluginConfig(["default", "team"])
  const cache = new Cache(cacheRoot)
  cache.ensure()
  const result = await sync(config, cache, () => {})
  assert.equal(result.status, "updated")
  const skill = fs.readFileSync(path.join(result.generation as string, "skills", "code-review", "SKILL.md"), "utf8")
  assert.match(skill, /team override/)
  const managed = cache.readManaged()
  assert.equal(managed.skills["code-review"]?.sourceBucket, "team")
  assert.deepEqual(managed.skills["code-review"]?.overridden, ["default"])
})

test("second sync uses ETag and does not create a generation", async () => {
  const config = pluginConfig(["default", "team"])
  const cache = new Cache(cacheRoot)
  const active = cache.activeGeneration()
  const result = await sync(config, cache, () => {})
  assert.equal(result.status, "not-modified")
  assert.equal(cache.activeGeneration(), active)
})

test("offline sync keeps the active generation", async () => {
  const config = pluginConfig(["default", "team"])
  const cache = new Cache(cacheRoot)
  const active = cache.activeGeneration()
  const offline = { ...config, apiUrl: "http://127.0.0.1:1", connectTimeoutMs: 100, timeoutMs: 100 }
  const result = await sync(offline, cache, () => {})
  assert.equal(result.status, "skipped")
  assert.equal(cache.activeGeneration(), active)
  assert.ok(cache.activeSkillsDir())
})

test("removing the override makes the earlier bucket visible", async () => {
  const config = pluginConfig(["default", "team"])
  const cache = new Cache(cacheRoot)
  deleteSkill(serverConfig, db, admin, { bucket: "team", name: "code-review" })
  const result = await sync(config, cache, () => {})
  assert.equal(result.status, "updated")
  const managed = cache.readManaged()
  assert.equal(managed.skills["code-review"]?.sourceBucket, "default")
  const skill = fs.readFileSync(
    path.join(result.generation as string, "skills", "code-review", "SKILL.md"),
    "utf8",
  )
  assert.match(skill, /default version/)
})

test("plugin injects remote MCP without overwriting a user entry", async () => {
  const { configHook } = await import("../src/index.js")
  const config: { mcp?: Record<string, unknown>; skills?: { paths?: string[] } } = {}
  await configHook(
    { directory: root },
    { apiUrl: "https://hub.example.com", mcpToken: "mcp-token", cacheDir: path.join(root, "mcp-cache") },
    config,
  )
  const entry = config.mcp?.["skills-hub"] as { type?: string; url?: string; headers?: Record<string, string> }
  assert.equal(entry?.type, "remote")
  assert.equal(entry?.url, "https://hub.example.com/mcp")
  assert.equal(entry?.headers?.Authorization, "Bearer mcp-token")
  const preserved = { mcp: { "skills-hub": { type: "remote", url: "https://custom" } } }
  await configHook(
    { directory: root },
    { apiUrl: "https://hub.example.com", mcpToken: "mcp-token", cacheDir: path.join(root, "mcp-cache-2") },
    preserved,
  )
  assert.equal((preserved.mcp["skills-hub"] as { url?: string }).url, "https://custom")
})
