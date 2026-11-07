import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { after, before, test } from "node:test"
import type { FastifyInstance } from "fastify"
import { ensureDataDirs, loadConfig, type ServerConfig } from "../src/config.js"
import { openDatabase, type Db } from "../src/db.js"
import { startAdminBootstrap, type BootstrapState } from "../src/auth.js"
import { createBucket } from "../src/indexer.js"
import { repoDir } from "../src/git.js"
import { createApp } from "../src/http.js"

let root: string
let config: ServerConfig
let db: Db
let bootstrap: BootstrapState
let app: FastifyInstance
let cookie: string
let csrf: string

function commitCount(bucket: string): number {
  const result = spawnSync("git", ["rev-list", "--count", "HEAD"], { cwd: repoDir(config, bucket), encoding: "utf8" })
  return Number.parseInt(result.stdout.trim(), 10)
}

function headers(): Record<string, string> {
  return { cookie, "x-csrf-token": csrf }
}

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "skills-hub-write-"))
  config = loadConfig({ dataDir: root, requireTls: false })
  ensureDataDirs(config)
  db = openDatabase(config)
  bootstrap = startAdminBootstrap(config)
  createBucket(config, db, { slug: "default", name: "Default" })
  app = await createApp({ config, db, bootstrap })
  const login = await app.inject({
    method: "POST",
    url: "/api/v1/admin/login",
    payload: { adminToken: bootstrap.token },
  })
  assert.equal(login.statusCode, 200)
  const setCookie = login.headers["set-cookie"]
  cookie = String(setCookie).split(";")[0] ?? ""
  csrf = (login.json() as { csrfToken: string }).csrfToken
})

after(async () => {
  await app.close()
  db.close()
  fs.rmSync(root, { recursive: true, force: true })
})

test("bootstrap token file is deleted and token stops working", async () => {
  assert.equal(fs.existsSync(config.adminBootstrapFile), false)
  const second = await app.inject({
    method: "POST",
    url: "/api/v1/admin/login",
    payload: { adminToken: "wrong" },
  })
  assert.equal(second.statusCode, 401)
})

test("mutations require a valid CSRF token", async () => {
  const response = await app.inject({
    method: "PUT",
    url: "/api/v1/admin/skills/default/no-csrf/files/SKILL.md",
    headers: { cookie },
    payload: { content: "---\nname: no-csrf\ndescription: x\n---\n" },
  })
  assert.equal(response.statusCode, 403)
  assert.equal((response.json() as { code: string }).code, "csrf_invalid")
})

test("each file write is one commit and creates the skill", async () => {
  const before = commitCount("default")
  const create = await app.inject({
    method: "PUT",
    url: "/api/v1/admin/skills/default/review/files/SKILL.md",
    headers: headers(),
    payload: { content: "---\nname: review\ndescription: Review\n---\n\nBody\n" },
  })
  assert.equal(create.statusCode, 200)
  assert.equal((create.json() as { createdSkill: boolean }).createdSkill, true)
  assert.equal(commitCount("default"), before + 1)
  const reference = await app.inject({
    method: "PUT",
    url: "/api/v1/admin/skills/default/review/files/references/checklist.md",
    headers: headers(),
    payload: { content: "checklist\n" },
  })
  assert.equal(reference.statusCode, 200)
  assert.equal(commitCount("default"), before + 2)
  const editor = await app.inject({
    method: "GET",
    url: "/api/v1/admin/skills/default/review",
    headers: { cookie },
  })
  assert.equal(editor.statusCode, 200)
  const body = editor.json() as { files: Array<{ path: string; content: string }> }
  assert.equal(body.files.find((file) => file.path === "references/checklist.md")?.content, "checklist\n")
})

test("delete file is one commit, deleting SKILL.md is rejected, delete skill works", async () => {
  const before = commitCount("default")
  const file = await app.inject({
    method: "DELETE",
    url: "/api/v1/admin/skills/default/review/files/references/checklist.md",
    headers: headers(),
  })
  assert.equal(file.statusCode, 200)
  assert.equal(commitCount("default"), before + 1)
  const entry = await app.inject({
    method: "DELETE",
    url: "/api/v1/admin/skills/default/review/files/SKILL.md",
    headers: headers(),
  })
  assert.equal(entry.statusCode, 400)
  assert.equal((entry.json() as { code: string }).code, "cannot_delete_entrypoint")
  const skill = await app.inject({
    method: "DELETE",
    url: "/api/v1/admin/skills/default/review",
    headers: headers(),
  })
  assert.equal(skill.statusCode, 200)
  assert.equal(commitCount("default"), before + 2)
})

test("same name in two buckets is allowed", async () => {
  createBucket(config, db, { slug: "team", name: "Team" })
  const first = await app.inject({
    method: "PUT",
    url: "/api/v1/admin/skills/default/shared/files/SKILL.md",
    headers: headers(),
    payload: { content: "---\nname: shared\ndescription: default\n---\n" },
  })
  assert.equal(first.statusCode, 200)
  const second = await app.inject({
    method: "PUT",
    url: "/api/v1/admin/skills/team/shared/files/SKILL.md",
    headers: headers(),
    payload: { content: "---\nname: shared\ndescription: team\n---\n" },
  })
  assert.equal(second.statusCode, 200)
})

test("static UI is served", async () => {
  const response = await app.inject({ method: "GET", url: "/" })
  assert.equal(response.statusCode, 200)
  assert.match(response.body, /skills-hub/)
})

test("unsafe remote URL is rejected", async () => {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/admin/buckets",
    headers: headers(),
    payload: { slug: "evil", name: "Evil", remoteUrl: "ext::sh -c id" },
  })
  assert.equal(response.statusCode, 400)
})

test("symlink component in target path is rejected", async () => {
  const response = await app.inject({
    method: "PUT",
    url: "/api/v1/admin/skills/default/symlink/files/SKILL.md",
    headers: headers(),
    payload: { content: "---\nname: symlink\ndescription: symlink\n---\n" },
  })
  assert.equal(response.statusCode, 200)
  const skillDir = path.join(repoDir(config, "default"), "skills", "symlink")
  fs.symlinkSync(os.tmpdir(), path.join(skillDir, "evil"))
  spawnSync("git", ["add", "--", "skills/symlink/evil"], { cwd: repoDir(config, "default") })
  spawnSync("git", ["commit", "--no-verify", "-m", "test: add symlink"], { cwd: repoDir(config, "default") })
  const blocked = await app.inject({
    method: "PUT",
    url: "/api/v1/admin/skills/default/symlink/files/evil/file.md",
    headers: headers(),
    payload: { content: "escape\n" },
  })
  assert.equal(blocked.statusCode, 400)
  assert.equal((blocked.json() as { code: string }).code, "invalid_path")
})
