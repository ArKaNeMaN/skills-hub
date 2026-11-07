# skills-hub — журнал реализации

## 2026-11-07 — полный цикл Phase 0–4

### Контекст

Проект стартовал с нуля. Дизайн: `docs/design.md`. План: `.omo/plans/skills-hub.md` (ревью Momus пройдено). Владелец подтвердил: MCP — основной write-путь; уникальность имён в рамках бакета с клиентским override «последний выигрывает»; запись по файлу = один коммит; одноразовый admin bootstrap; токены литералом и через env. `skills:delete` для MCP выключен по умолчанию.

### Что сделано

- Монорепо npm workspaces: `packages/protocol`, `apps/server`, `apps/plugin`.
- Protocol: zod-схемы manifest/problem, лимиты, валидаторы имён/путей, парсер frontmatter, canonical JSON/ETag.
- Server: Fastify read/write API, `node:sqlite` + миграции, git-индекс из `HEAD`, reindex, scoped tokens, bucket binding, admin bootstrap и сессии/CSRF, audit, per-file commits, symlink guard, remote URL allowlist, push queue worker, static web UI, remote MCP (streamable HTTP).
- Plugin: config layering + env interpolation, generation cache (`current.json`), bounded sync, 403 reconciliation, collision override, v1 path adapter, MCP injection, `sync` CLI.
- Tests: 24 integration/unit + 1 e2e с реальным `opencode debug skill`.
- Docs: `README.md`, этот журнал, дизайн обновлён под финальные решения.

### Ключевые решения и почему

- `node:sqlite` вместо `better-sqlite3`: Node 22 уже имеет встроенный модуль, нет нативного toolchain. API изолирован в `apps/server/src/db.ts`; дизайн обновлён (ADR A2).
- Кэш поколенческий: один `current.json` — точка коммита; это убирает окно частичного состояния и рассинхрон `managed.json`.
- Кэш-ключ включает `apiUrl` и order-sensitive `bucketSignature`: два проекта с разными наборами/порядком бакетов не перетирают кэш, порядок задаёт override.
- Запись по файлу: `PUT/DELETE .../files/*path`; `SKILL.md` создаёт скилл; удаление `SKILL.md` запрещено; скилл виден после валидного `SKILL.md`.
- MCP stateful streamable HTTP на официальном SDK: сессии `Mcp-Session-Id`, stateless не использован; `tools/list` фильтруется по scopes.
- Bootstrap-токен: env или файл `DATA_DIR/admin-token` 0600; после первого login файл удаляется, токен инвалидируется.
- Плагин ходит в hub через `node:http`/`node:https`, а не `fetch`: Bun-рантайм opencode в e2e вёл себя нестабильно с abort-таймаутами; `node:http` даёт предсказуемые таймауты и поддерживает `caFile`.

### Verification

```bash
npm run typecheck   # green
npm test            # 24 passed
npm run test:e2e    # 1 passed (opencode 1.19.3/1.19.x)
```

E2E-сценарий: hub на ephemeral port → publish skill → `opencode debug skill` с temp HOME/project → skill виден → hub остановлен → skill виден из кэша.

### Отклонения от плана

- `npm run build` пока равен `tsc --noEmit`; dist-артефакт не собирается, сервер запускается через `tsx`. Это зафиксировано в README.
- Push worker поддерживает только https-транспорт; ssh URL валидируется, но `GIT_ALLOW_PROTOCOL` ограничен https.
- UI — hash-routing, без сборщика; markdown-preview не входит.
- `caFile` реализован в HTTP-клиенте плагина через `https.request({ca})`.

### Открытые нити

- Собрать dist/пакет плагина для публикации в npm (`tsup` или `tsc` + exports).
- Добавить метрики и алерты (Phase 4 hardening); базовый in-memory rate limit уже есть.
- Проверить поведение дедупликации plugin entry global+project на реальном opencode (OQ-1).
- Добавить human approval для MCP write, если риск prompt injection станет неприемлемым.
- Расширить push worker на ssh allowlist и terminal-state алерты.

### Следующие шаги

Приоритеты: P0 — без этого нельзя считать срез готовым к реальным хостам; P1 — эксплуатационная зрелость; P2 — после стабилизации.

#### P0. Упаковка и проверка на реальных хостах

1. **Собрать dist/npm-пакет плагина.**
   - Добавить `tsup` (или `tsc` + `exports`) для `apps/plugin`, собрать ESM с типами.
   - Проверить `npm pack` и установку в чистый `~/.config/opencode/node_modules`.
   - Acceptance: `opencode debug skill` видит скилл при подключении плагина как npm-пакета, без абсолютных путей.
2. **Проверить global+project dedupe и приоритет конфигов.**
   - Реальный opencode 1.19.x: плагин указан и в global, и в project `opencode.json`; опции из `.opencode/skills-hub.json`.
   - Acceptance: sync выполняется один раз, порядок опций совпадает с дизайном; зафиксировать фактическое поведение в `docs/design.md` OQ-1.
3. **Два хоста / два проекта.**
   - Один хост с бакетами `default`, второй — `default+team` с override.
   - Acceptance: кэши не пересекаются, override побеждает, удаление скилла в hub отражается на обоих после рестарта.
4. **Smoke с реальным TLS/reverse proxy.**
   - `PUBLIC_URL=https://...`, cookie `Secure`, Origin-проверка, `caFile` для приватного CA.
   - Acceptance: login/CSRF/read/write работают через proxy; http-запросы не принимаются при `REQUIRE_TLS=true`.

#### P1. Эксплуатационная зрелость

5. **Push worker: ssh + terminal state.**
   - Allowlist хостов для `ssh://`, `GIT_ALLOW_PROTOCOL` по конфигу, восстановление зависших `pushing`, алерт после `failed`.
   - Acceptance: успешный push закрывает запись, non-fast-forward уходит в `failed` без бесконечного retry, ssh-remote работает при явном allowlist.
6. **Метрики и алерты.**
   - `/metrics`: manifest 304 rate, auth failures, git commits, push failures, reindex duration, sqlite busy, sync errors.
   - Acceptance: Prometheus scrape, алерт на push failures и `last_index_error`.
7. **Rate limit по токену/маршруту.**
   - Сейчас есть только общий in-memory лимит на IP; добавить отдельные лимиты login/manifest/write и `Retry-After`.
   - Acceptance: 429 на login после N попыток, запись не страдает от read-нагрузки.
8. **Backup/restore runbook.**
   - `sqlite3 .backup`, `git bundle`/rsync, восстановление без токенов и с токенами, проверка reindex.
   - Acceptance: восстановленный hub отдаёт manifest и файлы; токены/сессии восстанавливаются только из БД.
9. **Аудит: retention/export.**
   - 90 дней, JSON/CSV export, cron-очистка.
   - Acceptance: экспорт содержит commit/requestId, старые записи удаляются, UI не ломается.

#### P2. Безопасность и развитие

10. **Security-тесты.**
    - Path traversal/fuzz, symlink в repo и write-path, YAML alias-бомба, oversized manifest, remote `ext::`/`file://`, scope escalation, CSRF/Origin.
    - Acceptance: негативные кейсы покрыты тестами, ни один не даёт 500 с внутренними путями.
11. **MCP hardening.**
    - Лимиты размера tool-result, очистка сессий, опциональный human approval для `put_skill_file`/`delete_skill`, UI-индикатор write-токена.
    - Acceptance: read-only токен не видит write tools; write-токен оставляет audit; сессия истекает.
12. **v2 adapter.**
    - Реализовать `ctx.skill.transform`/`reload` за существующим интерфейсом, включить feature detection.
    - Acceptance: контрактный тест на фейковом v2 runtime; v1-путь не регрессирует.
13. **Опционально: sharding/read replica.**
    - Только после измеренной необходимости; SQLite+git остаются single-writer.

#### Команды для следующего цикла

```bash
npm run typecheck
npm test
npm run test:e2e
npm pack --workspace @skills-hub/opencode-plugin
```

### Commit

Коммит не создавался: владелец не просил.

## 2026-11-07 — dist, Docker и release-пайплайн

### Что сделано

- `npm run build` теперь собирает оба пакета через tsup. Сервер: `apps/server/dist/main.js`, `apps/server/dist/cli.js`, `apps/server/dist/migrations/0001_init.sql`; статика остаётся в `apps/server/public`. Runtime: `node apps/server/dist/main.js`; dev по-прежнему `npm start` через tsx.
- Плагин собирается в `apps/plugin/dist` как standalone-пакет: `@skills-hub/protocol`, `yaml` и `zod` входят в бандл, runtime-зависимости от workspace нет. `npm pack --workspace @skills-hub/opencode-plugin --dry-run` проходит.
- Добавлены многоступенчатый `Dockerfile` (runtime non-root `node`, `DATA_DIR=/data`, порт 8787, healthcheck `/health`) и `compose.yaml` с локальной сборкой, поддержкой `SKILLS_HUB_IMAGE`, `SKILLS_HUB_PORT`, `SKILLS_HUB_ADMIN_TOKEN`, `PUBLIC_URL`, `TRUST_PROXY`, `REQUIRE_TLS`. Есть `.env.example`.
- CI (`ci.yml`) на push/PR: install, typecheck, test, build, `npm pack --dry-run`, upload артефактов, Docker build без push.
- Release (`release.yml`) на `release: published`: guard тега и версии, guard npm >= 11.5.1, tests/build, публикация плагина в npm (OIDC trusted publishing, `NPM_TOKEN` как bootstrap-fallback) и push образа в GHCR.
- npm bootstrap: trusted publishing не создаёт новый пакет. Первый publish возможен вручную или через `NPM_TOKEN`; после создания пакета настраивается trusted publisher для `ArKaNeMaN/skills-hub` и `release.yml`. Пока секрет `NPM_TOKEN` существует, workflow использует token-путь.
- Тег `v0.0.1` указывает на коммит до release-пайплайна. Для публикации `0.0.1` новым workflow тег нужно перенести на коммит с этим setup и пересоздать GitHub Release, либо выпустить новую версию.

### Измерения

Полная сборка warm: около 5 секунд. Из них server tsup около 0.2 с, plugin tsup около 0.4 с, plugin dts около 2 с.

### Verification

```bash
npm run build
npm pack --workspace @skills-hub/opencode-plugin --dry-run
```

### Commit

Изменения этого цикла закоммичены и запушены в `master`. Публикация переведена на push тега, см. запись ниже.

## 2026-11-07 — публикация по тегу, версия 0.0.2

### Что сделано

- `.github/workflows/release.yml` запускается по push тега `v*`, а не по `release: published`. GitHub Release для публикации больше не нужен.
- GHCR-теги выводятся из имени тега: стабильный тег без `-` даёт версию, `major.minor` и `latest`; prerelease-тег с `-` даёт версию, `major.minor` и `edge`.
- Версия поднята до `0.0.2` в корне, `apps/server`, `apps/plugin`, строках `/health`, MCP-сервера, `User-Agent` плагина и `package-lock.json`.
- Тег `v0.0.1` остаётся на старом коммите до появления пайплайна; новая публикация идёт тегом `v0.0.2`.
- Документация обновлена под tag-triggered релиз: `docs/publishing.md`, `README.md`, `docs/design.md`.

### Verification

```bash
npm ci --include=dev --dry-run
npm run typecheck
npm test
npm run build
npm pack --workspace @skills-hub/opencode-plugin --dry-run
```

CI на `master` после пуша зелёный. Публикацию запускает push тега `v0.0.2`.

### Commit

Коммиты цикла в `master`, затем тег `v0.0.2`. Первый publish в npm требует `NPM_TOKEN` в GitHub Secrets или ручного `npm publish` владельцем scope: trusted publishing не создаёт новый пакет.

## 2026-11-07 — переименование npm-пакета в opencode-skills-hub

### Что сделано

- Имя `skills-hub` в npm занято чужим пакетом, рядом уже существует `@skills-hub-ai/*`. Плагин переименован в `opencode-skills-hub` и публикуется без scope: npm-организация не нужна.
- Версия поднята до `0.0.3` в корне, `apps/server`, `apps/plugin`, строках `/health`, MCP-сервера, `User-Agent` плагина и `package-lock.json`.
- `--workspace` в корневых скриптах, CI и release workflow переведён на `opencode-skills-hub`. У `npm publish` убран `--access public`: для unscoped-пакета он не нужен.
- README, `apps/plugin/README.md`, `docs/design.md` и `docs/publishing.md` обновлены под новое имя.

### Verification

```bash
npm ci --include=dev --dry-run
npm run typecheck
npm test
npm run build
npm pack --workspace opencode-skills-hub --dry-run
```

### Commit

Коммит цикла в `master`, затем тег `v0.0.3`. Первый publish по-прежнему требует `NPM_TOKEN` или ручного `npm publish`.
