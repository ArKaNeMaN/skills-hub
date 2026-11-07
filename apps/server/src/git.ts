import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import type { ServerConfig } from "./config.js"

export class GitError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message)
  }
}

export class RepoBusyError extends Error {}

export class PathSecurityError extends Error {}

export interface TreeEntry {
  mode: string
  type: string
  sha: string
  size: number
  path: string
}

function gitEnv(config: ServerConfig): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_AUTHOR_NAME: config.gitAuthorName,
    GIT_AUTHOR_EMAIL: config.gitAuthorEmail,
    GIT_COMMITTER_NAME: config.gitAuthorName,
    GIT_COMMITTER_EMAIL: config.gitAuthorEmail,
    GIT_TERMINAL_PROMPT: "0",
    GIT_ALLOW_PROTOCOL: "https",
  }
}

export function runGit(
  config: ServerConfig,
  repoDir: string,
  args: string[],
  options: { allowFailure?: boolean } = {},
): { stdout: Buffer; stderr: Buffer; status: number } {
  const result = spawnSync("git", ["-c", "protocol.ext.allow=never", "-c", "protocol.file.allow=never", ...args], {
    cwd: repoDir,
    env: gitEnv(config),
    encoding: "buffer",
    maxBuffer: 64 * 1024 * 1024,
    timeout: 60_000,
  })
  const status = result.status ?? 1
  const stderr = result.stderr ?? Buffer.alloc(0)
  if (status !== 0 && !options.allowFailure) {
    throw new GitError(`git ${args.join(" ")} failed: ${stderr.toString("utf8").trim()}`, status)
  }
  return { stdout: result.stdout ?? Buffer.alloc(0), stderr, status }
}

export function validateRemoteUrl(value: string): string | null {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return "remote URL is invalid"
  }
  if (url.username || url.password) return "credentials in remote URL are not allowed"
  if (url.protocol === "https:") return null
  if (url.protocol === "ssh:") return null
  return "only https:// and ssh:// remotes are allowed"
}

export function repoDir(config: ServerConfig, slug: string): string {
  return path.join(config.reposDir, slug)
}

export function bucketFile(repo: string): string {
  return path.join(repo, "bucket.json")
}

export interface BucketJson {
  schema: 1
  slug: string
  name: string
  description?: string
  createdAt: string
}

export function readBucketJson(repo: string): BucketJson | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(bucketFile(repo), "utf8")) as Partial<BucketJson>
    if (parsed.schema !== 1 || typeof parsed.slug !== "string" || typeof parsed.name !== "string") return undefined
    return {
      schema: 1,
      slug: parsed.slug,
      name: parsed.name,
      description: typeof parsed.description === "string" ? parsed.description : "",
      createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : new Date(0).toISOString(),
    }
  } catch {
    return undefined
  }
}

export function initBucketRepo(
  config: ServerConfig,
  slug: string,
  name: string,
  description = "",
  remoteUrl?: string,
): { repo: string; commit: string } {
  const repo = repoDir(config, slug)
  fs.mkdirSync(repo, { recursive: true, mode: 0o700 })
  if (fs.existsSync(path.join(repo, ".git"))) {
    const head = headCommit(config, repo)
    return { repo, commit: head }
  }
  runGit(config, repo, ["init", "-b", "main"])
  runGit(config, repo, ["config", "user.name", config.gitAuthorName])
  runGit(config, repo, ["config", "user.email", config.gitAuthorEmail])
  runGit(config, repo, ["config", "commit.gpgsign", "false"])
  if (remoteUrl) {
    const error = validateRemoteUrl(remoteUrl)
    if (error) throw new Error(error)
    runGit(config, repo, ["remote", "add", "origin", remoteUrl])
  }
  const data: BucketJson = { schema: 1, slug, name, description, createdAt: new Date().toISOString() }
  fs.writeFileSync(bucketFile(repo), `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 })
  runGit(config, repo, ["add", "--", "bucket.json"])
  runGit(config, repo, ["commit", "--no-verify", "-m", `bucket: init ${slug}`])
  return { repo, commit: headCommit(config, repo) }
}

export function headCommit(config: ServerConfig, repo: string): string {
  return runGit(config, repo, ["rev-parse", "--verify", "HEAD"]).stdout.toString("utf8").trim()
}

export function defaultBranch(config: ServerConfig, repo: string): string {
  const result = runGit(config, repo, ["symbolic-ref", "--short", "HEAD"], { allowFailure: true })
  return result.status === 0 ? result.stdout.toString("utf8").trim() : "main"
}

export function statusPorcelain(config: ServerConfig, repo: string, paths: string[] = ["skills", "bucket.json"]): string {
  return runGit(config, repo, ["status", "--porcelain", "--", ...paths]).stdout.toString("utf8").trim()
}

export function listTree(config: ServerConfig, repo: string, commit = "HEAD"): TreeEntry[] {
  const out = runGit(config, repo, ["ls-tree", "-r", "-z", "--long", commit]).stdout
  const text = out.toString("utf8")
  const entries: TreeEntry[] = []
  for (const raw of text.split("\0")) {
    if (!raw) continue
    const tab = raw.indexOf("\t")
    if (tab < 0) continue
    const meta = raw.slice(0, tab).split(" ")
    const filePath = raw.slice(tab + 1)
    if (meta.length < 4) continue
    const [mode, type, sha, size] = meta
    if (!mode || !type || !sha || size === undefined) continue
    entries.push({ mode, type, sha, size: Number.parseInt(size, 10) || 0, path: filePath })
  }
  return entries
}

export function readBlob(config: ServerConfig, repo: string, sha: string): Buffer {
  return runGit(config, repo, ["cat-file", "-p", sha]).stdout
}

export function writeFileAtomic(target: string, content: string | Buffer): void {
  const dir = path.dirname(target)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const temp = path.join(dir, `.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`)
  fs.writeFileSync(temp, content, { mode: 0o600, flag: "wx" })
  fs.renameSync(temp, target)
}

export function commitPaths(config: ServerConfig, repo: string, paths: string[], message: string): string {
  runGit(config, repo, ["add", "--", ...paths])
  const status = runGit(config, repo, ["status", "--porcelain", "--", ...paths]).stdout.toString("utf8").trim()
  if (!status) return headCommit(config, repo)
  runGit(config, repo, ["commit", "--no-verify", "-m", message])
  return headCommit(config, repo)
}

export function removePaths(config: ServerConfig, repo: string, paths: string[], message: string): string {
  runGit(config, repo, ["rm", "-r", "--ignore-unmatch", "--", ...paths])
  const status = runGit(config, repo, ["status", "--porcelain", "--", ...paths]).stdout.toString("utf8").trim()
  if (!status) return headCommit(config, repo)
  runGit(config, repo, ["commit", "--no-verify", "-m", message])
  return headCommit(config, repo)
}

export function withBucketLock<T>(config: ServerConfig, slug: string, fn: () => T): T {
  fs.mkdirSync(config.locksDir, { recursive: true, mode: 0o700 })
  const lockPath = path.join(config.locksDir, `${slug}.lock`)
  const acquire = (): number => {
    try {
      return fs.openSync(lockPath, "wx", 0o600)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== "EEXIST") throw error
      try {
        const stat = fs.statSync(lockPath)
        if (Date.now() - stat.mtimeMs > 5 * 60 * 1000) {
          fs.unlinkSync(lockPath)
          return fs.openSync(lockPath, "wx", 0o600)
        }
      } catch {
        // retry below
      }
      throw new RepoBusyError(`bucket ${slug} is busy`)
    }
  }
  const fd = acquire()
  try {
    fs.writeSync(fd, `${process.pid} ${new Date().toISOString()}\n`)
    return fn()
  } finally {
    try {
      fs.closeSync(fd)
    } catch {
      // ignore
    }
    try {
      fs.unlinkSync(lockPath)
    } catch {
      // ignore
    }
  }
}

export function assertInside(root: string, candidate: string): void {
  const rootReal = fs.realpathSync(root)
  const parent = path.dirname(candidate)
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 })
  const parentReal = fs.realpathSync(parent)
  if (parentReal !== rootReal && !parentReal.startsWith(`${rootReal}${path.sep}`)) {
    throw new PathSecurityError("path escapes repository")
  }
}

export function assertNoSymlinkComponents(root: string, relative: string): void {
  const segments = relative.split("/")
  let current = root
  for (const segment of segments) {
    current = path.join(current, segment)
    try {
      const stat = fs.lstatSync(current)
      if (stat.isSymbolicLink()) throw new PathSecurityError("symlink component is not allowed")
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return
      throw error
    }
  }
}
