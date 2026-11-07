# skills-hub

Сервер и плагин opencode для централизованной раздачи Agent Skills по HTTP.

## Быстрый старт

### Сервер: Docker Compose

```bash
docker compose up -d --build --wait
docker compose exec skills-hub cat /data/admin-token
```

Откройте `http://127.0.0.1:8787` и войдите токеном из файла. После первого входа bootstrap-токен удаляется. Для постоянного доступа задайте `SKILLS_HUB_ADMIN_TOKEN` в `.env` (шаблон: `.env.example`).

### Сервер: готовый образ (опционально)

Образ публикуется release-workflow. До первого релиза используйте локальную сборку.

```bash
export SKILLS_HUB_IMAGE=ghcr.io/arkaneman/skills-hub:<tag>
docker compose pull
docker compose up -d --no-build
```

Теги: prerelease `v0.0.1` даёт `0.0.1`, `0.0` и `edge`; стабильный релиз даёт версию, `major.minor` и `latest`. Сейчас `v0.0.1` это prerelease, поэтому `latest` ещё нет.

Для production за reverse proxy с TLS задайте в `.env`:

```dotenv
PUBLIC_URL=https://hub.example.com
TRUST_PROXY=true
REQUIRE_TLS=true
```

TLS терминирует proxy (Caddy, nginx). Порт `8787` наружу не публикуйте.

### Плагин opencode 1.19.x

```bash
opencode plugin @skills-hub/opencode-plugin
```

Пакет появляется в npm после первого запуска release-workflow. До этого подключайте плагин из локальной сборки репозитория.

Или вручную в `opencode.json`:

```json
{
  "plugin": [
    ["@skills-hub/opencode-plugin", {
      "apiUrl": "https://hub.example.com",
      "buckets": ["default"],
      "token": "{env:SKILLS_HUB_TOKEN}"
    }]
  ]
}
```

`plugin` это массив верхнего уровня. Вариант `["@skills-hub/opencode-plugin"]` тоже подходит, если `apiUrl` задан в `.opencode/skills-hub.json` или глобальном конфиге, а токен через `SKILLS_HUB_TOKEN`.

Создайте read-токен и бакет:

```bash
docker compose exec skills-hub node dist/cli.js bucket add default Default "Default bucket"
docker compose exec skills-hub node dist/cli.js token create laptop --scopes skills:read,buckets:read --buckets default
```

Токен показывается один раз. Передайте его через `SKILLS_HUB_TOKEN` или `"token": "{env:SKILLS_HUB_TOKEN}"`. Отдельный `npm install` для плагина не нужен: opencode ставит npm-плагины при старте.

Конфиг бывает глобальный (`~/.config/opencode/opencode.json`) и проектный (`opencode.json` или `.opencode/opencode.json`). При совпадении пакета проектный конфиг побеждает, поэтому регистрируйте плагин в одном месте.

**Важно для 1.19.x:** `opencode plugin add` и объектная форма `"plugins": { "package": ..., "options": ... }` относятся к v2 и здесь не работают.

## Проверка

```bash
curl -fsS http://127.0.0.1:8787/health
```

Если плагин уже подключён:

```bash
opencode debug skill
```

Команда показывает скиллы, доступные opencode. Для чистой проверки используйте временный `HOME` и проект.

## Разработка

Нужны Node.js >= 22.5, git >= 2.30 и opencode 1.19.x для клиентской части.

```bash
npm ci --include=dev
npm run typecheck
npm test
npm run build
npm start                    # dev, tsx
node apps/server/dist/main.js  # собранный сервер
npm run test:e2e             # нужен opencode в PATH или OPENCODE_BIN
```

`npm run build` собирает оба пакета через tsup. Сервер: `apps/server/dist/main.js`, `apps/server/dist/cli.js`, `apps/server/dist/migrations/0001_init.sql`; статика остаётся в `apps/server/public`. Плагин: `apps/plugin/dist`, standalone-пакет без runtime-зависимости от workspace.

Для локального подключения плагина положите в `.opencode/plugins/skills-hub.ts`:

```ts
export { default } from "/absolute/path/to/apps/plugin/src/index.ts"
```

## Обновление

Локальная сборка:

```bash
docker compose up -d --build
```

Опубликованный образ:

```bash
export SKILLS_HUB_IMAGE=ghcr.io/arkaneman/skills-hub:<tag>
docker compose pull
docker compose up -d --no-build
```

Данные лежат в volume `skills-hub-data` и переживают пересоздание контейнера. Перед обновлением между несовместимыми версиями сделайте backup `DATA_DIR`.

## Документация

- [`docs/design.md`](docs/design.md): архитектура, API, безопасность.
- [`docs/journal.md`](docs/journal.md): журнал реализации и открытые задачи.
- [`docs/publishing.md`](docs/publishing.md): релизы npm/GHCR для мейнтейнеров.
- [`apps/plugin/README.md`](apps/plugin/README.md): страница npm-пакета.
- [`AGENTS.md`](AGENTS.md): правила работы с репозиторием.

## Ограничения текущего среза

- Push worker поддерживает только `https://` remotes; `ssh://` валидируется, но транспорт по умолчанию ограничен https.
- HA и реплики не поддерживаются: SQLite и рабочее дерево git требуют одного writer.
- v2-адаптер плагина зарезервирован; активен v1-путь через `cfg.skills.paths`.
- `skills:delete` для MCP выдаётся только явно (opt-in).
- Реальный TLS/reverse proxy и сценарий двух хостов ещё не проверены; это P0.

## Конфигурация сервера

| Env | По умолчанию | Смысл |
|---|---|---|
| `HOST` / `PORT` | `127.0.0.1` / `8787` | адрес API |
| `DATA_DIR` | `./data` | `hub.db`, `repos/`, `locks/`, `trash/` |
| `PUBLIC_URL` | нет | внешний URL, Secure cookie, Origin |
| `SKILLS_HUB_ADMIN_TOKEN` | нет | постоянный admin-токен |
| `ADMIN_BOOTSTRAP_FILE` | `DATA_DIR/admin-token` | одноразовый bootstrap |
| `SESSION_TTL_HOURS` | `12` | TTL сессии |
| `TRUST_PROXY` | `false` | доверять `X-Forwarded-*` |
| `REQUIRE_TLS` | `true` при `NODE_ENV=production` | требовать TLS |
| `GIT_AUTHOR_NAME` / `GIT_AUTHOR_EMAIL` | `skills-hub` / `hub@skills-hub.local` | identity коммитов |
| `GIT_PUSH_ENABLED` | `true` | выключатель push |
| `MAX_MANIFEST_*` | см. `docs/design.md` | лимиты манифеста |

## Scopes

| Scope | Назначение |
|---|---|
| `skills:read` | manifest, файлы скиллов |
| `skills:write` | запись одного файла скилла |
| `skills:delete` | удаление файла или скилла |
| `buckets:read` | список бакетов |
| `buckets:write` | создание и удаление бакетов |
| `tokens:admin` | выпуск и отзыв токенов |
| `audit:read` | аудит |
| `admin` | только bootstrap и сессия |

Клиентский токен плагина: `skills:read,buckets:read`. MCP-токен по умолчанию: `skills:read,skills:write,buckets:read`; `skills:delete` выдаётся отдельно.

## API

Read:

- `GET /api/v1/buckets`
- `GET /api/v1/manifest?buckets=default,team`
- `GET /api/v1/skills/:bucket/:name/files/*path`

Admin и запись:

- `POST /api/v1/admin/login`, `POST /api/v1/admin/logout`, `GET /api/v1/admin/session`
- `GET/POST /api/v1/admin/buckets`, `DELETE /api/v1/admin/buckets/:slug?force=true`
- `GET /api/v1/admin/skills?bucket=`
- `GET /api/v1/admin/skills/:bucket/:name`
- `PUT /api/v1/admin/skills/:bucket/:name/files/*path`: один файл равен одному commit
- `DELETE /api/v1/admin/skills/:bucket/:name/files/*path`
- `DELETE /api/v1/admin/skills/:bucket/:name`
- `GET/POST /api/v1/admin/tokens`, `DELETE /api/v1/admin/tokens/:id`
- `GET /api/v1/admin/audit?limit=100`
- `POST /api/v1/admin/reindex`
- `POST /mcp`: remote MCP (streamable HTTP)

Admin-мутации с cookie требуют `X-CSRF-Token` из `GET /admin/session` или ответа login. Bearer-токены CSRF не требуют.

## MCP write flow

Агент пишет скилл по файлам:

1. `put_skill_file` с `path="SKILL.md"` создаёт скилл; frontmatter `name` должен совпадать.
2. `put_skill_file` с `references/...` добавляет файлы; каждый вызов это отдельный git-коммит.
3. `delete_skill_file` удаляет файл, кроме `SKILL.md`.
4. `delete_skill` удаляет скилл целиком и требует `skills:delete`.

## Как работает плагин

Плагин читает настройки слоями, поздний побеждает:

1. значения по умолчанию;
2. `~/.config/opencode/skills-hub.json`;
3. опции плагина в `opencode.json`;
4. `.opencode/skills-hub.json` проекта.

Поведение:

- добавляет каталог активной генерации кэша в `cfg.skills.paths` до ленивого discovery;
- при наличии `mcpToken` добавляет remote MCP `mcp.skills-hub` в `cfg.mcp`, не перезаписывая пользовательский ключ;
- ограничивает синхронизацию: `connectTimeoutMs` 1500 мс, `timeoutMs` 1500 мс, первый запуск до `firstSyncTimeoutMs` 15000 мс;
- при недоступном хабе opencode стартует из последней генерации;
- при совпадении имён в разных бакетах побеждает последний в порядке `buckets` и `bucketsAdd`.

Кэш: `~/.cache/opencode/skills-hub/<hash>/` с `current.json`, `generations/<uuid>/`, `tmp/`, `trash/`.

## Публичный репозиторий

Здесь не должно быть реальных хостов, адресов, SSH-целей, приватных бакетов, токенов, логов и рабочих путей. Для примеров используйте `hub.example.com` и `127.0.0.1`. Docker Compose выше предназначен для локального запуска и тестов. Для реальных хостов деплой, обновление и эксплуатация остаются задачей отдельного приложения `deploy`.
