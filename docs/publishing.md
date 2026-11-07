# Публикация skills-hub

Релизы делает `.github/workflows/release.yml` по push тега `v*`. Workflow проверяет тег и версию, гоняет тесты и сборку, публикует плагин в npm и отправляет образ сервера в GHCR. GitHub Release не обязателен: публикацию запускает сам тег.

До первого успешного запуска workflow ни npm-пакета, ни образа в GHCR нет. Локальная сборка и `docker compose up --build` работают без публикации.

## Как выпустить релиз

1. Поднимите версию в `apps/plugin/package.json`. Версия должна совпадать с тегом без префикса `v`: тег `v0.0.2` требует версию `0.0.2`. Для единой версии синхронно обновите корень, `apps/server/package.json`, строки версии в `apps/server/src/http.ts`, `apps/server/src/mcp.ts`, `apps/plugin/src/sync.ts` и `package-lock.json`.
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
- `npm publish --workspace=@skills-hub/opencode-plugin --access public`;
- сборку и push образа `ghcr.io/arkaneman/skills-hub`.

## Тег должен указывать на коммит с workflow

Workflow берёт код из тега. Тег, созданный до появления `.github/workflows/release.yml`, публикацию не запустит. Перед первым релизом убедитесь, что тег указывает на коммит, где уже есть build-конфигурация и сам workflow.

## npm: первый publish

Trusted publishing не умеет создавать новый пакет. Пакет должен уже существовать, поэтому первый publish делается одним из двух способов.

### Вариант A: вручную

```bash
npm ci --include=dev
npm run build
npm publish --workspace=@skills-hub/opencode-plugin --access public
```

Нужен `npm login` под владельцем scope. После этого пакет существует, и можно настроить trusted publisher.

### Вариант B: через NPM_TOKEN

1. Создайте granular access token в npm (см. ниже).
2. Добавьте его в GitHub: Settings -> Secrets and variables -> Actions -> `NPM_TOKEN`.
3. Запустите release workflow. Job увидит токен и опубликует пакет с `--provenance`.

Это bootstrap-путь. После настройки trusted publisher удалите `NPM_TOKEN`, иначе workflow всегда будет выбирать token-путь вместо OIDC.

### Scope

`@skills-hub` должен быть npm-org или пользовательским scope, которым вы владеете. Если scope занят или принадлежит другому аккаунту, публикация упадёт с `403`.

## npm: trusted publisher

После первого publish откройте настройки пакета на npmjs.com и добавьте Trusted Publisher:

- publisher: GitHub Actions;
- organization/user: `ArKaNeMaN`;
- repository: `skills-hub`;
- workflow filename: `release.yml`;
- environment: оставьте пустым, если не используете GitHub Environment;
- allowed actions: разрешите прямой `npm publish`, а не только stage publish.

Конфигурации, созданные после 2026-09-03, по умолчанию работают в режиме stage-only. Прямой `npm publish` нужно разрешить явно, иначе workflow не опубликует пакет сразу.

После успешной проверки OIDC удалите секрет `NPM_TOKEN` из GitHub. Пока секрет существует, workflow использует его и не проверяет trusted publisher.

## npm: token fallback

1. npmjs.com -> Access Tokens -> Generate New Token -> Granular Access Token.
2. Дайте право на публикацию пакетов (`read` и `write` для packages).
3. Выберите пакет `@skills-hub/opencode-plugin` или scope `@skills-hub` явно.
4. Если на аккаунте включена 2FA, включите bypass 2FA для automation-токена. Иначе CI не сможет опубликовать пакет без OTP.
5. Сохраните токен как GitHub Actions secret `NPM_TOKEN`.

Частая ошибка: доступ к организации или право владельца scope не даёт право на publish. В granular token нужно явно выбрать пакет или scope и выдать write-право.

## GHCR

Workflow использует `GITHUB_TOKEN` и permission `packages: write`. Образ называется `ghcr.io/arkaneman/skills-hub`.

Теги:

- стабильный тег без `-` (`v0.0.2`) даёт `0.0.2`, `0.0` и `latest`;
- prerelease-тег (`v0.1.0-rc.1`) даёт версию, `major.minor` и `edge`.

После первого push при необходимости откройте настройки package в GitHub и выставьте public visibility, если образ должен тянуться без авторизации.

## Частые сбои

- **Тег не совпадает с версией.** Guard падает до публикации. Тег `v0.0.1` должен соответствовать версии `0.0.1`.
- **Версия уже существует.** npm не перезаписывает версии. Поднимите версию и выпустите новый тег.
- **Нет trusted publisher.** OIDC-публикация падает с ошибкой авторизации. Настройте publisher или используйте `NPM_TOKEN` для bootstrap.
- **Stage-only по умолчанию.** Новый trusted publisher не публикует напрямую, пока не разрешён `npm publish`.
- **2FA.** Ручной publish требует OTP, CI требует granular token с bypass 2FA.
- **Приватный репозиторий и provenance.** Публикация с `--provenance` рассчитана на публичный source. При приватном форке аттестация может быть недоступна.
- **Неправильный `--workspace`.** `npm publish` запускайте из корня репозитория с точным именем `@skills-hub/opencode-plugin`. Без `--workspace` можно опубликовать не тот пакет или пакет без `dist`.
- **Забыли сборку.** В пакет попадает только `dist` из `files`. Перед ручной публикацией выполните `npm run build` и проверьте `npm pack --workspace=@skills-hub/opencode-plugin --dry-run`.
