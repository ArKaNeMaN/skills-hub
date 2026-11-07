# @skills-hub/opencode-plugin

Плагин opencode 1.19.x: забирает Agent Skills из skills-hub, кэширует их и добавляет в `cfg.skills.paths`.

```bash
opencode plugin @skills-hub/opencode-plugin
```

Или вручную в `opencode.json`:

```json
{ "plugin": [["@skills-hub/opencode-plugin", { "apiUrl": "https://hub.example.com" }]] }
```

Токен берите из `SKILLS_HUB_TOKEN` или задайте `"token": "{env:SKILLS_HUB_TOKEN}"`. Нужен scope `skills:read,buckets:read`. Отдельный `npm install` не нужен: opencode ставит npm-плагины при старте.

Полная инструкция: [README skills-hub](https://github.com/ArKaNeMaN/skills-hub#readme).
