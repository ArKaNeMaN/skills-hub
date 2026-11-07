import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { LIMITS } from "@skills-hub/protocol"

export interface ServerConfig {
  host: string
  port: number
  publicUrl?: string
  trustProxy: boolean
  requireTls: boolean
  dataDir: string
  dbPath: string
  reposDir: string
  trashDir: string
  locksDir: string
  adminToken?: string
  adminBootstrapFile: string
  sessionTtlHours: number
  gitAuthorName: string
  gitAuthorEmail: string
  gitPushEnabled: boolean
  limits: typeof LIMITS
  maxManifestBytes: number
  maxManifestSkills: number
  maxManifestFiles: number
  reservedSkillNames: string[]
}

function int(value: string | undefined, fallback: number): number {
  const parsed = value === undefined ? NaN : Number.parseInt(value, 10)
  return Number.isFinite(parsed) ? parsed : fallback
}

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback
  return value === "1" || value.toLowerCase() === "true" || value.toLowerCase() === "yes"
}

export function loadConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  const dataDir = overrides.dataDir ?? process.env.DATA_DIR ?? path.join(process.cwd(), "data")
  const config: ServerConfig = {
    host: overrides.host ?? process.env.HOST ?? "127.0.0.1",
    port: overrides.port ?? int(process.env.PORT, 8787),
    publicUrl: overrides.publicUrl ?? process.env.PUBLIC_URL,
    trustProxy: overrides.trustProxy ?? bool(process.env.TRUST_PROXY, false),
    requireTls:
      overrides.requireTls ??
      bool(process.env.REQUIRE_TLS, process.env.NODE_ENV === "production"),
    dataDir,
    dbPath: overrides.dbPath ?? path.join(dataDir, "hub.db"),
    reposDir: overrides.reposDir ?? path.join(dataDir, "repos"),
    trashDir: overrides.trashDir ?? path.join(dataDir, "trash"),
    locksDir: overrides.locksDir ?? path.join(dataDir, "locks"),
    adminToken: overrides.adminToken ?? process.env.SKILLS_HUB_ADMIN_TOKEN,
    adminBootstrapFile:
      overrides.adminBootstrapFile ?? process.env.ADMIN_BOOTSTRAP_FILE ?? path.join(dataDir, "admin-token"),
    sessionTtlHours: overrides.sessionTtlHours ?? int(process.env.SESSION_TTL_HOURS, 12),
    gitAuthorName: overrides.gitAuthorName ?? process.env.GIT_AUTHOR_NAME ?? "skills-hub",
    gitAuthorEmail: overrides.gitAuthorEmail ?? process.env.GIT_AUTHOR_EMAIL ?? "hub@skills-hub.local",
    gitPushEnabled: overrides.gitPushEnabled ?? bool(process.env.GIT_PUSH_ENABLED, true),
    limits: overrides.limits ?? LIMITS,
    maxManifestBytes: overrides.maxManifestBytes ?? int(process.env.MAX_MANIFEST_BYTES, LIMITS.maxManifestBytes),
    maxManifestSkills: overrides.maxManifestSkills ?? int(process.env.MAX_MANIFEST_SKILLS, LIMITS.maxSkills),
    maxManifestFiles: overrides.maxManifestFiles ?? int(process.env.MAX_MANIFEST_FILES, LIMITS.maxFiles),
    reservedSkillNames: overrides.reservedSkillNames ?? (process.env.RESERVED_SKILL_NAMES ?? "").split(",").filter(Boolean),
  }
  if (config.requireTls && config.publicUrl && !config.publicUrl.startsWith("https://")) {
    throw new Error("REQUIRE_TLS is enabled but PUBLIC_URL is not https")
  }
  return config
}

export function ensureDataDirs(config: ServerConfig): void {
  for (const dir of [config.dataDir, config.reposDir, config.trashDir, config.locksDir]) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  }
}

export function homeDir(): string {
  return process.env.HOME ?? os.homedir()
}
