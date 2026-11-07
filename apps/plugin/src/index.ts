import path from "node:path"
import { Cache, type Logger } from "./cache.js"
import { loadConfig, type ResolvedConfig } from "./config.js"
import { sync } from "./sync.js"
import { v1PathAdapter, type OpenCodeConfig } from "./adapter.js"

interface PluginInput {
  directory?: string
  worktree?: string
}

const logger: Logger = (level, message, detail) => {
  const line = `[skills-hub] ${message}${detail ? `: ${detail instanceof Error ? detail.message : JSON.stringify(detail)}` : ""}`
  if (level === "warn" || process.env.SKILLS_HUB_DEBUG === "1") console.error(line)
}

function injectMcp(config: OpenCodeConfig, resolved: ResolvedConfig): void {
  if (!resolved.mcpToken || !resolved.apiUrl) return
  config.mcp ??= {}
  if (config.mcp[resolved.mcpName]) {
    logger("warn", `mcp.${resolved.mcpName} is already defined; leaving it untouched`)
    return
  }
  config.mcp[resolved.mcpName] = {
    type: "remote",
    url: `${resolved.apiUrl}/mcp`,
    headers: { Authorization: `Bearer ${resolved.mcpToken}` },
    enabled: true,
    timeout: 10_000,
  }
}

export async function configHook(input: PluginInput, options: Record<string, unknown> | undefined, config: OpenCodeConfig): Promise<void> {
  let resolved: ResolvedConfig
  try {
    resolved = loadConfig({ options, directory: input.directory ?? input.worktree ?? process.cwd() })
  } catch (error) {
    logger("warn", "invalid plugin configuration", error)
    return
  }
  if (!resolved.cacheRoot) {
    logger("warn", "apiUrl is not configured; skills-hub is disabled")
    return
  }
  const cache = new Cache(resolved.cacheRoot)
  cache.ensure()
  const previous = cache.activeSkillsDir()
  if (previous) v1PathAdapter.apply(config, previous)
  injectMcp(config, resolved)
  if (!resolved.apiUrl || !resolved.token) {
    logger("warn", "apiUrl or token is missing; using cache only")
    return
  }
  logger("debug", `sync start ${resolved.apiUrl} buckets=${resolved.effectiveBuckets?.join(",") ?? "*"}`)
  try {
    const result = await sync(resolved, cache, logger)
    if (result.status === "updated" && result.generation) {
      const next = path.join(result.generation, "skills")
      v1PathAdapter.apply(config, next, previous)
      logger("debug", `synced ${result.skills ?? 0} skills into ${result.generation}`)
    } else if (result.status === "skipped") {
      logger("warn", `sync skipped: ${result.error ?? "unknown error"}`)
    }
  } catch (error) {
    logger("warn", "sync failed; using cache", error)
  }
}

export default {
  id: "skills-hub",
  server: async (input: PluginInput, options?: Record<string, unknown>) => {
    return {
      config: async (config: OpenCodeConfig) => {
        await configHook(input, options, config)
      },
    }
  },
}

export const SkillsHubPlugin = async (input: PluginInput, options?: Record<string, unknown>) => {
  return {
    config: async (config: OpenCodeConfig) => {
      await configHook(input, options, config)
    },
  }
}
