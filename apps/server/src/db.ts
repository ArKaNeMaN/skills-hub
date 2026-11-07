import fs from "node:fs"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import type { ServerConfig } from "./config.js"

export type Db = DatabaseSync

const MIGRATION_PATH = new URL("./migrations/0001_init.sql", import.meta.url)

export function openDatabase(config: ServerConfig): Db {
  fs.mkdirSync(path.dirname(config.dbPath), { recursive: true, mode: 0o700 })
  const db = new DatabaseSync(config.dbPath)
  db.exec("PRAGMA journal_mode=WAL")
  db.exec("PRAGMA foreign_keys=ON")
  db.exec("PRAGMA busy_timeout=5000")
  db.exec("PRAGMA synchronous=NORMAL")
  const version = (db.prepare("PRAGMA user_version").get() as { user_version?: number } | undefined)?.user_version ?? 0
  if (version < 1) {
    const sql = fs.readFileSync(MIGRATION_PATH, "utf8")
    db.exec(sql)
    db.exec("PRAGMA user_version = 1")
  }
  return db
}

export function nowIso(): string {
  return new Date().toISOString()
}

export function transaction<T>(db: Db, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE")
  try {
    const result = fn()
    db.exec("COMMIT")
    return result
  } catch (error) {
    try {
      db.exec("ROLLBACK")
    } catch {
      // ignore rollback failure; original error wins
    }
    throw error
  }
}

export function getMeta(db: Db, key: string): string | undefined {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value?: string } | undefined
  return row?.value
}

export function setMeta(db: Db, key: string, value: string): void {
  db.prepare("INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(
    key,
    value,
  )
}
