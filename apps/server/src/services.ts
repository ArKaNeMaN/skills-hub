import {
  canonicalJson,
  LIMITS,
  manifestEtag,
  sha256,
  type FileEntry,
  type ManifestV1,
  type SkillManifest,
} from "@skills-hub/protocol"
import type { ServerConfig } from "./config.js"
import { nowIso, type Db } from "./db.js"
import { AuthError, type Principal } from "./auth.js"
import { readBlob, repoDir } from "./git.js"

export interface BucketRow {
  id: number
  slug: string
  name: string
  description: string
  remote_url: string | null
  default_branch: string
  head_commit: string | null
  indexed_commit: string | null
  needs_reindex: number
  last_index_error: string | null
  created_at: string
  updated_at: string
}

export interface SkillRow {
  id: number
  bucket_id: number
  name: string
  description: string
  version: string | null
  content_hash: string
  dir_path: string
  updated_at: string
}

export interface FileRow {
  id: number
  skill_id: number
  path: string
  blob_sha: string
  sha256: string
  size: number
}

export class IndexStaleError extends Error {}

export function allowedBuckets(db: Db, principal: Principal): BucketRow[] {
  if (principal.allBuckets || principal.scopes.includes("admin")) {
    return db.prepare("SELECT * FROM buckets ORDER BY slug").all() as unknown as BucketRow[]
  }
  return db
    .prepare(
      "SELECT b.* FROM buckets b JOIN token_buckets tb ON tb.bucket_id = b.id WHERE tb.token_id = ? ORDER BY b.slug",
    )
    .all(principal.id) as unknown as BucketRow[]
}

export function findBucket(db: Db, slug: string): BucketRow | undefined {
  return db.prepare("SELECT * FROM buckets WHERE slug = ?").get(slug) as BucketRow | undefined
}

export function requireAllowedBucket(db: Db, principal: Principal, slug: string): BucketRow {
  const bucket = findBucket(db, slug)
  if (!bucket) throw new AuthError(403, "bucket_forbidden")
  if (principal.allBuckets || principal.scopes.includes("admin")) return bucket
  if (!principal.bucketIds.has(bucket.id)) throw new AuthError(403, "bucket_forbidden")
  return bucket
}

export interface ManifestResult {
  manifest: ManifestV1
  etag: string
  bytes: number
}

export function buildManifest(
  db: Db,
  config: ServerConfig,
  principal: Principal,
  requested: string[] | undefined,
): ManifestResult {
  const allowed = allowedBuckets(db, principal)
  const allowedBySlug = new Map(allowed.map((bucket) => [bucket.slug, bucket]))
  let selected: BucketRow[]
  if (requested && requested.length) {
    if (requested.length > LIMITS.maxBucketsPerRequest) throw new AuthError(400, "invalid_request")
    const unique = [...new Set(requested)]
    selected = []
    for (const slug of unique) {
      const bucket = allowedBySlug.get(slug)
      if (!bucket) throw new AuthError(403, "bucket_forbidden")
      selected.push(bucket)
    }
  } else {
    selected = allowed
  }
  let totalFiles = 0
  let totalSkills = 0
  const buckets = selected.map((bucket) => {
    const skills = db.prepare("SELECT * FROM skills WHERE bucket_id = ? ORDER BY name").all(bucket.id) as unknown as SkillRow[]
    totalSkills += skills.length
    const skillManifests: SkillManifest[] = skills.map((skill) => {
      const files = db
        .prepare("SELECT path, sha256, size FROM files WHERE skill_id = ? ORDER BY path")
        .all(skill.id) as FileEntry[]
      totalFiles += files.length
      return {
        name: skill.name,
        description: skill.description,
        ...(skill.version ? { version: skill.version } : {}),
        contentHash: skill.content_hash,
        files,
      }
    })
    return {
      slug: bucket.slug,
      name: bucket.name,
      revision: (bucket.head_commit ?? "").slice(0, 12),
      skills: skillManifests,
    }
  })
  if (totalSkills > config.maxManifestSkills || totalFiles > config.maxManifestFiles) {
    throw new IndexStaleError("manifest exceeds configured limits")
  }
  const manifest: ManifestV1 = {
    schemaVersion: 1,
    generatedAt: nowIso(),
    buckets,
  }
  const { generatedAt: _generatedAt, ...stable } = manifest
  const etag = manifestEtag(stable)
  const bytes = Buffer.byteLength(canonicalJson(manifest))
  if (bytes > config.maxManifestBytes) throw new IndexStaleError("manifest exceeds configured byte limit")
  return { manifest, etag, bytes }
}

export function listBuckets(db: Db, principal: Principal): Array<{
  slug: string
  name: string
  revision: string
  skillCount: number
}> {
  return allowedBuckets(db, principal).map((bucket) => {
    const count = db.prepare("SELECT COUNT(*) AS count FROM skills WHERE bucket_id = ?").get(bucket.id) as {
      count: number
    }
    return {
      slug: bucket.slug,
      name: bucket.name,
      revision: (bucket.head_commit ?? "").slice(0, 12),
      skillCount: count.count,
    }
  })
}

export function getSkill(
  db: Db,
  principal: Principal,
  bucketSlug: string,
  name: string,
): { bucket: BucketRow; skill: SkillRow; files: FileRow[] } {
  const bucket = requireAllowedBucket(db, principal, bucketSlug)
  const skill = db.prepare("SELECT * FROM skills WHERE bucket_id = ? AND name = ?").get(bucket.id, name) as
    | SkillRow
    | undefined
  if (!skill) throw new AuthError(404, "skill_not_found")
  const files = db.prepare("SELECT * FROM files WHERE skill_id = ? ORDER BY path").all(skill.id) as unknown as FileRow[]
  return { bucket, skill, files }
}

export function getFileContent(
  config: ServerConfig,
  db: Db,
  principal: Principal,
  bucketSlug: string,
  name: string,
  relPath: string,
): { content: Buffer; file: FileRow; skill: SkillRow } {
  const { bucket, skill, files } = getSkill(db, principal, bucketSlug, name)
  const file = files.find((item) => item.path === relPath)
  if (!file) throw new AuthError(404, "not_found")
  const repo = repoDir(config, bucket.slug)
  let content: Buffer
  try {
    content = readBlob(config, repo, file.blob_sha)
  } catch {
    throw new IndexStaleError("git blob is unavailable")
  }
  if (sha256(content) !== file.sha256 || content.length !== file.size) {
    throw new IndexStaleError("indexed file hash does not match git blob")
  }
  return { content, file, skill }
}

export interface AuditInput {
  actorType: "token" | "admin" | "cli" | "system"
  actorId?: string
  action: string
  bucketSlug?: string
  skillName?: string
  tokenId?: string
  requestId?: string
  ip?: string
  userAgent?: string
  result: "ok" | "error"
  detail?: string
}

export function audit(db: Db, input: AuditInput): void {
  db.prepare(
    "INSERT INTO audit_log(ts, actor_type, actor_id, action, bucket_slug, skill_name, token_id, request_id, ip, user_agent, result, detail) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
  ).run(
    nowIso(),
    input.actorType,
    input.actorId ?? null,
    input.action,
    input.bucketSlug ?? null,
    input.skillName ?? null,
    input.tokenId ?? null,
    input.requestId ?? null,
    input.ip ?? null,
    input.userAgent ?? null,
    input.result,
    input.detail ?? null,
  )
}
