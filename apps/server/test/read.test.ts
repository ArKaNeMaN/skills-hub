import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { after, before, test } from "node:test"
import type { FastifyInstance } from "fastify"
import { loadConfig, ensureDataDirs, type ServerConfig } from "../src/config.js"
import { openDatabase, type Db } from "../src/db.js"
import { createToken, type Principal } from "../src/auth.js"
import { createBucket, reindexAll } from "../src/indexer.js"
import { putSkillFile } from "../src/write.js"
import { createApp } from "../src/http.js"

let root: string
let config: ServerConfig
let db: Db
let app: FastifyInstance
let readToken: string

const admin: Principal = {
  kind: "admin",
  id: "test",
  scopes: ["admin"],
  bucketIds: new Set(),
  allBuckets: true,
}

function skill(name: string): string {
  return `---\nname: ${name}\ndescription: Test skill ${name}\n---\n\nBody\n`
}

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "skills-hub-"))
  config = loadConfig({ dataDir: root, adminToken: "test-admin", requireTls: false })
  ensureDataDirs(config)
  db = openDatabase(config)
  createBucket(config, db, { slug: "default", name: "Default" })
  createBucket(config, db, { slug: "team", name: "Team" })
  putSkillFile(config, db, admin, {
    bucket: "default",
    name: "code-review",
    path: "SKILL.md",
    content: skill("code-review"),
  })
  putSkillFile(config, db, admin, {
    bucket: "default",
    name: "code-review",
    path: "references/checklist.md",
    content: "checklist\n",
  })
  putSkillFile(config, db, admin, {
    bucket: "team",
    name: "code-review",
    path: "SKILL.md",
    content: skill("code-review"),
  })
  const token = createToken(db, {
    label: "test-read",
    scopes: ["skills:read", "buckets:read"],
    buckets: ["default"],
  })
  readToken = token.token
  app = await createApp({ config, db })
  await app.ready()
})

after(async () => {
  await app.close()
  db.close()
  fs.rmSync(root, { recursive: true, force: true })
})

test("health and readiness", async () => {
  const health = await app.inject({ method: "GET", url: "/health" })
  assert.equal(health.statusCode, 200)
  const ready = await app.inject({ method: "GET", url: "/ready" })
  assert.equal(ready.statusCode, 200)
})

test("read token sees only bound bucket", async () => {
  const response = await app.inject({
    method: "GET",
    url: "/api/v1/buckets",
    headers: { authorization: `Bearer ${readToken}` },
  })
  assert.equal(response.statusCode, 200)
  const body = response.json() as { buckets: Array<{ slug: string }> }
  assert.deepEqual(body.buckets.map((bucket) => bucket.slug), ["default"])
})

test("manifest is scoped, canonical and supports 304", async () => {
  const first = await app.inject({
    method: "GET",
    url: "/api/v1/manifest?buckets=default",
    headers: { authorization: `Bearer ${readToken}` },
  })
  assert.equal(first.statusCode, 200)
  const etag = first.headers.etag
  assert.equal(typeof etag, "string")
  assert.equal(first.headers.vary, "Authorization")
  const body = first.json() as { buckets: Array<{ slug: string; skills: Array<{ name: string }> }> }
  assert.equal(body.buckets[0]?.slug, "default")
  assert.equal(body.buckets[0]?.skills[0]?.name, "code-review")
  const second = await app.inject({
    method: "GET",
    url: "/api/v1/manifest?buckets=default",
    headers: { authorization: `Bearer ${readToken}`, "if-none-match": String(etag) },
  })
  assert.equal(second.statusCode, 304)
})

test("forbidden bucket is rejected, not silently filtered", async () => {
  const response = await app.inject({
    method: "GET",
    url: "/api/v1/manifest?buckets=default,team",
    headers: { authorization: `Bearer ${readToken}` },
  })
  assert.equal(response.statusCode, 403)
  assert.equal((response.json() as { code: string }).code, "bucket_forbidden")
})

test("file download verifies content and supports 304", async () => {
  const first = await app.inject({
    method: "GET",
    url: "/api/v1/skills/default/code-review/files/references/checklist.md",
    headers: { authorization: `Bearer ${readToken}` },
  })
  assert.equal(first.statusCode, 200)
  assert.equal(first.body, "checklist\n")
  const etag = first.headers.etag
  const second = await app.inject({
    method: "GET",
    url: "/api/v1/skills/default/code-review/files/references/checklist.md",
    headers: { authorization: `Bearer ${readToken}`, "if-none-match": String(etag) },
  })
  assert.equal(second.statusCode, 304)
})

test("missing or invalid token is 401", async () => {
  const missing = await app.inject({ method: "GET", url: "/api/v1/manifest" })
  assert.equal(missing.statusCode, 401)
  const invalid = await app.inject({
    method: "GET",
    url: "/api/v1/manifest",
    headers: { authorization: "Bearer shk_00000000_nope" },
  })
  assert.equal(invalid.statusCode, 401)
})

test("same skill name in different buckets is allowed; per-bucket unique", async () => {
  const response = await app.inject({
    method: "GET",
    url: "/api/v1/manifest",
    headers: { authorization: `Bearer ${readToken}` },
  })
  assert.equal(response.statusCode, 200)
  const duplicate = putSkillFile(config, db, admin, {
    bucket: "team",
    name: "code-review",
    path: "SKILL.md",
    content: skill("code-review"),
  })
  assert.equal(duplicate.created, false)
  assert.throws(
    () =>
      putSkillFile(config, db, admin, {
        bucket: "default",
        name: "code-review",
        path: "SKILL.md",
        content: skill("other-name"),
      }),
    /frontmatter.name/,
  )
})

test("reindex rebuilds database from git HEAD", async () => {
  db.exec("DELETE FROM files; DELETE FROM skills;")
  const results = reindexAll(config, db)
  assert.equal(results.length, 2)
  const row = db.prepare("SELECT COUNT(*) AS count FROM skills").get() as { count: number }
  assert.equal(row.count, 2)
})
