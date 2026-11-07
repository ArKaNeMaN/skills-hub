import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { after, before, test } from "node:test"
import type { FastifyInstance } from "fastify"
import { ensureDataDirs, loadConfig, type ServerConfig } from "../src/config.js"
import { openDatabase, type Db } from "../src/db.js"
import { createToken } from "../src/auth.js"
import { createBucket } from "../src/indexer.js"
import { createApp } from "../src/http.js"

let root: string
let config: ServerConfig
let db: Db
let app: FastifyInstance
let cookie: string
let csrf: string

function adminHeaders(): Record<string, string> {
  return { cookie, "x-csrf-token": csrf }
}

function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` }
}

async function initialize(token: string): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/mcp",
    headers: { ...bearer(token), accept: "application/json, text/event-stream", "content-type": "application/json" },
    payload: {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" } },
    },
  })
  assert.equal(response.statusCode, 200)
  const session = response.headers["mcp-session-id"]
  assert.equal(typeof session, "string")
  return String(session)
}

async function createApiToken(body: Record<string, unknown>): Promise<{ id: string; token: string }> {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/admin/tokens",
    headers: adminHeaders(),
    payload: body,
  })
  assert.equal(response.statusCode, 201)
  return response.json() as { id: string; token: string }
}

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "skills-hub-tokens-"))
  config = loadConfig({ dataDir: root, adminToken: "tokens-admin", requireTls: false })
  ensureDataDirs(config)
  db = openDatabase(config)
  createBucket(config, db, { slug: "default", name: "Default" })
  createBucket(config, db, { slug: "team", name: "Team" })
  app = await createApp({ config, db })
  await app.ready()
  const login = await app.inject({
    method: "POST",
    url: "/api/v1/admin/login",
    payload: { adminToken: "tokens-admin" },
  })
  assert.equal(login.statusCode, 200)
  cookie = String(login.headers["set-cookie"]).split(";")[0] ?? ""
  csrf = (login.json() as { csrfToken: string }).csrfToken
})

after(async () => {
  await app.close()
  db.close()
  fs.rmSync(root, { recursive: true, force: true })
})

test("PATCH edits scopes and buckets, and the same secret immediately reflects them", async () => {
  const created = await createApiToken({
    label: "editable",
    scopes: ["skills:read", "buckets:read"],
    buckets: ["default"],
  })

  const listBefore = await app.inject({
    method: "GET",
    url: "/api/v1/admin/tokens",
    headers: adminHeaders(),
  })
  assert.equal(listBefore.statusCode, 200)
  const before = (listBefore.json() as { tokens: Array<{ id: string; buckets: string[] }> }).tokens.find(
    (token) => token.id === created.id,
  )
  assert.deepEqual(before?.buckets, ["default"])

  const patch = await app.inject({
    method: "PATCH",
    url: `/api/v1/admin/tokens/${created.id}`,
    headers: adminHeaders(),
    payload: {
      scopes: ["skills:read", "skills:write", "buckets:read"],
      buckets: ["default", "team"],
    },
  })
  assert.equal(patch.statusCode, 200)
  const patched = patch.json() as { id: string; scopes: string[]; allBuckets: boolean; buckets: string[] }
  assert.deepEqual(patched.scopes, ["skills:read", "skills:write", "buckets:read"])
  assert.equal(patched.allBuckets, false)
  assert.deepEqual(patched.buckets, ["default", "team"])

  const listAfter = await app.inject({
    method: "GET",
    url: "/api/v1/admin/tokens",
    headers: adminHeaders(),
  })
  const after = (listAfter.json() as { tokens: Array<{ id: string; scopes: string[]; buckets: string[] }> }).tokens.find(
    (token) => token.id === created.id,
  )
  assert.deepEqual(after?.scopes, ["skills:read", "skills:write", "buckets:read"])
  assert.deepEqual(after?.buckets, ["default", "team"])

  const write = await app.inject({
    method: "PUT",
    url: "/api/v1/admin/skills/team/edit-via-token/files/SKILL.md",
    headers: bearer(created.token),
    payload: { content: "---\nname: edit-via-token\ndescription: Edited token\n---\n\nBody\n" },
  })
  assert.equal(write.statusCode, 200)

  const downgrade = await app.inject({
    method: "PATCH",
    url: `/api/v1/admin/tokens/${created.id}`,
    headers: adminHeaders(),
    payload: { scopes: ["skills:read", "buckets:read"] },
  })
  assert.equal(downgrade.statusCode, 200)

  const blocked = await app.inject({
    method: "PUT",
    url: "/api/v1/admin/skills/team/edit-via-token/files/SKILL.md",
    headers: bearer(created.token),
    payload: { content: "---\nname: edit-via-token\ndescription: Edited token\n---\n\nBody\n" },
  })
  assert.equal(blocked.statusCode, 403)
  assert.equal((blocked.json() as { code: string }).code, "insufficient_scope")
})

test("PATCH drops active MCP sessions of the token", async () => {
  const created = await createApiToken({
    label: "mcp-invalidate",
    scopes: ["skills:read", "skills:write", "buckets:read"],
    buckets: ["default"],
  })
  const session = await initialize(created.token)

  const patch = await app.inject({
    method: "PATCH",
    url: `/api/v1/admin/tokens/${created.id}`,
    headers: adminHeaders(),
    payload: { scopes: ["skills:read", "buckets:read"] },
  })
  assert.equal(patch.statusCode, 200)

  const stale = await app.inject({
    method: "POST",
    url: "/mcp",
    headers: {
      ...bearer(created.token),
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "mcp-session-id": session,
    },
    payload: { jsonrpc: "2.0", id: 2, method: "tools/list" },
  })
  assert.equal(stale.statusCode, 404)
  assert.match(stale.body, /session not found/)
})

test("PATCH via cookie session requires CSRF", async () => {
  const created = await createApiToken({
    label: "csrf-check",
    scopes: ["skills:read", "buckets:read"],
    buckets: ["default"],
  })
  const response = await app.inject({
    method: "PATCH",
    url: `/api/v1/admin/tokens/${created.id}`,
    headers: { cookie },
    payload: { scopes: ["skills:read"] },
  })
  assert.equal(response.statusCode, 403)
  assert.equal((response.json() as { code: string }).code, "csrf_invalid")
})

test("PATCH validates scopes, buckets, token existence and revocation", async () => {
  const created = await createApiToken({
    label: "validation",
    scopes: ["skills:read", "buckets:read"],
    buckets: ["default"],
  })

  const invalidScope = await app.inject({
    method: "PATCH",
    url: `/api/v1/admin/tokens/${created.id}`,
    headers: adminHeaders(),
    payload: { scopes: ["skills:read", "not:a:scope"] },
  })
  assert.equal(invalidScope.statusCode, 400)
  assert.equal((invalidScope.json() as { code: string }).code, "invalid_request")

  const unknownBucket = await app.inject({
    method: "PATCH",
    url: `/api/v1/admin/tokens/${created.id}`,
    headers: adminHeaders(),
    payload: { buckets: ["ghost"] },
  })
  assert.equal(unknownBucket.statusCode, 400)
  assert.equal((unknownBucket.json() as { code: string }).code, "invalid_request")

  const emptyBuckets = await app.inject({
    method: "PATCH",
    url: `/api/v1/admin/tokens/${created.id}`,
    headers: adminHeaders(),
    payload: { buckets: [] },
  })
  assert.equal(emptyBuckets.statusCode, 400)
  assert.equal((emptyBuckets.json() as { code: string }).code, "invalid_request")

  const unknownToken = await app.inject({
    method: "PATCH",
    url: "/api/v1/admin/tokens/doesnotexist",
    headers: adminHeaders(),
    payload: { scopes: ["skills:read"] },
  })
  assert.equal(unknownToken.statusCode, 404)

  const revoke = await app.inject({
    method: "DELETE",
    url: `/api/v1/admin/tokens/${created.id}`,
    headers: adminHeaders(),
  })
  assert.equal(revoke.statusCode, 200)

  const revoked = await app.inject({
    method: "PATCH",
    url: `/api/v1/admin/tokens/${created.id}`,
    headers: adminHeaders(),
    payload: { scopes: ["skills:read"] },
  })
  assert.equal(revoked.statusCode, 409)
  assert.equal((revoked.json() as { code: string }).code, "conflict")
})

test("PATCH enforces the permission ceiling of the calling token", async () => {
  const parent = createToken(db, {
    label: "parent",
    scopes: ["skills:read", "buckets:read", "tokens:admin"],
    buckets: ["default"],
  })
  const child = createToken(db, {
    label: "child",
    scopes: ["skills:read", "buckets:read"],
    buckets: ["default"],
  })

  const escalateScope = await app.inject({
    method: "PATCH",
    url: `/api/v1/admin/tokens/${child.id}`,
    headers: bearer(parent.token),
    payload: { scopes: ["skills:read", "skills:write", "buckets:read"] },
  })
  assert.equal(escalateScope.statusCode, 403)
  assert.equal((escalateScope.json() as { code: string }).code, "insufficient_scope")

  const escalateBucket = await app.inject({
    method: "PATCH",
    url: `/api/v1/admin/tokens/${child.id}`,
    headers: bearer(parent.token),
    payload: { buckets: ["team"] },
  })
  assert.equal(escalateBucket.statusCode, 403)
  assert.equal((escalateBucket.json() as { code: string }).code, "bucket_forbidden")

  const allowed = await app.inject({
    method: "PATCH",
    url: `/api/v1/admin/tokens/${child.id}`,
    headers: bearer(parent.token),
    payload: { scopes: ["buckets:read"], buckets: ["default"] },
  })
  assert.equal(allowed.statusCode, 200)
  const body = allowed.json() as { scopes: string[]; buckets: string[] }
  assert.deepEqual(body.scopes, ["buckets:read"])
  assert.deepEqual(body.buckets, ["default"])
})
