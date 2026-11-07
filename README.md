# skills-hub

Единый источник Agent Skills для opencode на нескольких хостах.

- **Hub** — Fastify + `node:sqlite` + один git-репозиторий на бакет.
- **Плагин** — read-only доставка скиллов в opencode v1 через `cfg.skills.paths`, с поколенческим кэшем и офлайн-режимом.
- **MCP** — основной write-путь: агент создаёт и обновляет скиллы по файлам.
- **Web UI** — минимальный административный интерфейс.
- **Дизайн** — [`docs/design.md`](docs/design.md).
- **Журнал и следующие шаги** — [`docs/journal.md`](docs/journal.md).

> **Репозиторий публичный.** Конкретные кейсы и хосты (реальные адреса, SSH-цели, приватные бакеты, пути, логи) здесь не фиксируются. Деплой, обновление и эксплуатация — задачи отдельного приложения `deploy`; из этого репозитория они не запускаются.

## Требования

- Node.js >= 22.5 (используется встроенный `node:sqlite`)
- git >= 2.30
- opencode 1.19.x для клиентской части

## Быстрый старт

```bash
npm install
npm run cli -- bucket add default Default "Default bucket"

cat > /tmp/my-skill.md <<'EOF'
---
name: my-skill
description: Use when testing skills-hub
---

# My skill

Hello from skills-hub.
EOF

npm run cli -- skill put-file default my-skill SKILL.md /tmp/my-skill.md
npm run cli -- token create laptop \
  --scopes skills:read,buckets:read \
  --buckets default

npm start
```

При старте без `SKILLS_HUB_ADMIN_TOKEN` сервер создаёт одноразовый bootstrap-токен:

```text
data/admin-token
```

Откройте `http://127.0.0.1:8787/`, войдите этим токеном. После первого успешного входа файл удаляется, а токен перестаёт приниматься. Для автоматизации/recovery задайте постоянный `SKILLS_HUB_ADMIN_TOKEN`.

## Плагин opencode

Плагин читает настройки из слоёв (поздний побеждает):

1. значения по умолчанию;
2. `~/.config/opencode/skills-hub.json`;
3. опции плагина в `opencode.json`;
4. `.opencode/skills-hub.json` проекта.

Пример `.opencode/skills-hub.json`:

```json
{
  "apiUrl": "https://hub.example.com",
  "token": "{env:SKILLS_HUB_TOKEN}",
  "buckets": ["default"],
  "bucketsAdd": ["team"],
  "mcpToken": "{env:SKILLS_HUB_MCP_TOKEN}",
  "mcpName": "skills-hub"
}
```

Токен можно задать литералом, через `{env:NAME}` или через fallback-переменные `SKILLS_HUB_TOKEN` / `SKILLS_HUB_MCP_TOKEN`.

Подключение как npm-пакет:

```json
{
  "plugin": [
    ["@skills-hub/opencode-plugin", { "apiUrl": "https://hub.example.com" }]
  ]
}
```

Локальная разработка: положите в `.opencode/plugins/skills-hub.ts`:

```ts
export { default } from "/absolute/path/to/apps/plugin/src/index.ts"
```

Поведение:

- плагин добавляет каталог активной генерации кэша в `cfg.skills.paths` до ленивого discovery;
- при наличии `mcpToken` добавляет remote MCP `mcp.skills-hub` в `cfg.mcp`, не перезаписывая пользовательский ключ;
- синхронизация ограничена `connectTimeoutMs` (1500 мс) и `timeoutMs` (1500 мс); первый запуск — `firstSyncTimeoutMs` (15000 мс);
- при недоступном хабе opencode стартует и использует последнюю генерацию;
- при совпадении имён в разных бакетах побеждает последний в порядке `buckets` + `bucketsAdd`.

Кэш: `~/.cache/opencode/skills-hub/<hash>/` с `current.json`, `generations/<uuid>/`, `tmp/`, `trash/`.

## Scopes

| Scope | Назначение |
|---|---|
| `skills:read` | manifest, файлы скиллов |
| `skills:write` | запись одного файла скилла |
| `skills:delete` | удаление файла/скилла |
| `buckets:read` | список бакетов |
| `buckets:write` | создание/удаление бакетов |
| `tokens:admin` | выпуск/отзыв токенов |
| `audit:read` | аудит |
| `admin` | только bootstrap/сессия |

Клиентский токен плагина: `skills:read,buckets:read`.
MCP-токен по умолчанию: `skills:read,skills:write,buckets:read`; `skills:delete` выдаётся отдельно.

## API

Read:

- `GET /api/v1/buckets`
- `GET /api/v1/manifest?buckets=default,team`
- `GET /api/v1/skills/:bucket/:name/files/*path`

Admin/write:

- `POST /api/v1/admin/login`, `POST /api/v1/admin/logout`, `GET /api/v1/admin/session`
- `GET/POST /api/v1/admin/buckets`, `DELETE /api/v1/admin/buckets/:slug?force=true`
- `GET /api/v1/admin/skills?bucket=`
- `GET /api/v1/admin/skills/:bucket/:name`
- `PUT /api/v1/admin/skills/:bucket/:name/files/*path` — один файл = один commit
- `DELETE /api/v1/admin/skills/:bucket/:name/files/*path`
- `DELETE /api/v1/admin/skills/:bucket/:name`
- `GET/POST /api/v1/admin/tokens`, `DELETE /api/v1/admin/tokens/:id`
- `GET /api/v1/admin/audit?limit=100`
- `POST /api/v1/admin/reindex`
- `POST /mcp` — remote MCP (streamable HTTP)

Admin-мутации с cookie требуют `X-CSRF-Token` из `GET /admin/session` или ответа login. Bearer-токены CSRF не требуют.

## MCP write flow

Агент пишет скилл по файлам:

1. `put_skill_file` с `path="SKILL.md"` создаёт скилл (frontmatter `name` должен совпадать).
2. `put_skill_file` с `references/...` добавляет файлы; каждый вызов — отдельный git-коммит.
3. `delete_skill_file` удаляет файл (кроме `SKILL.md`).
4. `delete_skill` удаляет скилл целиком; требует `skills:delete`.

## Конфигурация сервера

| Env | По умолчанию | Смысл |
|---|---|---|
| `HOST` / `PORT` | `127.0.0.1` / `8787` | адрес API |
| `DATA_DIR` | `./data` | `hub.db`, `repos/`, `locks/`, `trash/` |
| `PUBLIC_URL` | — | внешний URL, Secure cookie, Origin |
| `SKILLS_HUB_ADMIN_TOKEN` | — | постоянный admin-токен |
| `ADMIN_BOOTSTRAP_FILE` | `DATA_DIR/admin-token` | одноразовый bootstrap |
| `SESSION_TTL_HOURS` | `12` | TTL сессии |
| `GIT_AUTHOR_NAME` / `GIT_AUTHOR_EMAIL` | `skills-hub` / `hub@skills-hub.local` | identity коммитов |
| `GIT_PUSH_ENABLED` | `true` | выключатель push |
| `MAX_MANIFEST_*` | см. `docs/design.md` | лимиты манифеста |

## Проверка

```bash
npm run typecheck
npm test
npm run test:e2e   # требует opencode в PATH или OPENCODE_BIN
```

E2E поднимает hub, публикует скилл, запускает `opencode debug skill` с временным `HOME` и проверяет, что скилл виден и переживает остановку hub.

## Ограничения текущего среза

- Сервер запускается через `tsx`; отдельного dist-артефакта пока нет.
- Push worker поддерживает `https://` remotes; `ssh://` валидируется, но транспорт по умолчанию ограничен https.
- HA/реплики не поддерживаются: SQLite и рабочее дерево git — один writer.
- v2-адаптер плагина зарезервирован; активен v1-путь через `cfg.skills.paths`.
- `skills:delete` для MCP — только opt-in.
