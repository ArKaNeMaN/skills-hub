import { cp, mkdir, rm } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const source = path.join(packageDir, "src", "migrations")
const target = path.join(packageDir, "dist", "migrations")

// tsup's clean removes dist; remove the target too so repeated copies never
// leave stale migration files behind.
await rm(target, { recursive: true, force: true })
await mkdir(path.dirname(target), { recursive: true })
await cp(source, target, { recursive: true })
