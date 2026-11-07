import { Cache, type Logger } from "./cache.js"
import { loadConfig } from "./config.js"
import { sync } from "./sync.js"

const logger: Logger = (level, message, detail) => {
  const line = `[skills-hub] ${message}${detail ? `: ${detail instanceof Error ? detail.message : String(detail)}` : ""}`
  if (level === "warn") console.warn(line)
  else console.debug(line)
}

function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  if (args[0] !== "sync") {
    console.error("usage: skills-hub sync [--api-url URL] [--token TOKEN] [--buckets a,b] [--cache-dir DIR]")
    process.exit(2)
  }
  const config = loadConfig({
    directory: process.cwd(),
    options: {
      ...(flag(args, "--api-url") ? { apiUrl: flag(args, "--api-url") } : {}),
      ...(flag(args, "--token") ? { token: flag(args, "--token") } : {}),
      ...(flag(args, "--buckets") ? { buckets: flag(args, "--buckets")?.split(",").filter(Boolean) } : {}),
      ...(flag(args, "--cache-dir") ? { cacheDir: flag(args, "--cache-dir") } : {}),
    },
  })
  if (!config.cacheRoot) throw new Error("apiUrl or cacheDir is required")
  const cache = new Cache(config.cacheRoot)
  cache.ensure()
  const result = await sync(config, cache, logger)
  console.log(JSON.stringify(result, null, 2))
}

main().catch((error) => {
  console.error(`[skills-hub] ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
