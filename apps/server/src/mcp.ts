import { randomUUID } from "node:crypto"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js"
import { z } from "zod"
import { hasScope } from "@skills-hub/protocol"
import type { FastifyReply, FastifyRequest } from "fastify"
import type { AppContext } from "./http.js"
import { AuthError, type Principal } from "./auth.js"
import { HttpError } from "./errors.js"
import { audit, allowedBuckets, getFileContent, getSkill, listBuckets } from "./services.js"
import { deleteSkill, deleteSkillFile, putSkillFile } from "./write.js"

interface McpSession {
  server: McpServer
  transport: StreamableHTTPServerTransport
  principalId: string
  lastActive: number
}

const sessions = new Map<string, McpSession>()

function textResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }] }
}

function errorResult(error: unknown) {
  const code = error instanceof AuthError || error instanceof HttpError ? error.code : "internal"
  const message = error instanceof Error ? error.message : String(error)
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ error: code, detail: message }) }],
    isError: true,
  }
}

function actor(principal: Principal) {
  return principal.kind === "token" ? principal.id : principal.sessionId ?? principal.id
}

function buildServer(context: AppContext, principal: Principal): McpServer {
  const server = new McpServer({ name: "skills-hub", version: "0.0.4" })

  if (hasScope(principal.scopes, "buckets:read")) {
    server.registerTool(
      "list_buckets",
      { description: "List buckets available to this token", inputSchema: {} },
      async () => {
        try {
          return textResult({ buckets: listBuckets(context.db, principal) })
        } catch (error) {
          return errorResult(error)
        }
      },
    )
  }

  if (hasScope(principal.scopes, "skills:read")) {
    server.registerTool(
      "list_skills",
      {
        description: "List skills in an accessible bucket",
        inputSchema: { bucket: z.string().optional() },
      },
      async (args) => {
        try {
          const requested = (args as { bucket?: string }).bucket
          const buckets = requested
            ? allowedBuckets(context.db, principal).filter((bucket) => bucket.slug === requested)
            : allowedBuckets(context.db, principal)
          if (requested && buckets.length === 0) throw new AuthError(403, "bucket_forbidden")
          return textResult({
            skills: buckets.flatMap((bucket) => {
              const rows = context.db
                .prepare(
                  "SELECT name, description, version, updated_at AS updatedAt FROM skills WHERE bucket_id = ? ORDER BY name",
                )
                .all(bucket.id) as unknown as Array<{
                name: string
                description: string
                version: string | null
                updatedAt: string
              }>
              return rows.map((skill) => ({ bucket: bucket.slug, ...skill }))
            }),
          })
        } catch (error) {
          return errorResult(error)
        }
      },
    )

    server.registerTool(
      "get_skill",
      {
        description: "Read a skill and its text files",
        inputSchema: { bucket: z.string(), name: z.string(), includeContent: z.boolean().optional() },
      },
      async (args) => {
        try {
          const input = args as { bucket: string; name: string; includeContent?: boolean }
          const { bucket, skill, files } = getSkill(context.db, principal, input.bucket, input.name)
          const result = files.map((file) => {
            const content =
              input.includeContent === false
                ? undefined
                : getFileContent(context.config, context.db, principal, input.bucket, input.name, file.path).content.toString(
                    "utf8",
                  )
            return { path: file.path, sha256: file.sha256, size: file.size, ...(content !== undefined ? { content } : {}) }
          })
          return textResult({
            bucket: bucket.slug,
            name: skill.name,
            description: skill.description,
            version: skill.version,
            revision: (bucket.head_commit ?? "").slice(0, 12),
            files: result,
          })
        } catch (error) {
          return errorResult(error)
        }
      },
    )
  }

  if (hasScope(principal.scopes, "skills:write")) {
    server.registerTool(
      "put_skill_file",
      {
        description: "Create or replace one text file in a skill; one call = one git commit",
        inputSchema: {
          bucket: z.string(),
          name: z.string(),
          path: z.string(),
          content: z.string(),
          message: z.string().optional(),
        },
      },
      async (args) => {
        try {
          const input = args as { bucket: string; name: string; path: string; content: string; message?: string }
          const result = putSkillFile(context.config, context.db, principal, input)
          audit(context.db, {
            actorType: principal.kind,
            actorId: actor(principal),
            action: "mcp.skill.file.write",
            bucketSlug: input.bucket,
            skillName: input.name,
            result: "ok",
            detail: input.path,
          })
          return textResult(result)
        } catch (error) {
          return errorResult(error)
        }
      },
    )
  }

  if (hasScope(principal.scopes, "skills:delete")) {
    server.registerTool(
      "delete_skill_file",
      {
        description: "Delete one file from a skill; SKILL.md cannot be deleted this way",
        inputSchema: { bucket: z.string(), name: z.string(), path: z.string(), message: z.string().optional() },
      },
      async (args) => {
        try {
          const input = args as { bucket: string; name: string; path: string; message?: string }
          const result = deleteSkillFile(context.config, context.db, principal, input)
          audit(context.db, {
            actorType: principal.kind,
            actorId: actor(principal),
            action: "mcp.skill.file.delete",
            bucketSlug: input.bucket,
            skillName: input.name,
            result: "ok",
            detail: input.path,
          })
          return textResult(result)
        } catch (error) {
          return errorResult(error)
        }
      },
    )

    server.registerTool(
      "delete_skill",
      {
        description: "Delete a skill and all its files",
        inputSchema: { bucket: z.string(), name: z.string(), message: z.string().optional() },
      },
      async (args) => {
        try {
          const input = args as { bucket: string; name: string; message?: string }
          const result = deleteSkill(context.config, context.db, principal, input)
          audit(context.db, {
            actorType: principal.kind,
            actorId: actor(principal),
            action: "mcp.skill.delete",
            bucketSlug: input.bucket,
            skillName: input.name,
            result: "ok",
          })
          return textResult(result)
        } catch (error) {
          return errorResult(error)
        }
      },
    )
  }

  return server
}

function writeJsonRpcError(reply: FastifyReply, status: number, message: string): void {
  reply.raw.statusCode = status
  reply.raw.setHeader("content-type", "application/json")
  reply.raw.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32000, message } }))
}

export async function handleMcp(
  context: AppContext,
  principal: Principal,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const header = request.headers["mcp-session-id"]
  const sessionId = typeof header === "string" ? header : undefined
  if (sessionId) {
    const session = sessions.get(sessionId)
    if (!session || session.principalId !== principal.id) {
      writeJsonRpcError(reply, 404, "session not found")
      return
    }
    session.lastActive = Date.now()
    await session.transport.handleRequest(request.raw, reply.raw, request.body)
    return
  }
  if (!isInitializeRequest(request.body)) {
    writeJsonRpcError(reply, 400, "initialization required")
    return
  }
  const server = buildServer(context, principal)
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (id) => {
      sessions.set(id, { server, transport, principalId: principal.id, lastActive: Date.now() })
    },
  })
  transport.onclose = () => {
    const id = transport.sessionId
    if (id) sessions.delete(id)
  }
  await server.connect(transport)
  await transport.handleRequest(request.raw, reply.raw, request.body)
}

const cleanup = setInterval(() => {
  const cutoff = Date.now() - 30 * 60 * 1000
  for (const [id, session] of sessions) {
    if (session.lastActive < cutoff) {
      void session.transport.close()
      sessions.delete(id)
    }
  }
}, 60_000)
cleanup.unref()
