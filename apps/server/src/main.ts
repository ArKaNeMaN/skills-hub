import { ensureDataDirs, loadConfig } from "./config.js"
import { openDatabase } from "./db.js"
import { createApp } from "./http.js"
import { reindexAll } from "./indexer.js"
import { startPushWorker } from "./push.js"

async function main(): Promise<void> {
  const config = loadConfig()
  if (!config.adminToken) {
    throw new Error("SKILLS_HUB_ADMIN_TOKEN is required")
  }
  ensureDataDirs(config)
  const db = openDatabase(config)
  const results = reindexAll(config, db)
  for (const result of results) {
    if (result.error) console.error(`[skills-hub] reindex ${result.bucket}: ${result.error}`)
  }
  const app = await createApp({ config, db })
  const stopPush = startPushWorker(config, db)
  const close = async () => {
    stopPush()
    await app.close()
    db.close()
  }
  process.once("SIGINT", () => void close().then(() => process.exit(0)))
  process.once("SIGTERM", () => void close().then(() => process.exit(0)))
  await app.listen({ host: config.host, port: config.port })
  console.error(`[skills-hub] listening on http://${config.host}:${config.port}`)
}

main().catch((error) => {
  console.error(`[skills-hub] fatal: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
