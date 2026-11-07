import fs from "node:fs"
import path from "node:path"
import {
  contentHash,
  LIMITS,
  parseSkillFrontmatter,
  sha256,
  validateRelPath,
  validateSkillName,
  type FileEntry,
} from "@skills-hub/protocol"
import type { ServerConfig } from "./config.js"
import { nowIso, transaction, type Db } from "./db.js"
import {
  defaultBranch,
  headCommit,
  initBucketRepo,
  listTree,
  readBlob,
  readBucketJson,
  repoDir,
  runGit,
  type TreeEntry,
} from "./git.js"

export interface ReindexResult {
  bucket: string
  commit: string
  skills: number
  error?: string
}

function readHeadFile(config: ServerConfig, repo: string, file: string): Buffer | undefined {
  const result = runGit(config, repo, ["show", `HEAD:${file}`], { allowFailure: true })
  return result.status === 0 ? result.stdout : undefined
}

function isText(buffer: Buffer): boolean {
  if (buffer.includes(0)) return false
  return true
}

interface IndexedSkill {
  name: string
  description: string
  version?: string
  dir: string
  files: Array<FileEntry & { blobSha: string }>
}

function indexSkill(
  config: ServerConfig,
  repo: string,
  entries: TreeEntry[],
  dir: string,
): { skill?: IndexedSkill; error?: string } {
  const name = dir.slice("skills/".length)
  const nameError = validateSkillName(name)
  if (nameError) return { error: nameError }
  const prefix = `${dir}/`
  const files = entries.filter((entry) => entry.path.startsWith(prefix))
  if (!files.length) return { error: "empty skill directory" }
  if (files.length > LIMITS.maxFilesPerSkill) return { error: "too many files" }
  let total = 0
  const fileEntries: Array<FileEntry & { blobSha: string }> = []
  for (const entry of files) {
    const rel = entry.path.slice(prefix.length)
    if (rel.includes("/SKILL.md")) return { error: "nested SKILL.md is not allowed" }
    const pathError = validateRelPath(rel)
    if (pathError) return { error: pathError }
    if (entry.mode === "120000" || entry.mode === "160000") return { error: "symlink and submodule are not allowed" }
    if (entry.size > LIMITS.maxFileBytes) return { error: `file ${rel} is too large` }
    total += entry.size
    if (total > LIMITS.maxSkillBytes) return { error: "skill is too large" }
    const content = readBlob(config, repo, entry.sha)
    if (!isText(content)) return { error: `file ${rel} is not text` }
    fileEntries.push({ path: rel, sha256: sha256(content), size: content.length, blobSha: entry.sha })
  }
  const skillFile = fileEntries.find((file) => file.path === "SKILL.md")
  if (!skillFile) return { error: "SKILL.md is missing" }
  const content = readBlob(config, repo, skillFile.blobSha).toString("utf8")
  const parsed = parseSkillFrontmatter(content)
  if (!parsed.ok) return { error: parsed.error }
  if (parsed.skill.name !== name) return { error: `frontmatter.name must equal directory name "${name}"` }
  return {
    skill: {
      name,
      description: parsed.skill.description,
      version: parsed.skill.version,
      dir,
      files: fileEntries,
    },
  }
}

export function reindexBucket(config: ServerConfig, db: Db, slug: string): ReindexResult {
  const repo = repoDir(config, slug)
  if (!fs.existsSync(path.join(repo, ".git"))) {
    throw new Error(`bucket ${slug} has no git repository`)
  }
  const commit = headCommit(config, repo)
  const bucketRaw = readHeadFile(config, repo, "bucket.json")
  let bucketName = slug
  let description = ""
  if (bucketRaw) {
    try {
      const parsed = JSON.parse(bucketRaw.toString("utf8")) as { name?: string; description?: string }
      if (typeof parsed.name === "string") bucketName = parsed.name
      if (typeof parsed.description === "string") description = parsed.description
    } catch {
      // keep slug as name
    }
  }
  const entries = listTree(config, repo, commit)
  const dirs = new Set<string>()
  for (const entry of entries) {
    if (!entry.path.startsWith("skills/")) continue
    const parts = entry.path.split("/")
    if (parts.length >= 3) dirs.add(`skills/${parts[1]}`)
  }
  const errors: string[] = []
  const skills: IndexedSkill[] = []
  for (const dir of [...dirs].sort()) {
    const indexed = indexSkill(config, repo, entries, dir)
    if (indexed.skill) skills.push(indexed.skill)
    else errors.push(`${dir}: ${indexed.error ?? "invalid skill"}`)
  }
  const duplicate = new Set<string>()
  const unique = skills.filter((skill) => {
    if (duplicate.has(skill.name)) {
      errors.push(`${skill.dir}: duplicate skill name`)
      return false
    }
    duplicate.add(skill.name)
    return true
  })
  const now = nowIso()
  transaction(db, () => {
    const bucketRow = db.prepare("SELECT id FROM buckets WHERE slug = ?").get(slug) as { id: number } | undefined
    let bucketId: number
    if (bucketRow) {
      bucketId = bucketRow.id
      db.prepare(
        "UPDATE buckets SET name = ?, description = ?, head_commit = ?, indexed_commit = ?, needs_reindex = 0, last_index_error = ?, updated_at = ? WHERE id = ?",
      ).run(bucketName, description, commit, commit, errors.length ? errors.join("\n") : null, now, bucketId)
    } else {
      const result = db
        .prepare(
          "INSERT INTO buckets(slug, name, description, head_commit, indexed_commit, needs_reindex, last_index_error, created_at, updated_at) VALUES(?,?,?,?,?,0,?,?,?)",
        )
        .run(slug, bucketName, description, commit, commit, errors.length ? errors.join("\n") : null, now, now)
      bucketId = Number(result.lastInsertRowid)
    }
    db.prepare("DELETE FROM skills WHERE bucket_id = ?").run(bucketId)
    for (const skill of unique) {
      const result = db
        .prepare(
          "INSERT INTO skills(bucket_id, name, description, version, content_hash, dir_path, updated_at) VALUES(?,?,?,?,?,?,?)",
        )
        .run(
          bucketId,
          skill.name,
          skill.description,
          skill.version ?? null,
          contentHash(skill.files),
          skill.dir,
          now,
        )
      const skillId = Number(result.lastInsertRowid)
      for (const file of skill.files) {
        db.prepare("INSERT INTO files(skill_id, path, blob_sha, sha256, size) VALUES(?,?,?,?,?)").run(
          skillId,
          file.path,
          file.blobSha,
          file.sha256,
          file.size,
        )
      }
    }
  })
  return { bucket: slug, commit, skills: unique.length, ...(errors.length ? { error: errors.join("\n") } : {}) }
}

export function reindexAll(config: ServerConfig, db: Db): ReindexResult[] {
  fs.mkdirSync(config.reposDir, { recursive: true, mode: 0o700 })
  const results: ReindexResult[] = []
  for (const entry of fs.readdirSync(config.reposDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const slug = entry.name
    const repo = repoDir(config, slug)
    if (!fs.existsSync(path.join(repo, ".git"))) continue
    const bucket = readBucketJson(repo)
    if (!bucket) continue
    try {
      results.push(reindexBucket(config, db, slug))
    } catch (error) {
      results.push({ bucket: slug, commit: "", skills: 0, error: error instanceof Error ? error.message : String(error) })
    }
  }
  return results
}

export function createBucket(
  config: ServerConfig,
  db: Db,
  input: { slug: string; name: string; description?: string; remoteUrl?: string },
): ReindexResult {
  const repo = repoDir(config, input.slug)
  if (fs.existsSync(repo) && !fs.existsSync(path.join(repo, ".git"))) {
    throw new Error(`directory ${repo} exists but is not a git repository`)
  }
  initBucketRepo(config, input.slug, input.name, input.description ?? "", input.remoteUrl)
  const result = reindexBucket(config, db, input.slug)
  if (input.remoteUrl) {
    db.prepare("UPDATE buckets SET remote_url = ?, default_branch = ?, updated_at = ? WHERE slug = ?").run(
      input.remoteUrl,
      defaultBranch(config, repoDir(config, input.slug)),
      nowIso(),
      input.slug,
    )
  }
  return result
}
