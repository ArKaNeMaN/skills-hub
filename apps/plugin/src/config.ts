import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

export interface SkillsHubOptions {
  apiUrl?: string
  token?: string
  buckets?: string[]
  bucketsAdd?: string[]
  timeoutMs?: number
  connectTimeoutMs?: number
  firstSyncTimeoutMs?: number
  cacheDir?: string
  mcpToken?: string
  mcpName?: string
  verifyHashes?: boolean
  caFile?: string
}

export interface ResolvedConfig {
  apiUrl?: string
  token?: string
  buckets?: string[]
  bucketsAdd: string[]
  timeoutMs: number
  connectTimeoutMs: number
  firstSyncTimeoutMs: number
  cacheDir?: string
  mcpToken?: string
  mcpName: string
  verifyHashes: boolean
  caFile?: string
  effectiveBuckets?: string[]
  bucketSignature: string
  cacheRoot?: string
}

export const DEFAULTS: SkillsHubOptions = {
  timeoutMs: 1500,
  connectTimeoutMs: 1500,
  firstSyncTimeoutMs: 15_000,
  mcpName: "skills-hub",
  verifyHashes: true,
}

function readJson(file: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.filter((item): item is string => typeof item === "string")
}

function merge(base: SkillsHubOptions, override: Record<string, unknown>): SkillsHubOptions {
  const result: SkillsHubOptions = { ...base }
  if (typeof override.apiUrl === "string") result.apiUrl = override.apiUrl
  if (typeof override.token === "string") result.token = override.token
  if (typeof override.mcpToken === "string") result.mcpToken = override.mcpToken
  if (typeof override.mcpName === "string") result.mcpName = override.mcpName
  if (typeof override.cacheDir === "string") result.cacheDir = override.cacheDir
  if (typeof override.caFile === "string") result.caFile = override.caFile
  if (typeof override.verifyHashes === "boolean") result.verifyHashes = override.verifyHashes
  for (const key of ["timeoutMs", "connectTimeoutMs", "firstSyncTimeoutMs"] as const) {
    const value = override[key]
    if (typeof value === "number" && Number.isFinite(value) && value > 0) result[key] = value
  }
  const buckets = asStringArray(override.buckets)
  if (buckets) result.buckets = buckets
  const bucketsAdd = asStringArray(override.bucketsAdd)
  if (bucketsAdd) result.bucketsAdd = [...(result.bucketsAdd ?? []), ...bucketsAdd]
  return result
}

function envValue(value: string | undefined): string | undefined {
  if (!value) return undefined
  const match = /^\{env:([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(value)
  if (!match) return value
  return process.env[match[1] ?? ""]
}

export function loadConfig(input: {
  options?: Record<string, unknown>
  directory?: string
  home?: string
}): ResolvedConfig {
  const home = input.home ?? process.env.HOME ?? os.homedir()
  const globalFile = path.join(home, ".config", "opencode", "skills-hub.json")
  const projectDir = input.directory ?? process.cwd()
  const projectFile = path.join(projectDir, ".opencode", "skills-hub.json")
  let merged: SkillsHubOptions = { ...DEFAULTS }
  merged = merge(merged, readJson(globalFile) ?? {})
  merged = merge(merged, input.options ?? {})
  merged = merge(merged, readJson(projectFile) ?? {})

  const token = envValue(merged.token) ?? process.env.SKILLS_HUB_TOKEN
  const mcpToken = envValue(merged.mcpToken) ?? process.env.SKILLS_HUB_MCP_TOKEN
  const mcpName = merged.mcpName && /^[a-z0-9-]+$/.test(merged.mcpName) ? merged.mcpName : "skills-hub"
  if (["__proto__", "constructor", "prototype"].includes(mcpName)) throw new Error("invalid mcpName")
  const buckets = merged.buckets?.filter(Boolean)
  const bucketsAdd = (merged.bucketsAdd ?? []).filter(Boolean)
  const effectiveBuckets = buckets ? [...new Set([...buckets, ...bucketsAdd])] : undefined
  const bucketSignature = effectiveBuckets && effectiveBuckets.length ? effectiveBuckets.join(",") : "*"
  const apiUrl = merged.apiUrl?.replace(/\/+$/, "")
  const cacheRoot =
    merged.cacheDir ??
    (apiUrl
      ? path.join(
          process.env.SKILLS_HUB_CACHE_DIR ?? path.join(home, ".cache", "opencode", "skills-hub"),
          crypto.createHash("sha256").update(`${apiUrl}\0${bucketSignature}`).digest("hex").slice(0, 12),
        )
      : undefined)
  return {
    ...(apiUrl ? { apiUrl } : {}),
    ...(token ? { token } : {}),
    ...(buckets ? { buckets } : {}),
    bucketsAdd,
    timeoutMs: merged.timeoutMs ?? DEFAULTS.timeoutMs ?? 1500,
    connectTimeoutMs: merged.connectTimeoutMs ?? DEFAULTS.connectTimeoutMs ?? 1500,
    firstSyncTimeoutMs: merged.firstSyncTimeoutMs ?? DEFAULTS.firstSyncTimeoutMs ?? 15_000,
    ...(cacheRoot ? { cacheDir: cacheRoot } : {}),
    ...(mcpToken ? { mcpToken } : {}),
    mcpName,
    verifyHashes: merged.verifyHashes ?? true,
    ...(merged.caFile ? { caFile: merged.caFile } : {}),
    ...(effectiveBuckets ? { effectiveBuckets } : {}),
    bucketSignature,
    cacheRoot,
  }
}
