import fs from "node:fs"
import path from "node:path"
import {
  LIMITS,
  parseSkillFrontmatter,
  validateRelPath,
  validateSkillName,
} from "@skills-hub/protocol"
import type { ServerConfig } from "./config.js"
import { nowIso, type Db } from "./db.js"
import { HttpError } from "./errors.js"
import {
  assertInside,
  assertNoSymlinkComponents,
  bucketFile,
  commitPaths,
  headCommit,
  removePaths,
  repoDir,
  statusPorcelain,
  withBucketLock,
  writeFileAtomic,
  GitError,
  PathSecurityError,
  RepoBusyError,
} from "./git.js"
import { reindexBucket } from "./indexer.js"
import { requireAllowedBucket, type FileRow, type SkillRow } from "./services.js"
import { requireScope, type Principal } from "./auth.js"

export interface WriteResult {
  bucket: string
  name: string
  path: string
  commit: string
  revision: string
  created: boolean
  createdSkill: boolean
  skill: {
    name: string
    description: string
    version?: string
    contentHash: string
    files: Array<{ path: string; sha256: string; size: number }>
  }
}

function mapGitError(error: unknown): never {
  if (error instanceof RepoBusyError) throw new HttpError(409, "repo_busy", error.message)
  if (error instanceof PathSecurityError) throw new HttpError(400, "invalid_path", error.message)
  if (error instanceof HttpError) throw error
  if (error instanceof GitError) throw new HttpError(500, "git_error", "git command failed")
  throw error
}

function skillRow(db: Db, bucketId: number, name: string): SkillRow | undefined {
  return db.prepare("SELECT * FROM skills WHERE bucket_id = ? AND name = ?").get(bucketId, name) as SkillRow | undefined
}

function fileRows(db: Db, skillId: number): FileRow[] {
  return db.prepare("SELECT * FROM files WHERE skill_id = ? ORDER BY path").all(skillId) as unknown as FileRow[]
}

function skillFromRow(db: Db, skill: SkillRow, files: FileRow[]) {
  return {
    name: skill.name,
    description: skill.description,
    ...(skill.version ? { version: skill.version } : {}),
    contentHash: skill.content_hash,
    files: files.map((file) => ({ path: file.path, sha256: file.sha256, size: file.size })),
  }
}

function enqueuePush(db: Db, bucketId: number, commit: string): void {
  const row = db.prepare("SELECT remote_url FROM buckets WHERE id = ?").get(bucketId) as { remote_url?: string | null } | undefined
  if (!row?.remote_url) return
  db.prepare(
    "INSERT INTO git_push_queue(bucket_id, commit_sha, attempts, status, next_attempt_at, created_at) VALUES(?,?,0,'pending',?,?)",
  ).run(bucketId, commit, nowIso(), nowIso())
}

function ensureClean(config: ServerConfig, repo: string): void {
  const dirty = statusPorcelain(config, repo)
  if (dirty) throw new HttpError(409, "repo_dirty", "bucket working tree has uncommitted changes")
}

function ensureIndexed(config: ServerConfig, db: Db, slug: string, repo: string): void {
  const row = db.prepare("SELECT head_commit, indexed_commit FROM buckets WHERE slug = ?").get(slug) as
    | { head_commit?: string; indexed_commit?: string }
    | undefined
  if (!row) throw new HttpError(404, "bucket_not_found")
  const head = headCommit(config, repo)
  if (row.indexed_commit !== head) {
    try {
      reindexBucket(config, db, slug)
    } catch {
      db.prepare("UPDATE buckets SET needs_reindex = 1, last_index_error = ? WHERE slug = ?").run(
        "reindex failed before write",
        slug,
      )
      throw new HttpError(503, "index_stale", "bucket index is stale")
    }
  }
}

function checkTotalLimits(files: FileRow[], nextPath: string, nextSize: number): void {
  const existing = files.find((file) => file.path === nextPath)
  const count = files.length + (existing ? 0 : 1)
  const total = files.reduce((sum, file) => sum + (file.path === nextPath ? 0 : file.size), 0) + nextSize
  if (count > LIMITS.maxFilesPerSkill) throw new HttpError(400, "invalid_skill", "too many files in skill")
  if (total > LIMITS.maxSkillBytes) throw new HttpError(400, "invalid_skill", "skill is too large")
}

export function putSkillFile(
  config: ServerConfig,
  db: Db,
  principal: Principal,
  input: { bucket: string; name: string; path: string; content: string; message?: string },
): WriteResult {
  requireScope(principal, "skills:write")
  const bucket = requireAllowedBucket(db, principal, input.bucket)
  const nameError = validateSkillName(input.name)
  if (nameError) throw new HttpError(400, "invalid_skill", nameError)
  const pathError = validateRelPath(input.path)
  if (pathError) throw new HttpError(400, "invalid_path", pathError)
  if (Buffer.byteLength(input.content, "utf8") > LIMITS.maxFileBytes) {
    throw new HttpError(413, "payload_too_large", "file is too large")
  }
  if (input.content.includes("\0")) throw new HttpError(400, "invalid_skill", "NUL is not allowed")
  if (input.path === "SKILL.md") {
    const parsed = parseSkillFrontmatter(input.content)
    if (!parsed.ok) throw new HttpError(400, "invalid_skill", parsed.error)
    if (parsed.skill.name !== input.name) {
      throw new HttpError(400, "invalid_skill", `frontmatter.name must equal "${input.name}"`)
    }
  }
  const repo = repoDir(config, input.bucket)
  try {
    return withBucketLock(config, input.bucket, () => {
      ensureClean(config, repo)
      ensureIndexed(config, db, input.bucket, repo)
      const skillDir = path.join(repo, "skills", input.name)
      const target = path.join(skillDir, ...input.path.split("/"))
      assertNoSymlinkComponents(repo, path.relative(repo, target))
      fs.mkdirSync(path.join(repo, "skills"), { recursive: true, mode: 0o700 })
      fs.mkdirSync(skillDir, { recursive: true, mode: 0o700 })
      assertInside(path.join(repo, "skills"), target)
      const currentSkill = skillRow(db, bucket.id, input.name)
      if (input.path !== "SKILL.md" && !currentSkill) throw new HttpError(404, "skill_not_found")
      if (currentSkill) {
        checkTotalLimits(fileRows(db, currentSkill.id), input.path, Buffer.byteLength(input.content, "utf8"))
      }
      const existed = fs.existsSync(target)
      const previous = existed ? fs.readFileSync(target) : undefined
      let commit: string
      try {
        writeFileAtomic(target, input.content)
        commit = commitPaths(config, repo, [path.relative(repo, skillDir)], `skill(${input.name}): write ${input.path}`)
      } catch (error) {
        if (previous) writeFileAtomic(target, previous)
        else fs.rmSync(target, { force: true })
        throw error
      }
      let indexed
      try {
        indexed = reindexBucket(config, db, input.bucket)
      } catch (error) {
        db.prepare("UPDATE buckets SET needs_reindex = 1, last_index_error = ? WHERE slug = ?").run(
          error instanceof Error ? error.message : String(error),
          input.bucket,
        )
        throw new HttpError(503, "index_stale", "write committed but index rebuild failed")
      }
      const skill = skillRow(db, bucket.id, input.name)
      if (!skill) throw new HttpError(503, "index_stale", "skill is not visible after write")
      enqueuePush(db, bucket.id, commit)
      return {
        bucket: input.bucket,
        name: input.name,
        path: input.path,
        commit,
        revision: indexed.commit.slice(0, 12),
        created: !existed,
        createdSkill: !currentSkill,
        skill: skillFromRow(db, skill, fileRows(db, skill.id)),
      }
    })
  } catch (error) {
    mapGitError(error)
  }
}

export function deleteSkillFile(
  config: ServerConfig,
  db: Db,
  principal: Principal,
  input: { bucket: string; name: string; path: string; message?: string },
): { commit: string; revision: string } {
  requireScope(principal, "skills:delete")
  if (input.path === "SKILL.md") throw new HttpError(400, "cannot_delete_entrypoint")
  const bucket = requireAllowedBucket(db, principal, input.bucket)
  const skill = skillRow(db, bucket.id, input.name)
  if (!skill) throw new HttpError(404, "skill_not_found")
  const pathError = validateRelPath(input.path)
  if (pathError) throw new HttpError(400, "invalid_path", pathError)
  const repo = repoDir(config, input.bucket)
  try {
    return withBucketLock(config, input.bucket, () => {
      ensureClean(config, repo)
      ensureIndexed(config, db, input.bucket, repo)
      const relative = path.posix.join("skills", input.name, input.path)
      const commit = removePaths(config, repo, [relative], `skill(${input.name}): delete ${input.path}`)
      const indexed = reindexBucket(config, db, input.bucket)
      enqueuePush(db, bucket.id, commit)
      return { commit, revision: indexed.commit.slice(0, 12) }
    })
  } catch (error) {
    mapGitError(error)
  }
}

export function deleteSkill(
  config: ServerConfig,
  db: Db,
  principal: Principal,
  input: { bucket: string; name: string; message?: string },
): { commit: string; revision: string } {
  requireScope(principal, "skills:delete")
  const bucket = requireAllowedBucket(db, principal, input.bucket)
  const skill = skillRow(db, bucket.id, input.name)
  if (!skill) throw new HttpError(404, "skill_not_found")
  const repo = repoDir(config, input.bucket)
  try {
    return withBucketLock(config, input.bucket, () => {
      ensureClean(config, repo)
      ensureIndexed(config, db, input.bucket, repo)
      const commit = removePaths(config, repo, [`skills/${input.name}`], `skill(${input.name}): delete`)
      const indexed = reindexBucket(config, db, input.bucket)
      enqueuePush(db, bucket.id, commit)
      return { commit, revision: indexed.commit.slice(0, 12) }
    })
  } catch (error) {
    mapGitError(error)
  }
}

export function touchBucketConfig(config: ServerConfig, db: Db, slug: string, name: string, description: string): void {
  const repo = repoDir(config, slug)
  const data = { schema: 1 as const, slug, name, description, createdAt: nowIso() }
  writeFileAtomic(bucketFile(repo), `${JSON.stringify(data, null, 2)}\n`)
  commitPaths(config, repo, ["bucket.json"], `bucket: update ${slug}`)
  reindexBucket(config, db, slug)
}
