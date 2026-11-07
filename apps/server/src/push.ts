import type { ServerConfig } from "./config.js"
import { nowIso, type Db } from "./db.js"
import { repoDir, runGit } from "./git.js"

interface QueueRow {
  id: number
  bucket_id: number
  commit_sha: string
  attempts: number
  status: string
  next_attempt_at: string | null
  last_error: string | null
}

const inFlight = new Set<number>()

function backoffMs(attempts: number): number {
  const delays = [5_000, 30_000, 120_000, 600_000, 3_600_000, 86_400_000]
  return delays[Math.min(attempts, delays.length - 1)] ?? 86_400_000
}

function processQueue(config: ServerConfig, db: Db): void {
  if (!config.gitPushEnabled) return
  const rows = db
    .prepare(
      "SELECT q.*, b.slug, b.default_branch, b.remote_url FROM git_push_queue q JOIN buckets b ON b.id = q.bucket_id WHERE q.status = 'pending' AND (q.next_attempt_at IS NULL OR q.next_attempt_at <= ?) ORDER BY q.id LIMIT 20",
    )
    .all(nowIso()) as unknown as Array<QueueRow & { slug: string; default_branch: string; remote_url: string | null }>
  for (const row of rows) {
    if (!row.remote_url || inFlight.has(row.bucket_id)) continue
    inFlight.add(row.bucket_id)
    db.prepare("UPDATE git_push_queue SET status = 'pushing' WHERE id = ?").run(row.id)
    try {
      const result = runGit(config, repoDir(config, row.slug), ["push", "origin", `HEAD:refs/heads/${row.default_branch}`], {
        allowFailure: true,
      })
      if (result.status === 0) {
        db.prepare("UPDATE git_push_queue SET status = 'done' WHERE id = ?").run(row.id)
      } else {
        const attempts = row.attempts + 1
        const error = result.stderr.toString("utf8").trim().slice(0, 1000)
        if (attempts >= 20) {
          db.prepare("UPDATE git_push_queue SET status = 'failed', attempts = ?, next_attempt_at = NULL, last_error = ? WHERE id = ?").run(
            attempts,
            error,
            row.id,
          )
        } else {
          const next = new Date(Date.now() + backoffMs(attempts)).toISOString()
          db.prepare("UPDATE git_push_queue SET status = 'pending', attempts = ?, next_attempt_at = ?, last_error = ? WHERE id = ?").run(
            attempts,
            next,
            error,
            row.id,
          )
        }
      }
    } catch (error) {
      const attempts = row.attempts + 1
      db.prepare("UPDATE git_push_queue SET status = 'pending', attempts = ?, next_attempt_at = ?, last_error = ? WHERE id = ?").run(
        attempts,
        new Date(Date.now() + backoffMs(attempts)).toISOString(),
        error instanceof Error ? error.message : String(error),
        row.id,
      )
    } finally {
      inFlight.delete(row.bucket_id)
    }
  }
}

export function startPushWorker(config: ServerConfig, db: Db): () => void {
  if (!config.gitPushEnabled) return () => {}
  const timer = setInterval(() => {
    try {
      processQueue(config, db)
    } catch (error) {
      console.error(`[skills-hub] push worker: ${error instanceof Error ? error.message : String(error)}`)
    }
  }, 5_000)
  timer.unref()
  return () => clearInterval(timer)
}
