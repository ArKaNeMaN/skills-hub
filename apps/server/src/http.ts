import { randomUUID } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify"
import fastifyStatic from "@fastify/static"
import {
  LIMITS,
  problem,
  validateRelPath,
  type Scope,
} from "@skills-hub/protocol"
import type { ServerConfig } from "./config.js"
import { nowIso, type Db } from "./db.js"
import {
  adminTokenMatches,
  AuthError,
  consumeBootstrap,
  createSession,
  createToken,
  parseCookies,
  parseScopes,
  requireBucket,
  requireScope,
  revokeSession,
  verifyBearer,
  verifySession,
  type BootstrapState,
  type Principal,
  type TokenRow,
} from "./auth.js"
import { HttpError } from "./errors.js"
import { assertInside, repoDir } from "./git.js"
import { createBucket, reindexAll, reindexBucket } from "./indexer.js"
import {
  audit,
  buildManifest,
  getFileContent,
  getSkill,
  IndexStaleError,
  listBuckets,
  allowedBuckets,
  findBucket,
} from "./services.js"
import { deleteSkill, deleteSkillFile, putSkillFile } from "./write.js"
import { handleMcp } from "./mcp.js"

export interface AppContext {
  config: ServerConfig
  db: Db
  bootstrap: BootstrapState
}

function requestId(request: FastifyRequest): string {
  const header = request.headers["x-request-id"]
  return typeof header === "string" && header.length > 0 ? header : randomUUID()
}

function parseBootstrapBody(body: unknown): string {
  if (!body || typeof body !== "object") throw new HttpError(400, "invalid_request")
  const adminToken = (body as { adminToken?: unknown }).adminToken
  if (typeof adminToken !== "string" || adminToken.length === 0) throw new HttpError(400, "invalid_request")
  return adminToken
}

function parseWriteBody(body: unknown): { content: string; message?: string } {
  if (!body || typeof body !== "object") throw new HttpError(400, "invalid_request")
  const record = body as { content?: unknown; message?: unknown }
  if (typeof record.content !== "string") throw new HttpError(400, "invalid_request")
  if (record.message !== undefined && typeof record.message !== "string") throw new HttpError(400, "invalid_request")
  return { content: record.content, ...(record.message ? { message: record.message.slice(0, 200) } : {}) }
}

function cookieFlags(config: ServerConfig): string {
  const secure = config.publicUrl?.startsWith("https://") || (config.trustProxy && config.requireTls)
  return `Path=/; HttpOnly; SameSite=Strict${secure ? "; Secure" : ""}`
}

function setSessionCookie(reply: FastifyReply, config: ServerConfig, cookie: string): void {
  reply.header("Set-Cookie", `sh_sess=${encodeURIComponent(cookie)}; ${cookieFlags(config)}`)
}

function clearSessionCookie(reply: FastifyReply): void {
  reply.header("Set-Cookie", "sh_sess=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0")
}

function principalFromRequest(context: AppContext, request: FastifyRequest): Principal {
  const header = request.headers.authorization
  if (header) return verifyBearer(context.db, header)
  const cookies = parseCookies(request.headers.cookie)
  return verifySession(context.db, cookies.sh_sess)
}

function requireCsrf(context: AppContext, request: FastifyRequest, principal: Principal): void {
  if (principal.kind !== "admin") return
  const method = request.method.toUpperCase()
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return
  const token = request.headers["x-csrf-token"]
  if (typeof token !== "string" || !principal.csrf || token !== principal.csrf) {
    throw new HttpError(403, "csrf_invalid")
  }
  const origin = request.headers.origin
  if (origin && context.config.publicUrl) {
    const allowed = new URL(context.config.publicUrl).origin
    if (origin !== allowed) throw new HttpError(403, "origin_invalid")
  }
}

function scopesFor(body: unknown): Scope[] {
  if (!body || typeof body !== "object") return []
  const scopes = (body as { scopes?: unknown }).scopes
  if (!Array.isArray(scopes)) return []
  return scopes.filter((scope): scope is Scope => typeof scope === "string")
}

function requestedBuckets(query: unknown): string[] | undefined {
  if (!query || typeof query !== "object") return undefined
  const value = (query as { buckets?: unknown }).buckets
  if (typeof value !== "string" || value.length === 0) return undefined
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
}

export async function createApp(context: AppContext): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false,
    bodyLimit: 4 * 1024 * 1024,
    trustProxy: context.config.trustProxy,
    disableRequestLogging: true,
  })
  const publicDir = fileURLToPath(new URL("../public", import.meta.url))
  await app.register(fastifyStatic, { root: publicDir, prefix: "/" })

  const rate = new Map<string, { count: number; reset: number }>()
  app.addHook("onRequest", async (request, reply) => {
    const id = requestId(request)
    reply.header("X-Request-Id", id)
    if (request.url === "/health" || request.url === "/ready") return
    const key = request.ip
    const now = Date.now()
    const bucket = rate.get(key)
    if (!bucket || bucket.reset <= now) {
      rate.set(key, { count: 1, reset: now + 60_000 })
      return
    }
    bucket.count += 1
    if (bucket.count > 300) {
      reply.header("Retry-After", String(Math.ceil((bucket.reset - now) / 1000)))
      await reply.status(429).type("application/problem+json").send(problem(429, "rate_limited"))
    }
  })

  app.setErrorHandler((error, request, reply) => {
    if (reply.sent) return
    let status = 500
    let code = "internal"
    let detail: string | undefined
    if (error instanceof AuthError) {
      status = error.status
      code = error.code
      detail = error.message
    } else if (error instanceof HttpError) {
      status = error.status
      code = error.code
      detail = error.message
    } else if (error instanceof IndexStaleError) {
      status = 503
      code = "index_stale"
      detail = error.message
    } else if ((error as { statusCode?: number }).statusCode) {
      status = (error as { statusCode: number }).statusCode
      code = status === 400 ? "invalid_request" : "internal"
      detail = status < 500 && error instanceof Error ? error.message : undefined
    }
    if (status >= 500) {
      // Keep internal detail out of the response; logs are intentionally minimal in this build.
      console.error(`[skills-hub] ${requestId(request)} ${request.method} ${request.url} ${status} ${code}`)
    }
    reply
      .status(status)
      .type("application/problem+json")
      .header("Cache-Control", "no-store")
      .send(problem(status, code, detail))
  })

  app.get("/health", async () => ({ status: "ok", version: "0.0.3" }))

  app.get("/ready", async (_request, reply) => {
    const issues: string[] = []
    try {
      context.db.prepare("SELECT 1").get()
    } catch {
      issues.push("database")
    }
    for (const dir of [context.config.dataDir, context.config.reposDir, context.config.locksDir]) {
      if (!fs.existsSync(dir)) issues.push(dir)
    }
    if (issues.length) return reply.status(503).send({ status: "not_ready", issues })
    return { status: "ready" }
  })

  app.post("/mcp", async (request, reply) => {
    const principal = principalFromRequest(context, request)
    reply.hijack()
    try {
      await handleMcp(context, principal, request, reply)
    } catch (error) {
      const status = error instanceof AuthError || error instanceof HttpError ? error.status : 500
      reply.raw.statusCode = status
      reply.raw.setHeader("content-type", "application/json")
      reply.raw.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32603, message: "internal error" } }))
    }
  })

  app.get("/mcp", async (_request, reply) => {
    return reply.status(405).type("application/problem+json").send(problem(405, "method_not_allowed"))
  })

  app.get("/api/v1/buckets", async (request) => {
    const principal = principalFromRequest(context, request)
    requireScope(principal, "buckets:read")
    return { buckets: listBuckets(context.db, principal) }
  })

  app.get("/api/v1/manifest", async (request, reply) => {
    const principal = principalFromRequest(context, request)
    requireScope(principal, "skills:read")
    const result = buildManifest(context.db, context.config, principal, requestedBuckets(request.query))
    reply.header("ETag", result.etag)
    reply.header("Cache-Control", "private, no-cache")
    reply.header("Vary", "Authorization")
    const inm = request.headers["if-none-match"]
    if (typeof inm === "string" && inm.split(",").map((item) => item.trim()).includes(result.etag)) {
      return reply.status(304).send()
    }
    return reply.type("application/json").send(result.manifest)
  })

  app.get("/api/v1/skills/:bucket/:name/files/*", async (request, reply) => {
    const principal = principalFromRequest(context, request)
    requireScope(principal, "skills:read")
    const params = request.params as { bucket: string; name: string; "*": string }
    const relPath = params["*"]
    const pathError = validateRelPath(relPath)
    if (pathError) throw new HttpError(400, "invalid_path", pathError)
    const result = getFileContent(context.config, context.db, principal, params.bucket, params.name, relPath)
    const etag = `"sha256:${result.file.sha256}"`
    reply.header("ETag", etag)
    reply.header("X-Content-SHA256", result.file.sha256)
    reply.header("Cache-Control", "private, max-age=0, must-revalidate")
    const inm = request.headers["if-none-match"]
    if (typeof inm === "string" && inm.split(",").map((item) => item.trim()).includes(etag)) {
      return reply.status(304).send()
    }
    const type = relPath.endsWith(".md") ? "text/markdown; charset=utf-8" : "text/plain; charset=utf-8"
    return reply.type(type).send(result.content)
  })

  app.post("/api/v1/admin/login", async (request, reply) => {
    const adminToken = parseBootstrapBody(request.body)
    if (!adminTokenMatches(context.bootstrap, adminToken)) throw new AuthError(401, "token_invalid")
    const session = createSession(context.db, context.config, {
      ip: request.ip,
      userAgent: typeof request.headers["user-agent"] === "string" ? request.headers["user-agent"] : undefined,
    })
    consumeBootstrap(context.config, context.db, context.bootstrap)
    setSessionCookie(reply, context.config, session.cookie)
    audit(context.db, {
      actorType: "admin",
      actorId: session.sessionId,
      action: "admin.login",
      result: "ok",
      ip: request.ip,
    })
    return { csrfToken: session.csrf, sessionId: session.sessionId }
  })

  app.post("/api/v1/admin/logout", async (request, reply) => {
    const principal = principalFromRequest(context, request)
    requireCsrf(context, request, principal)
    if (principal.sessionId) revokeSession(context.db, principal.sessionId)
    clearSessionCookie(reply)
    audit(context.db, {
      actorType: principal.kind,
      actorId: principal.id,
      action: "admin.logout",
      result: "ok",
      ip: request.ip,
    })
    return reply.status(204).send()
  })

  app.get("/api/v1/admin/session", async (request) => {
    const principal = principalFromRequest(context, request)
    return { authenticated: true, scopes: principal.scopes, csrfToken: principal.csrf }
  })

  app.get("/api/v1/admin/buckets", async (request) => {
    const principal = principalFromRequest(context, request)
    requireScope(principal, "buckets:read")
    return {
      buckets: (context.db.prepare("SELECT * FROM buckets ORDER BY slug").all() as Array<Record<string, unknown>>).map(
        (row) => ({ ...row, needs_reindex: Boolean(row.needs_reindex) }),
      ),
    }
  })

  app.post("/api/v1/admin/buckets", async (request, reply) => {
    const principal = principalFromRequest(context, request)
    requireCsrf(context, request, principal)
    requireScope(principal, "buckets:write")
    const body = request.body as { slug?: unknown; name?: unknown; description?: unknown; remoteUrl?: unknown }
    if (typeof body?.slug !== "string" || typeof body?.name !== "string") throw new HttpError(400, "invalid_request")
    if (body.remoteUrl !== undefined && typeof body.remoteUrl !== "string") throw new HttpError(400, "invalid_request")
    let result
    try {
      result = createBucket(context.config, context.db, {
        slug: body.slug,
        name: body.name,
        description: typeof body.description === "string" ? body.description : "",
        ...(body.remoteUrl ? { remoteUrl: body.remoteUrl } : {}),
      })
    } catch (error) {
      throw new HttpError(400, "invalid_request", error instanceof Error ? error.message : String(error))
    }
    audit(context.db, {
      actorType: principal.kind,
      actorId: principal.id,
      action: "bucket.create",
      bucketSlug: body.slug,
      result: "ok",
      ip: request.ip,
    })
    return reply.status(201).send(result)
  })

  app.delete("/api/v1/admin/buckets/:slug", async (request, reply) => {
    const principal = principalFromRequest(context, request)
    requireCsrf(context, request, principal)
    requireScope(principal, "buckets:write")
    const params = request.params as { slug: string }
    const force = (request.query as { force?: string }).force === "true"
    const bucket = findBucket(context.db, params.slug)
    if (!bucket) throw new HttpError(404, "bucket_not_found")
    const count = context.db.prepare("SELECT COUNT(*) AS count FROM skills WHERE bucket_id = ?").get(bucket.id) as { count: number }
    if (count.count > 0 && !force) throw new HttpError(409, "conflict", "bucket is not empty; pass force=true")
    const source = path.join(context.config.reposDir, params.slug)
    if (fs.existsSync(source)) {
      fs.mkdirSync(context.config.trashDir, { recursive: true, mode: 0o700 })
      const target = path.join(context.config.trashDir, `${params.slug}-${Date.now()}`)
      fs.renameSync(source, target)
    }
    context.db.prepare("DELETE FROM buckets WHERE id = ?").run(bucket.id)
    audit(context.db, {
      actorType: principal.kind,
      actorId: principal.id,
      action: "bucket.delete",
      bucketSlug: params.slug,
      result: "ok",
      detail: force ? "force" : undefined,
      ip: request.ip,
    })
    return reply.status(204).send()
  })

  app.post("/api/v1/admin/reindex", async (request) => {
    const principal = principalFromRequest(context, request)
    requireCsrf(context, request, principal)
    requireScope(principal, "admin")
    return { results: reindexAll(context.config, context.db) }
  })

  app.get("/api/v1/admin/skills", async (request) => {
    const principal = principalFromRequest(context, request)
    requireScope(principal, "skills:read")
    const buckets = allowedBuckets(context.db, principal)
    const requested = requestedBuckets(request.query)
    const selected = requested ? buckets.filter((bucket) => requested.includes(bucket.slug)) : buckets
    const result = selected.map((bucket) => {
      const skills = context.db
        .prepare("SELECT name, description, version, content_hash AS contentHash, updated_at AS updatedAt FROM skills WHERE bucket_id = ? ORDER BY name")
        .all(bucket.id) as Array<Record<string, unknown>>
      return { bucket: bucket.slug, skills }
    })
    return { buckets: result }
  })

  app.get("/api/v1/admin/skills/:bucket/:name", async (request) => {
    const principal = principalFromRequest(context, request)
    requireScope(principal, "skills:read")
    const params = request.params as { bucket: string; name: string }
    const { bucket, skill, files } = getSkill(context.db, principal, params.bucket, params.name)
    const repo = repoDir(context.config, bucket.slug)
    const readable = files.map((file) => {
      const content = getFileContent(context.config, context.db, principal, params.bucket, params.name, file.path)
      return { path: file.path, sha256: file.sha256, size: file.size, content: content.content.toString("utf8") }
    })
    return {
      bucket: bucket.slug,
      name: skill.name,
      description: skill.description,
      version: skill.version,
      revision: (bucket.head_commit ?? "").slice(0, 12),
      files: readable,
    }
  })

  app.put("/api/v1/admin/skills/:bucket/:name/files/*", async (request) => {
    const principal = principalFromRequest(context, request)
    requireCsrf(context, request, principal)
    const params = request.params as { bucket: string; name: string; "*": string }
    const body = parseWriteBody(request.body)
    const result = putSkillFile(context.config, context.db, principal, {
      bucket: params.bucket,
      name: params.name,
      path: params["*"],
      content: body.content,
      ...(body.message ? { message: body.message } : {}),
    })
    audit(context.db, {
      actorType: principal.kind,
      actorId: principal.id,
      action: "skill.file.write",
      bucketSlug: params.bucket,
      skillName: params.name,
      result: "ok",
      detail: params["*"],
      ip: request.ip,
    })
    return result
  })

  app.delete("/api/v1/admin/skills/:bucket/:name/files/*", async (request) => {
    const principal = principalFromRequest(context, request)
    requireCsrf(context, request, principal)
    const params = request.params as { bucket: string; name: string; "*": string }
    const result = deleteSkillFile(context.config, context.db, principal, {
      bucket: params.bucket,
      name: params.name,
      path: params["*"],
    })
    audit(context.db, {
      actorType: principal.kind,
      actorId: principal.id,
      action: "skill.file.delete",
      bucketSlug: params.bucket,
      skillName: params.name,
      result: "ok",
      detail: params["*"],
      ip: request.ip,
    })
    return result
  })

  app.delete("/api/v1/admin/skills/:bucket/:name", async (request) => {
    const principal = principalFromRequest(context, request)
    requireCsrf(context, request, principal)
    const params = request.params as { bucket: string; name: string }
    const result = deleteSkill(context.config, context.db, principal, { bucket: params.bucket, name: params.name })
    audit(context.db, {
      actorType: principal.kind,
      actorId: principal.id,
      action: "skill.delete",
      bucketSlug: params.bucket,
      skillName: params.name,
      result: "ok",
      ip: request.ip,
    })
    return result
  })

  app.get("/api/v1/admin/tokens", async (request) => {
    const principal = principalFromRequest(context, request)
    requireScope(principal, "tokens:admin")
    const rows = context.db
      .prepare("SELECT id, label, scopes, all_buckets, created_at, last_used_at, expires_at, revoked_at FROM tokens ORDER BY created_at DESC")
      .all() as unknown as TokenRow[]
    return {
      tokens: rows.map((row) => ({
        id: row.id,
        label: row.label,
        scopes: parseScopes(row.scopes),
        allBuckets: row.all_buckets === 1,
        createdAt: row.created_at,
        lastUsedAt: row.last_used_at,
        expiresAt: row.expires_at,
        revokedAt: row.revoked_at,
      })),
    }
  })

  app.post("/api/v1/admin/tokens", async (request, reply) => {
    const principal = principalFromRequest(context, request)
    requireCsrf(context, request, principal)
    requireScope(principal, "tokens:admin")
    const body = request.body as { label?: unknown; scopes?: unknown; buckets?: unknown; expiresInDays?: unknown }
    if (typeof body?.label !== "string" || !Array.isArray(body?.buckets)) throw new HttpError(400, "invalid_request")
    const scopes = scopesFor(body)
    const buckets = body.buckets.filter((item): item is string => typeof item === "string")
    if (buckets.length === 0) throw new HttpError(400, "invalid_request", "at least one bucket is required")
    if (principal.kind !== "admin" && !principal.scopes.includes("admin")) {
      for (const scope of scopes) {
        if (!principal.scopes.includes(scope)) throw new HttpError(403, "insufficient_scope", "cannot grant a scope you do not have")
      }
      for (const bucket of buckets) {
        const row = findBucket(context.db, bucket)
        if (!row || (!principal.allBuckets && !principal.bucketIds.has(row.id))) {
          throw new HttpError(403, "bucket_forbidden", "cannot grant a bucket you do not have")
        }
      }
    }
    const expiresInDays = typeof body.expiresInDays === "number" ? body.expiresInDays : undefined
    const created = createToken(context.db, {
      label: body.label,
      scopes,
      buckets,
      ...(expiresInDays ? { expiresInDays } : {}),
    })
    audit(context.db, {
      actorType: principal.kind,
      actorId: principal.id,
      action: "token.create",
      tokenId: created.id,
      result: "ok",
      ip: request.ip,
    })
    return reply.status(201).send({ id: created.id, token: created.token })
  })

  app.delete("/api/v1/admin/tokens/:id", async (request) => {
    const principal = principalFromRequest(context, request)
    requireCsrf(context, request, principal)
    requireScope(principal, "tokens:admin")
    const params = request.params as { id: string }
    const result = context.db.prepare("UPDATE tokens SET revoked_at = ? WHERE id = ?").run(nowIso(), params.id)
    if (result.changes === 0) throw new HttpError(404, "not_found")
    audit(context.db, {
      actorType: principal.kind,
      actorId: principal.id,
      action: "token.revoke",
      tokenId: params.id,
      result: "ok",
      ip: request.ip,
    })
    return { id: params.id, revoked: true }
  })

  app.get("/api/v1/admin/audit", async (request) => {
    const principal = principalFromRequest(context, request)
    requireScope(principal, "audit:read")
    const query = request.query as { limit?: string; before?: string }
    const limit = Math.min(Math.max(Number.parseInt(query.limit ?? "100", 10) || 100, 1), 500)
    const before = query.before ? Number.parseInt(query.before, 10) : undefined
    const rows = context.db
      .prepare(
        before
          ? "SELECT * FROM audit_log WHERE id < ? ORDER BY id DESC LIMIT ?"
          : "SELECT * FROM audit_log ORDER BY id DESC LIMIT ?",
      )
      .all(...(before ? [before, limit] : [limit])) as Array<Record<string, unknown>>
    return { entries: rows }
  })

  return app
}
