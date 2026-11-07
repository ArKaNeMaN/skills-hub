import fs from "node:fs"
import path from "node:path"
import { ensureDataDirs, loadConfig } from "./config.js"
import { openDatabase } from "./db.js"
import { createToken } from "./auth.js"
import { reindexAll } from "./indexer.js"
import { createBucket } from "./indexer.js"
import { putSkillFile } from "./write.js"
import type { Principal } from "./auth.js"
import type { Scope } from "@skills-hub/protocol"

function usage(): never {
  console.error(`usage:
  skills-hub bucket add <slug> <name> [description]
  skills-hub token create <label> --scopes <a,b> --buckets <x,y> [--days N] [--all-buckets]
  skills-hub skill put-file <bucket> <name> <path> <file>
  skills-hub reindex`)
  process.exit(2)
}

function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}

function has(args: string[], name: string): boolean {
  return args.includes(name)
}

function adminPrincipal(): Principal {
  return { kind: "admin", id: "cli", scopes: ["admin"], bucketIds: new Set(), allBuckets: true }
}

function main(): void {
  const config = loadConfig()
  ensureDataDirs(config)
  const db = openDatabase(config)
  const [command, subcommand, ...rest] = process.argv.slice(2)
  try {
    if (command === "bucket" && subcommand === "add") {
      const [slug, name, description] = rest
      if (!slug || !name) usage()
      const result = createBucket(config, db, { slug, name, description: description ?? "" })
      console.log(JSON.stringify(result, null, 2))
      return
    }
    if (command === "token" && subcommand === "create") {
      const [label] = rest
      const scopes = (flag(rest, "--scopes") ?? "skills:read,buckets:read").split(",").filter(Boolean) as Scope[]
      const buckets = (flag(rest, "--buckets") ?? "").split(",").filter(Boolean)
      const days = Number.parseInt(flag(rest, "--days") ?? "0", 10)
      if (!label) usage()
      if (!has(rest, "--all-buckets") && buckets.length === 0) {
        throw new Error("--buckets is required unless --all-buckets is set")
      }
      const created = createToken(db, {
        label,
        scopes,
        buckets,
        allBuckets: has(rest, "--all-buckets"),
        ...(days > 0 ? { expiresInDays: days } : {}),
      })
      console.log(JSON.stringify({ id: created.id, token: created.token }, null, 2))
      return
    }
    if (command === "skill" && subcommand === "put-file") {
      const [bucket, name, filePath, source] = rest
      if (!bucket || !name || !filePath || !source) usage()
      const content = fs.readFileSync(path.resolve(source), "utf8")
      const result = putSkillFile(config, db, adminPrincipal(), { bucket, name, path: filePath, content })
      console.log(JSON.stringify(result, null, 2))
      return
    }
    if (command === "reindex") {
      console.log(JSON.stringify(reindexAll(config, db), null, 2))
      return
    }
    usage()
  } finally {
    db.close()
  }
}

try {
  main()
} catch (error) {
  console.error(`[skills-hub] ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
