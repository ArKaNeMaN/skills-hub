import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import { hasScope, isAdmin, type Scope } from "@skills-hub/protocol"
import type { ServerConfig } from "./config.js"
import { nowIso, type Db } from "./db.js"

export interface Principal {
  kind: "token" | "admin"
  id: string
  scopes: Scope[]
  bucketIds: Set<number>
  allBuckets: boolean
  sessionId?: string
  csrf?: string
}

export interface TokenRow {
  id: string
  token_hash: string
  label: string
  scopes: string
  all_buckets: number
  created_at: string
  last_used_at: string | null
  expires_at: string | null
  revoked_at: string | null
}

export interface SessionRow {
  id: string
  token_hash: string
  csrf_token: string
  created_at: string
  expires_at: string
  last_seen_at: string
  revoked_at: string | null
}

export class AuthError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message?: string,
  ) {
    super(message ?? code)
  }
}

export function hashSecret(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}

export function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"))
}

export function generateTokenString(): string {
  const id = randomBytes(6).toString("base64url").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 8).padEnd(8, "0")
  const secret = randomBytes(32).toString("base64url")
  return `shk_${id}_${secret}`
}

export function parseToken(value: string): { id: string; secret: string } | undefined {
  const match = /^shk_([a-z0-9]{8})_([A-Za-z0-9_-]{40,})$/.exec(value)
  if (!match) return undefined
  return { id: match[1] as string, secret: match[2] as string }
}

export function parseScopes(value: string): Scope[] {
  try {
    const parsed = JSON.parse(value) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter((item): item is Scope => typeof item === "string")
  } catch {
    return []
  }
}

export interface CreateTokenOptions {
  label: string
  scopes: Scope[]
  buckets: string[]
  expiresInDays?: number
  allBuckets?: boolean
}

export function createToken(db: Db, options: CreateTokenOptions): { token: string; id: string } {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const token = generateTokenString()
    const parsed = parseToken(token)
    if (!parsed) continue
    const existing = db.prepare("SELECT id FROM tokens WHERE id = ?").get(parsed.id) as { id?: string } | undefined
    if (existing) continue
    const bucketRows = options.buckets.length
      ? (db.prepare(`SELECT id, slug FROM buckets WHERE slug IN (${options.buckets.map(() => "?").join(",")})`).all(
          ...options.buckets,
        ) as { id: number; slug: string }[])
      : []
    const found = new Set(bucketRows.map((row) => row.slug))
    const missing = options.buckets.filter((slug) => !found.has(slug))
    if (missing.length) throw new Error(`unknown buckets: ${missing.join(", ")}`)
    const expiresAt =
      options.expiresInDays && options.expiresInDays > 0
        ? new Date(Date.now() + options.expiresInDays * 86_400_000).toISOString()
        : null
    db.prepare(
      "INSERT INTO tokens(id, token_hash, label, scopes, all_buckets, created_at, expires_at) VALUES(?,?,?,?,?,?,?)",
    ).run(parsed.id, hashSecret(token), options.label, JSON.stringify(options.scopes), options.allBuckets ? 1 : 0, nowIso(), expiresAt)
    for (const row of bucketRows) {
      db.prepare("INSERT INTO token_buckets(token_id, bucket_id) VALUES(?,?)").run(parsed.id, row.id)
    }
    return { token, id: parsed.id }
  }
  throw new Error("failed to allocate token id")
}

export function tokenBuckets(db: Db, tokenId: string): Set<number> {
  const rows = db.prepare("SELECT bucket_id FROM token_buckets WHERE token_id = ?").all(tokenId) as {
    bucket_id: number
  }[]
  return new Set(rows.map((row) => row.bucket_id))
}

export function verifyBearer(db: Db, authorization: string | undefined): Principal {
  if (!authorization?.startsWith("Bearer ")) throw new AuthError(401, "unauthorized")
  const parsed = parseToken(authorization.slice("Bearer ".length).trim())
  if (!parsed) throw new AuthError(401, "token_invalid")
  const row = db.prepare("SELECT * FROM tokens WHERE id = ?").get(parsed.id) as TokenRow | undefined
  if (!row) throw new AuthError(401, "token_invalid")
  if (!safeEqualHex(row.token_hash, hashSecret(authorization.slice("Bearer ".length).trim()))) {
    throw new AuthError(401, "token_invalid")
  }
  if (row.revoked_at) throw new AuthError(401, "token_revoked")
  if (row.expires_at && Date.parse(row.expires_at) <= Date.now()) throw new AuthError(401, "token_expired")
  db.prepare("UPDATE tokens SET last_used_at = ? WHERE id = ?").run(nowIso(), row.id)
  const scopes = parseScopes(row.scopes)
  return {
    kind: "token",
    id: row.id,
    scopes,
    bucketIds: tokenBuckets(db, row.id),
    allBuckets: row.all_buckets === 1,
  }
}

export function requireScope(principal: Principal, scope: Scope): void {
  if (!hasScope(principal.scopes, scope)) throw new AuthError(403, "insufficient_scope")
}

export function requireBucket(principal: Principal, bucketId: number): void {
  if (principal.allBuckets || isAdmin(principal.scopes)) return
  if (!principal.bucketIds.has(bucketId)) throw new AuthError(403, "bucket_forbidden")
}

export function adminTokenMatches(expected: string | undefined, candidate: string): boolean {
  if (!expected) return false
  const a = Buffer.from(expected)
  const b = Buffer.from(candidate)
  return a.length === b.length && timingSafeEqual(a, b)
}

export function createSession(
  db: Db,
  config: ServerConfig,
  input: { ip?: string; userAgent?: string },
): { cookie: string; csrf: string; sessionId: string } {
  const id = randomBytes(12).toString("base64url").slice(0, 16)
  const secret = randomBytes(32).toString("base64url")
  const csrf = randomBytes(32).toString("base64url")
  const now = nowIso()
  const expires = new Date(Date.now() + config.sessionTtlHours * 3_600_000).toISOString()
  db.prepare(
    "INSERT INTO sessions(id, token_hash, csrf_token, created_at, expires_at, last_seen_at, ip, user_agent) VALUES(?,?,?,?,?,?,?,?)",
  ).run(id, hashSecret(secret), csrf, now, expires, now, input.ip ?? null, input.userAgent ?? null)
  return { cookie: `sh_sess_${id}_${secret}`, csrf, sessionId: id }
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const result: Record<string, string> = {}
  if (!header) return result
  for (const part of header.split(";")) {
    const index = part.indexOf("=")
    if (index < 0) continue
    const key = part.slice(0, index).trim()
    const value = part.slice(index + 1).trim()
    if (key) result[key] = decodeURIComponent(value)
  }
  return result
}

export function verifySession(db: Db, cookie: string | undefined): Principal {
  if (!cookie) throw new AuthError(401, "unauthorized")
  const match = /^sh_sess_([A-Za-z0-9_-]{16})_(.+)$/.exec(cookie)
  if (!match) throw new AuthError(401, "unauthorized")
  const id = match[1] as string
  const secret = match[2] as string
  const row = db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as SessionRow | undefined
  if (!row || row.revoked_at) throw new AuthError(401, "unauthorized")
  if (!safeEqualHex(row.token_hash, hashSecret(secret))) throw new AuthError(401, "unauthorized")
  if (Date.parse(row.expires_at) <= Date.now()) throw new AuthError(401, "unauthorized")
  db.prepare("UPDATE sessions SET last_seen_at = ? WHERE id = ?").run(nowIso(), id)
  return {
    kind: "admin",
    id,
    scopes: ["admin"],
    bucketIds: new Set(),
    allBuckets: true,
    sessionId: id,
    csrf: row.csrf_token,
  }
}

export function revokeSession(db: Db, sessionId: string): void {
  db.prepare("UPDATE sessions SET revoked_at = ? WHERE id = ?").run(nowIso(), sessionId)
}
