import http from "node:http"
import https from "node:https"
import fs from "node:fs"
import {
  LIMITS,
  manifestV1Schema,
  type ManifestV1,
  type SkillManifest,
} from "@skills-hub/protocol"
import type { Cache, Logger } from "./cache.js"
import type { ResolvedConfig } from "./config.js"

export class HttpStatusError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message?: string,
  ) {
    super(message ?? code)
  }
}

interface RequestOptions {
  headers?: Record<string, string>
  connectMs: number
  totalMs: number
  caFile?: string
}

type ResponseHeaders = http.IncomingHttpHeaders

function headerValue(headers: ResponseHeaders, name: string): string | undefined {
  const value = headers[name]
  return Array.isArray(value) ? value[0] : value
}

async function requestBuffer(url: string, options: RequestOptions): Promise<{ status: number; headers: ResponseHeaders; body: Buffer }> {
  return await new Promise((resolve, reject) => {
    const parsed = new URL(url)
    const transport = parsed.protocol === "https:" ? https : http
    const ca = options.caFile ? fs.readFileSync(options.caFile) : undefined
    const request = transport.request(
      parsed,
      { method: "GET", headers: options.headers, ...(ca ? { ca } : {}) },
      (response) => {
        const chunks: Buffer[] = []
        response.on("data", (chunk: Buffer) => chunks.push(chunk))
        response.on("error", reject)
        response.on("end", () => {
          const body = Buffer.concat(chunks)
          const status = response.statusCode ?? 0
          if (status === 304) {
            resolve({ status, headers: response.headers, body })
            return
          }
          if (status < 200 || status >= 300) {
            let code = "http_error"
            let detail = ""
            try {
              const parsedBody = JSON.parse(body.toString("utf8")) as { code?: string; detail?: string; title?: string }
              code = parsedBody.code ?? code
              detail = parsedBody.detail ?? parsedBody.title ?? ""
            } catch {
              detail = body.toString("utf8").slice(0, 300)
            }
            reject(new HttpStatusError(status, code, detail))
            return
          }
          resolve({ status, headers: response.headers, body })
        })
      },
    )
    request.setTimeout(options.connectMs, () => request.destroy(new Error("request timed out")))
    request.on("error", (error) => reject(new Error(`request failed: ${error.message}`)))
    request.end()
  })
}

function baseHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
    "User-Agent": "skills-hub-opencode-plugin/0.0.2",
  }
}

function manifestUrl(config: ResolvedConfig, buckets: string[] | undefined): string {
  const base = `${config.apiUrl}/api/v1/manifest`
  if (!buckets || buckets.length === 0) return base
  return `${base}?buckets=${encodeURIComponent(buckets.join(","))}`
}

function fileUrl(config: ResolvedConfig, bucket: string, skill: string, file: string): string {
  const encoded = file
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/")
  return `${config.apiUrl}/api/v1/skills/${encodeURIComponent(bucket)}/${encodeURIComponent(skill)}/files/${encoded}`
}

async function fetchBuckets(config: ResolvedConfig, token: string, logger: Logger): Promise<string[]> {
  const response = await requestBuffer(`${config.apiUrl}/api/v1/buckets`, {
    headers: baseHeaders(token),
    connectMs: config.connectTimeoutMs,
    totalMs: config.timeoutMs,
  })
  const parsed = JSON.parse(response.body.toString("utf8")) as { buckets?: Array<{ slug?: string }> }
  const slugs = (parsed.buckets ?? []).map((bucket) => bucket.slug).filter((slug): slug is string => typeof slug === "string")
  logger("debug", `reconciled buckets: ${slugs.join(",") || "none"}`)
  return slugs
}

export interface SyncResult {
  status: "not-modified" | "updated" | "skipped"
  generation?: string
  manifest?: ManifestV1
  skills?: number
  error?: string
}

function validateManifest(manifest: ManifestV1): void {
  let skills = 0
  let files = 0
  for (const bucket of manifest.buckets) {
    skills += bucket.skills.length
    for (const skill of bucket.skills) {
      files += skill.files.length
      if (skill.files.length > LIMITS.maxFilesPerSkill) throw new Error(`too many files in ${bucket.slug}/${skill.name}`)
      for (const file of skill.files) {
        if (file.size > LIMITS.maxFileBytes) throw new Error(`file too large: ${file.path}`)
      }
    }
  }
  if (skills > LIMITS.maxSkills || files > LIMITS.maxFiles) throw new Error("manifest exceeds limits")
}

export async function sync(
  config: ResolvedConfig,
  cache: Cache,
  logger: Logger,
): Promise<SyncResult> {
  if (!config.apiUrl || !config.token) return { status: "skipped", error: "apiUrl or token is missing" }
  const active = cache.readManifest()
  const isFirstRun = !cache.activeGeneration()
  const totalMs = isFirstRun ? config.firstSyncTimeoutMs : config.timeoutMs
  let buckets = config.effectiveBuckets
  try {
    let response = await requestBuffer(manifestUrl(config, buckets), {
      headers: {
        ...baseHeaders(config.token),
        ...(active?.etag ? { "If-None-Match": active.etag } : {}),
      },
      connectMs: config.connectTimeoutMs,
      totalMs,
      caFile: config.caFile,
    })
    if (response.status === 304) return { status: "not-modified", generation: cache.activeGeneration() }
    let manifest = manifestV1Schema.parse(JSON.parse(response.body.toString("utf8"))) as ManifestV1
    validateManifest(manifest)
    if (buckets && buckets.length) {
      // Explicit bucket list: a 403 is handled by the request layer below.
    }
    const etag = headerValue(response.headers, "etag")
    if (!etag) throw new Error("manifest response has no ETag")
    const fetchFile = async (bucket: string, skill: string, file: string): Promise<Buffer> => {
      const result = await requestBuffer(fileUrl(config, bucket, skill, file), {
        headers: baseHeaders(config.token as string),
        connectMs: config.connectTimeoutMs,
        totalMs: config.timeoutMs,
        caFile: config.caFile,
      })
      return result.body
    }
    const generation = await cache.build(manifest, etag, buckets, fetchFile, config.verifyHashes, logger)
    return { status: "updated", generation, manifest, skills: Object.keys(cache.readManaged().skills).length }
  } catch (error) {
    if (error instanceof HttpStatusError && error.status === 403 && error.code === "bucket_forbidden" && buckets?.length) {
      try {
        const allowed = await fetchBuckets(config, config.token, logger)
        const effective = buckets.filter((bucket) => allowed.includes(bucket))
        if (effective.length === 0) return { status: "skipped", error: "no accessible buckets" }
        logger("warn", `some buckets are inaccessible; syncing ${effective.join(",")}`)
        const retry = await requestBuffer(manifestUrl(config, effective), {
          headers: {
            ...baseHeaders(config.token),
            ...(active?.etag ? { "If-None-Match": active.etag } : {}),
          },
          connectMs: config.connectTimeoutMs,
          totalMs,
          caFile: config.caFile,
        })
        if (retry.status === 304) return { status: "not-modified", generation: cache.activeGeneration() }
        const manifest = manifestV1Schema.parse(JSON.parse(retry.body.toString("utf8"))) as ManifestV1
        validateManifest(manifest)
        const etag = headerValue(retry.headers, "etag")
        if (!etag) throw new Error("manifest response has no ETag")
        const fetchFile = async (bucket: string, skill: string, file: string): Promise<Buffer> => {
          const result = await requestBuffer(fileUrl(config, bucket, skill, file), {
            headers: baseHeaders(config.token as string),
            connectMs: config.connectTimeoutMs,
            totalMs: config.timeoutMs,
          })
          return result.body
        }
        const generation = await cache.build(manifest, etag, effective, fetchFile, config.verifyHashes, logger)
        return { status: "updated", generation, manifest, skills: Object.keys(cache.readManaged().skills).length }
      } catch (retryError) {
        return { status: "skipped", error: retryError instanceof Error ? retryError.message : String(retryError) }
      }
    }
    return { status: "skipped", error: error instanceof Error ? error.message : String(error) }
  }
}

export function manifestSkills(manifest: ManifestV1): Array<{ bucket: string; skill: SkillManifest }> {
  return manifest.buckets.flatMap((bucket) => bucket.skills.map((skill) => ({ bucket: bucket.slug, skill })))
}
