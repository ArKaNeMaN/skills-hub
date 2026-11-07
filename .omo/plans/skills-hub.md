# skills-hub — план реализации

> Статус: Phase 0–4 реализованы в рабочем срезе. `npm run typecheck`, `npm test` (24) и `npm run test:e2e` (1) зелёные. Ограничения и отклонения — в `docs/journal.md`.

## Профиль проекта

- Дизайн: `docs/design.md` (17 разделов, ревью Oracle пройдено, замечания внесены).
- Владелец решений: пользователь; открытые вопросы §17 дизайна закрыты.
- Ревью плана: Momus, этот файл.
- Журнал: `docs/journal.md` (создаётся в Phase 4).
- Язык: русский (код, идентификаторы и commit messages — английский).
- Стек: Node 22, npm workspaces, TypeScript, Fastify 5, `node:sqlite`, git CLI, zod, без Docker-зависимости.
- Verification: `npm run typecheck`, `npm test`, `npm run build`.
- Commit policy: коммит только по явной просьбе владельца; в этом цикле не коммитить.

## Зафиксированные инварианты

1. opencode v1 (1.19.x): плагин не регистрирует скиллы; доставка через `cfg.skills.paths` из хука `config`.
2. Плагин — только read-путь; MCP — основной write-путь.
3. Уникальность имени — в рамках бакета (`UNIQUE(bucket_id,name)`); на клиенте побеждает последний бакет в порядке `buckets`+`bucketsAdd`.
4. Запись — один файл = один git-коммит; `SKILL.md` создаёт скилл; удаление `SKILL.md` запрещено.
5. MCP-токен по умолчанию: `skills:read`,`skills:write`,`buckets:read`; `skills:delete` — opt-in.
6. Кэш поколенческий: `current.json` — единственная точка коммита; ключ включает `apiUrl` и order-sensitive `bucketSignature`.
7. Admin-токен: только `SKILLS_HUB_ADMIN_TOKEN`, переменная обязательна; одноразового bootstrap-файла нет.
8. Секреты: литерал, `{env:NAME}`, fallback `SKILLS_HUB_TOKEN`/`SKILLS_HUB_MCP_TOKEN`.

## Структура

```text
package.json                 # workspaces
tsconfig.base.json
packages/protocol/           # zod-схемы, лимиты, валидаторы
apps/server/                 # Fastify, SQLite, git, web UI, MCP
apps/plugin/                 # opencode plugin
docs/design.md
docs/journal.md              # Phase 4
```

## Phase 0 — protocol + read API + CLI

### Deliverables
- `packages/protocol/src/index.ts`: `ManifestV1`, `FileEntry`, `Problem`, `Scope`, лимиты, `validateSkillName`, `validateRelPath`, `normalizePathKey`, `parseEnvRef`, `scopes` helpers.
- `apps/server/src/config.ts`: env-конфиг, пути, лимиты, TLS/Origin флаги.
- `apps/server/src/db.ts`: открытие `node:sqlite`, миграции `migrations/0001_init.sql`, WAL, busy_timeout, `user_version`.
- `apps/server/src/git.ts`: `execFile`-обёртки, init/commit/ls-tree/cat-file, lock `data/locks/<slug>.lock`, allowlist remote URL.
- `apps/server/src/indexer.ts`: reindex из `HEAD`, парсинг `bucket.json`/`SKILL.md`, наполнение `buckets/skills/files`.
- `apps/server/src/auth.ts`: формат `shk_<id>_<secret>`, SHA-256, constant-time, scopes/bucket binding, admin-токен из env.
- `apps/server/src/services/*.ts`: buckets, skills read, tokens, audit.
- `apps/server/src/http.ts`: Fastify, `/health`, `/ready`, `/api/v1/buckets`, `/api/v1/manifest`, `/api/v1/skills/:bucket/:name/files/*path`.
- `apps/server/src/cli.ts`: `bucket add`, `token create`, `skill put-file`, `reindex`.
- `apps/server/src/main.ts`: migrations, reindex, listen.
- `apps/server/test/*.test.ts`: integration через `fastify.inject` + temp `DATA_DIR` + real git.

### Acceptance
- `bucket add` создаёт git-репо и `bucket.json`; `skill put-file` пишет один файл и делает один commit.
- `token create` возвращает токен один раз; manifest отдаёт только привязанные бакеты.
- Manifest ETag canonical, `304` работает, `Vary: Authorization`.
- Файл отдаётся из git blob; hash сверяется; drift → reindex или 503.
- `npm run typecheck && npm test` зелёные.

## Phase 1 — плагин (read sync)

### Deliverables
- `apps/plugin/src/config.ts`: 5 слоёв, env-интерполяция, `bucketsAdd`, `mcpName` default/validate.
- `apps/plugin/src/cache.ts`: generations, `current.json`, `managed.json`, GC, lock.
- `apps/plugin/src/sync.ts`: manifest c If-None-Match, limits, parallel download, hash verify, generation switch, 403 reconciliation.
- `apps/plugin/src/adapter.ts`: `V1PathAdapter` (`cfg.skills.paths`), `V2TransformAdapter` stub/feature detect.
- `apps/plugin/src/index.ts`: config hook: resolve → cache path → MCP inject → bounded sync → swap path.
- `apps/plugin/src/cli.ts`: `skills-hub sync`.
- `apps/plugin/test/*.test.ts`: merge, path safety, cache generation, collision last-wins, offline.

### Acceptance
- `opencode debug skill` с temp HOME видит опубликованный скилл.
- Hub остановлен → скилл из кэша, старт не падает.
- Удаление в хабе отражается; два проекта не перетирают кэш; override winner.
- Первый запуск использует `firstSyncTimeoutMs`, повторный получает 304.
- `npm test` зелёный (e2e skip при отсутствии `OPENCODE_BIN`).

## Phase 2 — write API + web UI

### Deliverables
- `PUT /api/v1/admin/skills/:bucket/:name/files/*path`, `DELETE .../files/*path`, `DELETE /api/v1/admin/skills/:bucket/:name`.
- `POST /api/v1/admin/login|logout`, `GET /api/v1/admin/session`, CSRF, session cookie, admin-токен из env.
- Buckets/tokens/audit admin endpoints; static UI `apps/server/public` (login, buckets, skills, editor, tokens, audit), hash routing.
- Per-bucket mutex + lock; symlink lstat guard; `commit.gpgsign=false`; remote URL allowlist; push queue statuses.
- Tests: per-file commit count, authz, CSRF, dirty tree, symlink, remote ext/file rejection, admin login with env token.

### Acceptance
- UI: bucket → SKILL.md → reference → visible in plugin next start.
- Each file save = one commit; delete skill = one commit; delete SKILL.md → 400.
- Same name in different buckets allowed; same bucket → 409.
- Bootstrap token file gone after first login; token rejected afterwards.
- `npm test` зелёный.

## Phase 3 — MCP write path

### Deliverables
- `apps/server/src/mcp.ts`: официальный `@modelcontextprotocol/sdk` StreamableHTTPServerTransport на `POST /mcp`, Bearer, `Mcp-Session-Id`, per-request auth.
- Tools: `list_buckets`, `list_skills`, `get_skill`, `put_skill_file`, `delete_skill_file` (opt-in), `delete_skill` (opt-in).
- Scopes filtering in `tools/list`; bucket binding; audit each mutation; same service layer as HTTP.
- Plugin injects `cfg.mcp.skills-hub` only when `mcpToken` set and key absent.
- Tests: tools/list, tools/call, 401/403, read/write/delete token matrix, bucket binding, no duplicate authz.

### Acceptance
- MCP write token creates/updates file, one commit per call.
- Delete token required for delete tools; read-only token cannot see/call them.
- HTTP and MCP authz results identical.
- Plugin does not overwrite user-defined `mcp.skills-hub`.
- `npm test` зелёный.

## Phase 4 — hardening + record

### Deliverables
- Rate limiting, security tests (traversal, symlink, remote URL, scope escalation, YAML aliases, case-insensitive paths), manifest caps.
- README + `docs/journal.md`, indexes updated.
- Full verification: `npm run typecheck`, `npm test`, `npm run build`.
- Optional opencode e2e if `OPENCODE_BIN` available.

### Acceptance
- All commands green; no known blocker; journal records decisions and deferred items.
- No commit unless owner asks.

## Risks / mitigations

- `node:sqlite` API differences → isolate in `db.ts`, integration test migrations.
- MCP SDK transport API churn → pin version, wrap in `mcp.ts`, contract tests.
- opencode plugin runtime differences (Bun vs Node) → use `node:` builtins/fetch, test with real `opencode debug skill`.
- Git edge cases (dirty tree, symlink, signing) → integration fixtures and explicit guards.
- Agent prompt injection via MCP write → accepted; audit, bucket binding, delete opt-in, read-only option.

## Verification commands

```bash
npm install
npm run typecheck
npm test
npm run build
```

E2E (optional, if binary present):

```bash
OPENCODE_BIN=$(command -v opencode) npm run test:e2e
```
