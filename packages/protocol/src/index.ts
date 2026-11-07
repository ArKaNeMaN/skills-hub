import { createHash } from "node:crypto"
import { parse as parseYaml } from "yaml"
import { z } from "zod"

export const SCHEMA_VERSION = 1

export const LIMITS = {
  maxBucketsPerRequest: 20,
  maxSkills: 5000,
  maxFiles: 50_000,
  maxFilesPerSkill: 200,
  maxFileBytes: 256 * 1024,
  maxSkillBytes: 2 * 1024 * 1024,
  maxManifestBytes: 20 * 1024 * 1024,
  maxPathDepth: 8,
  maxPathLength: 512,
  maxNameLength: 64,
  maxDescriptionLength: 1024,
} as const

export const SCOPES = [
  "skills:read",
  "skills:write",
  "skills:delete",
  "buckets:read",
  "buckets:write",
  "tokens:admin",
  "audit:read",
  "admin",
] as const

export const scopeSchema = z.enum(SCOPES)
export type Scope = z.infer<typeof scopeSchema>

export const problemSchema = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number().int(),
  code: z.string(),
  detail: z.string().optional(),
  requestId: z.string().optional(),
})
export type Problem = z.infer<typeof problemSchema>

export const fileEntrySchema = z.object({
  path: z.string(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  size: z.number().int().nonnegative(),
})
export type FileEntry = z.infer<typeof fileEntrySchema>

export const skillManifestSchema = z.object({
  name: z.string(),
  description: z.string(),
  version: z.string().optional(),
  contentHash: z.string(),
  files: z.array(fileEntrySchema),
})
export type SkillManifest = z.infer<typeof skillManifestSchema>

export const bucketManifestSchema = z.object({
  slug: z.string(),
  name: z.string(),
  revision: z.string(),
  skills: z.array(skillManifestSchema),
})
export type BucketManifest = z.infer<typeof bucketManifestSchema>

export const manifestV1Schema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  generatedAt: z.string(),
  buckets: z.array(bucketManifestSchema),
})
export type ManifestV1 = z.infer<typeof manifestV1Schema>

export const namePattern = /^[a-z0-9]+(-[a-z0-9]+)*$/
export const slugPattern = /^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$/

export const RESERVED_SKILL_NAMES = new Set(["customize-opencode", "opencode", "report"])

export function validateSkillName(name: string): string | null {
  if (name.length < 1 || name.length > LIMITS.maxNameLength) return "name must be 1..64 characters"
  if (!namePattern.test(name)) return "name must be lowercase alphanumeric with single hyphens"
  if (RESERVED_SKILL_NAMES.has(name)) return "name is reserved by opencode"
  return null
}

export function validateBucketSlug(slug: string): string | null {
  if (!slugPattern.test(slug)) return "slug must match ^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$"
  if (["api", "admin", "mcp", "health", "ready", "metrics", "static"].includes(slug)) return "slug is reserved"
  return null
}

export function normalizePathKey(path: string): string {
  return path.normalize("NFC").toLowerCase()
}

export function validateRelPath(path: string): string | null {
  if (!path) return "path is empty"
  if (path.length > LIMITS.maxPathLength) return "path is too long"
  if (path.startsWith("/")) return "absolute paths are not allowed"
  if (path.includes("\\")) return "backslashes are not allowed"
  if (path.includes("\0")) return "NUL is not allowed"
  if (/[\u0000-\u001f\u007f]/.test(path)) return "control characters are not allowed"
  const segments = path.split("/")
  if (segments.length > LIMITS.maxPathDepth) return "path is too deep"
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) return "invalid path segment"
  if (segments.some((segment) => segment.endsWith(".") || segment.endsWith(" "))) return "invalid path segment suffix"
  if (segments[0]?.toLowerCase() === "skill.md" && segments.length > 1) return "nested SKILL.md is not allowed"
  if (segments.slice(1).some((segment) => segment.toLowerCase() === "skill.md")) return "nested SKILL.md is not allowed"
  return null
}

export interface ParsedSkill {
  name: string
  description: string
  version?: string
  license?: string
  compatibility?: string
  metadata?: Record<string, string>
  body: string
}

export function parseSkillFrontmatter(content: string): { ok: true; skill: ParsedSkill } | { ok: false; error: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(content)
  if (!match) return { ok: false, error: "SKILL.md must start with YAML frontmatter" }
  let data: unknown
  try {
    data = parseYaml(match[1] ?? "", { maxAliasCount: 10 })
  } catch (error) {
    return { ok: false, error: `invalid YAML frontmatter: ${error instanceof Error ? error.message : String(error)}` }
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return { ok: false, error: "frontmatter must be a mapping" }
  const record = data as Record<string, unknown>
  if (typeof record.name !== "string") return { ok: false, error: "frontmatter.name is required" }
  if (typeof record.description !== "string" || record.description.length === 0) {
    return { ok: false, error: "frontmatter.description is required" }
  }
  if (record.description.length > LIMITS.maxDescriptionLength) return { ok: false, error: "description is too long" }
  const nameError = validateSkillName(record.name)
  if (nameError) return { ok: false, error: nameError }
  const optionalString = (key: string): string | undefined => {
    const value = record[key]
    if (value === undefined || value === null) return undefined
    if (typeof value !== "string") throw new Error(`frontmatter.${key} must be a string`)
    return value
  }
  try {
    const metadataRaw = record.metadata
    let metadata: Record<string, string> | undefined
    if (metadataRaw !== undefined) {
      if (!metadataRaw || typeof metadataRaw !== "object" || Array.isArray(metadataRaw)) {
        return { ok: false, error: "frontmatter.metadata must be a string-to-string map" }
      }
      metadata = {}
      for (const [key, value] of Object.entries(metadataRaw as Record<string, unknown>)) {
        if (typeof value !== "string") return { ok: false, error: "frontmatter.metadata must be a string-to-string map" }
        metadata[key] = value
      }
    }
    return {
      ok: true,
      skill: {
        name: record.name,
        description: record.description,
        version: optionalString("version"),
        license: optionalString("license"),
        compatibility: optionalString("compatibility"),
        metadata,
        body: content.slice(match[0].length),
      },
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export function validateSkillContent(
  content: string,
  expectedName: string,
): { ok: true; skill: ParsedSkill } | { ok: false; error: string } {
  const parsed = parseSkillFrontmatter(content)
  if (!parsed.ok) return parsed
  if (parsed.skill.name !== expectedName) return { ok: false, error: `frontmatter.name must equal "${expectedName}"` }
  return parsed
}

export function sha256(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex")
}

export function contentHash(files: readonly { path: string; sha256: string }[]): string {
  const lines = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)).map((file) => `${file.path}\0${file.sha256}\n`)
  return `sha256:${sha256(lines.join(""))}`
}

export function canonicalJson(value: unknown): string {
  const normalize = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(normalize)
    if (input && typeof input === "object") {
      const record = input as Record<string, unknown>
      const result: Record<string, unknown> = {}
      for (const key of Object.keys(record).sort()) result[key] = normalize(record[key])
      return result
    }
    return input
  }
  return JSON.stringify(normalize(value))
}

export function manifestEtag(manifest: Omit<ManifestV1, "generatedAt">): string {
  return `"m1-${sha256(canonicalJson(manifest))}"`
}

export function parseEnvRef(value: string): string | undefined {
  const match = /^\{env:([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(value)
  if (!match) return value
  return process.env[match[1] ?? ""]
}

export function hasScope(scopes: readonly string[], scope: Scope): boolean {
  return scopes.includes("admin") || scopes.includes(scope)
}

export function isAdmin(scopes: readonly string[]): boolean {
  return scopes.includes("admin")
}

export function problem(
  status: number,
  code: string,
  detail?: string,
  title = code,
): Problem {
  return {
    type: `https://skills-hub.dev/errors/${code.replaceAll("_", "-")}`,
    title,
    status,
    code,
    ...(detail ? { detail } : {}),
  }
}
