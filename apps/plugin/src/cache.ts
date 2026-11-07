import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import {
  contentHash,
  sha256,
  validateRelPath,
  validateSkillName,
  type ManifestV1,
  type SkillManifest,
} from "@skills-hub/protocol"

export interface ManagedFile {
  sha256: string
  size: number
}

export interface ManagedSkill {
  sourceBucket: string
  files: Record<string, ManagedFile>
  overridden?: string[]
}

export interface ManagedIndex {
  schema: 1
  skills: Record<string, ManagedSkill>
}

export interface CachedManifest {
  schema: 1
  etag: string
  manifest: ManifestV1
}

export interface FetchFile {
  (bucket: string, skill: string, file: string): Promise<Buffer>
}

export type Logger = (level: "debug" | "warn", message: string, detail?: unknown) => void

function emptyManaged(): ManagedIndex {
  return { schema: 1, skills: {} }
}

function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T
  } catch {
    return undefined
  }
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const temp = `${file}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  fs.renameSync(temp, file)
}

function isComplete(dir: string): boolean {
  return (
    fs.existsSync(path.join(dir, "manifest.json")) &&
    fs.existsSync(path.join(dir, "managed.json")) &&
    fs.existsSync(path.join(dir, "skills")) &&
    fs.statSync(path.join(dir, "skills")).isDirectory()
  )
}

export function resolveWinners(
  manifest: ManifestV1,
  bucketOrder?: string[],
): { skills: Array<{ skill: SkillManifest; bucket: string }>; order: string[] } {
  const order = bucketOrder?.length ? bucketOrder : manifest.buckets.map((bucket) => bucket.slug)
  const bySlug = new Map(manifest.buckets.map((bucket) => [bucket.slug, bucket]))
  const winners = new Map<string, { skill: SkillManifest; bucket: string; overridden: string[] }>()
  for (const slug of order) {
    const bucket = bySlug.get(slug)
    if (!bucket) continue
    for (const skill of bucket.skills) {
      const previous = winners.get(skill.name)
      winners.set(skill.name, {
        skill,
        bucket: slug,
        overridden: previous ? [...(previous.overridden ?? []), previous.bucket] : [],
      })
    }
  }
  return {
    skills: [...winners.values()].map((entry) => ({ skill: entry.skill, bucket: entry.bucket })),
    order,
  }
}

export class Cache {
  readonly root: string
  readonly generations: string
  readonly tmp: string
  readonly trash: string

  constructor(root: string) {
    this.root = root
    this.generations = path.join(root, "generations")
    this.tmp = path.join(root, "tmp")
    this.trash = path.join(root, "trash")
  }

  ensure(): void {
    for (const dir of [this.root, this.generations, this.tmp, this.trash]) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    }
  }

  activeGeneration(): string | undefined {
    const pointer = readJson<{ schema?: number; generation?: string }>(path.join(this.root, "current.json"))
    if (pointer?.generation) {
      const dir = path.join(this.generations, pointer.generation)
      if (isComplete(dir)) return pointer.generation
    }
    return this.latestGeneration()
  }

  latestGeneration(): string | undefined {
    if (!fs.existsSync(this.generations)) return undefined
    const entries = fs
      .readdirSync(this.generations, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => ({ name: entry.name, mtime: fs.statSync(path.join(this.generations, entry.name)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)
    return entries.find((entry) => isComplete(path.join(this.generations, entry.name)))?.name
  }

  activeDir(): string | undefined {
    const generation = this.activeGeneration()
    return generation ? path.join(this.generations, generation) : undefined
  }

  activeSkillsDir(): string | undefined {
    const dir = this.activeDir()
    return dir ? path.join(dir, "skills") : undefined
  }

  readManifest(): CachedManifest | undefined {
    const dir = this.activeDir()
    if (!dir) return undefined
    return readJson<CachedManifest>(path.join(dir, "manifest.json"))
  }

  readManaged(): ManagedIndex {
    const dir = this.activeDir()
    if (!dir) return emptyManaged()
    return readJson<ManagedIndex>(path.join(dir, "managed.json")) ?? emptyManaged()
  }

  async build(
    manifest: ManifestV1,
    etag: string,
    bucketOrder: string[] | undefined,
    fetchFile: FetchFile,
    verifyHashes: boolean,
    log: Logger,
  ): Promise<string> {
    this.ensure()
    const uuid = crypto.randomUUID()
    const staging = path.join(this.tmp, uuid)
    const stagingSkills = path.join(staging, "skills")
    fs.mkdirSync(stagingSkills, { recursive: true, mode: 0o700 })
    const active = this.activeDir()
    const previousManaged = this.readManaged()
    const { skills } = resolveWinners(manifest, bucketOrder)
    const managed: ManagedIndex = { schema: 1, skills: {} }
    const winnerNames = new Set(skills.map((entry) => entry.skill.name))
    try {
      for (const { skill, bucket } of skills) {
        const nameError = validateSkillName(skill.name)
        if (nameError) {
          log("warn", `skip invalid skill name ${skill.name}: ${nameError}`)
          continue
        }
        const targetDir = path.join(stagingSkills, skill.name)
        fs.mkdirSync(targetDir, { recursive: true, mode: 0o700 })
        const files: Record<string, ManagedFile> = {}
        for (const file of [...skill.files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
          const pathError = validateRelPath(file.path)
          if (pathError) throw new Error(`invalid path ${file.path}: ${pathError}`)
          const target = path.resolve(targetDir, ...file.path.split("/"))
          if (!target.startsWith(`${targetDir}${path.sep}`)) throw new Error("path escapes skill directory")
          const previous = previousManaged.skills[skill.name]?.files[file.path]
          const source = active ? path.join(active, "skills", skill.name, ...file.path.split("/")) : undefined
          let content: Buffer | undefined
          if (
            previous &&
            previous.sha256 === file.sha256 &&
            previous.size === file.size &&
            source &&
            fs.existsSync(source) &&
            fs.statSync(source).isFile()
          ) {
            if (verifyHashes) {
              const existing = fs.readFileSync(source)
              if (sha256(existing) === file.sha256 && existing.length === file.size) content = existing
            } else {
              content = fs.readFileSync(source)
            }
          }
          if (!content) content = await fetchFile(bucket, skill.name, file.path)
          if (content.length !== file.size || sha256(content) !== file.sha256) {
            throw new Error(`hash mismatch for ${bucket}/${skill.name}/${file.path}`)
          }
          fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 })
          fs.writeFileSync(target, content, { mode: 0o644 })
          files[file.path] = { sha256: file.sha256, size: file.size }
        }
        const computed = contentHash(Object.entries(files).map(([filePath, file]) => ({ path: filePath, sha256: file.sha256 })))
        if (computed !== skill.contentHash) {
          log("warn", `content hash mismatch for ${bucket}/${skill.name}`)
        }
        managed.skills[skill.name] = {
          sourceBucket: bucket,
          files,
          ...(previousManaged.skills[skill.name]?.overridden?.length
            ? { overridden: previousManaged.skills[skill.name]?.overridden }
            : {}),
        }
      }
      if (active) {
        const activeSkills = path.join(active, "skills")
        if (fs.existsSync(activeSkills)) {
          for (const entry of fs.readdirSync(activeSkills, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue
            if (previousManaged.skills[entry.name] || winnerNames.has(entry.name)) continue
            try {
              fs.cpSync(path.join(activeSkills, entry.name), path.join(stagingSkills, entry.name), { recursive: true })
            } catch (error) {
              log("warn", `could not preserve unmanaged skill ${entry.name}`, error)
            }
          }
        }
      }
      const overridden = new Map<string, string[]>()
      for (const entry of manifest.buckets) {
        for (const skill of entry.skills) {
          const winner = managed.skills[skill.name]
          if (winner && winner.sourceBucket !== entry.slug) {
            overridden.set(skill.name, [...(overridden.get(skill.name) ?? []), entry.slug])
          }
        }
      }
      for (const [name, buckets] of overridden) {
        const managedSkill = managed.skills[name]
        if (managedSkill) managedSkill.overridden = [...new Set(buckets)]
      }
      writeJson(path.join(staging, "manifest.json"), { schema: 1, etag, manifest })
      writeJson(path.join(staging, "managed.json"), managed)
      const generationDir = path.join(this.generations, uuid)
      fs.renameSync(staging, generationDir)
      this.switch(uuid)
      this.gc()
      return generationDir
    } catch (error) {
      fs.rmSync(staging, { recursive: true, force: true })
      throw error
    }
  }

  switch(generation: string): void {
    writeJson(path.join(this.root, "current.json"), { schema: 1, generation })
  }

  gc(): void {
    const current = this.activeGeneration()
    if (fs.existsSync(this.generations)) {
      const entries = fs
        .readdirSync(this.generations, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => ({ name: entry.name, mtime: fs.statSync(path.join(this.generations, entry.name)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime)
      let kept = 0
      for (const entry of entries) {
        if (kept < 2 || entry.name === current) {
          kept += 1
          continue
        }
        fs.rmSync(path.join(this.generations, entry.name), { recursive: true, force: true })
      }
    }
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000
    for (const dir of [this.tmp, this.trash]) {
      if (!fs.existsSync(dir)) continue
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const target = path.join(dir, entry.name)
        try {
          if (fs.statSync(target).mtimeMs < cutoff) fs.rmSync(target, { recursive: true, force: true })
        } catch {
          // ignore
        }
      }
    }
  }
}
