# Публикация skills-hub

Релизы делает `.github/workflows/release.yml` по push тега `v*`. Workflow проверяет тег и версию, гоняет тесты и сборку, публикует плагин в npm и отправляет образ сервера в GHCR. GitHub Release не обязателен: публикацию запускает сам тег.

Пакет `opencode-skills-hub` и образ в GHCR уже существуют: первый publish пакета был ручным, дальше релизы идут через trusted publishing по тегу. Локальная сборка и `docker compose up --build` работают без публикации.

## Как выпустить релиз

1. Поднимите версию в `apps/plugin/package.json`. Версия должна совпадать с тегом без префикса `v`: тег `v0.0.3` требует версию `0.0.3`. Для единой версии синхронно обновите корень, `apps/server/package.json`, строки версии в `apps/server/src/http.ts`, `apps/server/src/mcp.ts`, `apps/plugin/src/sync.ts` и `package-lock.json`.
2. Закоммитьте изменения и отправьте их в `master`.
3. Поставьте тег и отправьте его:
   ```bash
   git tag vX.Y.Z
   git push origin vX.Y.Z
   ```
4. При необходимости создайте GitHub Release для этого тега с описанием изменений. На публикацию это не влияет.
5. Проверьте оба job в Actions: `Publish plugin to npm` и `Publish server image to GHCR`.

Workflow делает:

- guard на совпадение тега и `apps/plugin/package.json`;
- guard на npm >= 11.5.1 (нужен для OIDC trusted publishing);
- `npm ci --include=dev`, `npm test`, `npm run build`;
- `npm publish --workspace=opencode-skills-hub`;
- сборку и push образа `ghcr.io/arkaneman/skills-hub`.

## Тег должен указывать на коммит с workflow

Workflow берёт код из тега. Тег, созданный до появления `.github/workflows/release.yml`, публикацию не запустит. Перед первым релизом убедитесь, что тег указывает на коммит, где уже есть build-конфигурация и сам workflow.

## npm: первый publish

Trusted publishing не умеет создавать новый пакет. Первый publish был сделан вручную, один раз:

```bash
npm ci --include=dev
npm run build
npm publish --workspace=opencode-skills-hub
```

Нужен `npm login` и OTP. После появления пакета настраивается trusted publisher, и дальше workflow публикует новые версии без токенов.

### Имя пакета

Пакет называется `opencode-skills-hub` и публикуется без scope. npm-организация не нужна. Если имя займут до первого publish, переименуйте пакет в `apps/plugin/package.json` и синхронно обновите `--workspace` в workflow, скрипты корня и документацию.

## npm: trusted publisher

Откройте `npmjs.com/package/opencode-skills-hub` → Settings → Trusted Publisher и добавьте:

- publisher: GitHub Actions;
- organization/user: `ArKaNeMaN`;
- repository: `skills-hub`;
- workflow filename: `release.yml`;
- environment: оставьте пустым, если не используете GitHub Environment;
- allowed actions: разрешите прямой `npm publish`, а не только stage publish.

Конфигурации, созданные после 2026-09-03, по умолчанию работают в режиме stage-only. Прямой `npm publish` нужно разрешить явно, иначе workflow не опубликует пакет сразу.

Workflow публикует только через OIDC, `NPM_TOKEN` ему не нужен. Секрет в GitHub можно не создавать, а существующий лучше удалить.

## GHCR

Workflow использует `GITHUB_TOKEN` и permission `packages: write`. Образ называется `ghcr.io/arkaneman/skills-hub`.

Теги:

- стабильный тег без `-` (`v0.0.4`) даёт `0.0.4`, `0.0` и `latest`;
- prerelease-тег (`v0.1.0-rc.1`) даёт версию, `major.minor` и `edge`.

После первого push при необходимости откройте настройки package в GitHub и выставьте public visibility, если образ должен тянуться без авторизации.

## Частые сбои

- **Тег не совпадает с версией.** Guard падает до публикации. Тег `v0.0.4` должен соответствовать версии `0.0.4`.
- **Версия уже существует.** npm не перезаписывает версии. Поднимите версию и выпустите новый тег.
- **Нет trusted publisher.** OIDC-публикация падает с ошибкой авторизации. Настройте publisher в настройках пакета.
- **Stage-only по умолчанию.** Новый trusted publisher не публикует напрямую, пока не разрешён `npm publish`.
- **2FA.** Ручной первый publish требует OTP. CI использует OIDC и токенов не требует.
- **Приватный репозиторий и provenance.** Публикация с `--provenance` рассчитана на публичный source. При приватном форке аттестация может быть недоступна.
- **Неправильный `--workspace`.** `npm publish` запускайте из корня репозитория с точным именем `opencode-skills-hub`. Без `--workspace` можно опубликовать не тот пакет или пакет без `dist`.
- **Забыли сборку.** В пакет попадает только `dist` из `files`. Перед ручной публикацией выполните `npm run build` и проверьте `npm pack --workspace=opencode-skills-hub --dry-run`.
