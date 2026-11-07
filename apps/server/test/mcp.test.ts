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
let writeToken: string
let readToken: string

function parse(response: { body: string; headers: Record<string, unknown> }): any {
  const contentType = String(response.headers["content-type"] ?? "")
  if (contentType.includes("text/event-stream")) {
    const line = response.body
      .split("\n")
      .find((item) => item.startsWith("data: "))
    if (!line) throw new Error(`no SSE data: ${response.body}`)
    return JSON.parse(line.slice("data: ".length))
  }
  return JSON.parse(response.body)
}

async function initialize(token: string) {
  const response = await app.inject({
    method: "POST",
    url: "/mcp",
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
    },
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
  return { session: String(session), body: parse(response) }
}

async function call(token: string, session: string, body: unknown) {
  const response = await app.inject({
    method: "POST",
    url: "/mcp",
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "mcp-session-id": session,
    },
    payload: body as Record<string, unknown>,
  })
  assert.equal(response.statusCode, 200)
  return parse({ body: response.body, headers: response.headers as Record<string, unknown> })
}

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "skills-hub-mcp-"))
  config = loadConfig({ dataDir: root, adminToken: "mcp-admin", requireTls: false })
  ensureDataDirs(config)
  db = openDatabase(config)
  createBucket(config, db, { slug: "default", name: "Default" })
  writeToken = createToken(db, {
    label: "mcp-write",
    scopes: ["skills:read", "skills:write", "buckets:read"],
    buckets: ["default"],
  }).token
  readToken = createToken(db, {
    label: "mcp-read",
    scopes: ["skills:read", "buckets:read"],
    buckets: ["default"],
  }).token
  app = await createApp({ config, db, bootstrap: { token: "mcp-admin", source: "env" } })
})

after(async () => {
  await app.close()
  db.close()
  fs.rmSync(root, { recursive: true, force: true })
})

test("write token can create a skill file over MCP", async () => {
  const { session } = await initialize(writeToken)
  const tools = await call(writeToken, session, { jsonrpc: "2.0", id: 2, method: "tools/list" })
  const names = tools.result.tools.map((tool: { name: string }) => tool.name)
  assert.ok(names.includes("put_skill_file"))
  assert.ok(!names.includes("delete_skill"))
  const result = await call(writeToken, session, {
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: {
      name: "put_skill_file",
      arguments: {
        bucket: "default",
        name: "mcp-skill",
        path: "SKILL.md",
        content: "---\nname: mcp-skill\ndescription: MCP skill\n---\n\nBody\n",
      },
    },
  })
  assert.ok(result.result?.content)
  const row = db.prepare("SELECT COUNT(*) AS count FROM skills WHERE name = 'mcp-skill'").get() as { count: number }
  assert.equal(row.count, 1)
})

test("read-only token cannot see or call write tools", async () => {
  const { session } = await initialize(readToken)
  const tools = await call(readToken, session, { jsonrpc: "2.0", id: 2, method: "tools/list" })
  const names = tools.result.tools.map((tool: { name: string }) => tool.name)
  assert.ok(names.includes("get_skill"))
  assert.ok(!names.includes("put_skill_file"))
  const result = await call(readToken, session, {
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "put_skill_file", arguments: { bucket: "default", name: "x", path: "SKILL.md", content: "" } },
  })
  assert.ok(result.error || result.result?.isError)
})

test("mcp rejects missing auth", async () => {
  const response = await app.inject({
    method: "POST",
    url: "/mcp",
    headers: { accept: "application/json, text/event-stream" },
    payload: { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
  })
  assert.equal(response.statusCode, 401)
})
