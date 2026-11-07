# skills-hub — AGENTS

## Public repository policy

This repository is public. Never add concrete deployment or environment details to it: real hostnames, IP addresses, SSH targets, user/account names, private bucket names tied to a specific owner, live paths, tokens, logs, or other case-specific data. Use placeholders (`hub.example.com`, `192.0.2.10`, `example-user`) in docs, tests, and examples.

Deployment, provisioning, updates, backups, and any host-specific work are owned by the separate `deploy` application in this project, not by this repo. Do not run those operations from here and do not document their setup here. Request them from the `deploy` app via handoff (`hanse_request_sibling_change`, `to: "deploy"`), with the goal, constraints, and expected result.

Before committing, review the diff for leaked environment details. If a task inherently needs host-specific data, keep it out of the repo and route the work to `deploy`.

## Commands

```bash
npm install            # dependencies (dev deps need --include=dev in some environments)
npm run typecheck      # tsc --noEmit
npm test               # server + plugin integration tests
npm run test:e2e       # real opencode debug skill; needs OPENCODE_BIN or opencode in PATH
npm run build          # currently typecheck (dist packaging is deferred)
npm start              # tsx apps/server/src/main.ts
npm run cli -- ...     # server CLI: bucket add, token create, skill put-file, reindex
```

## Conventions

- ESM TypeScript (`NodeNext`), `.js` extensions in relative imports.
- `packages/protocol` is the shared contract; keep server and plugin validation aligned with it.
- Source of truth: git repo per bucket; SQLite is a rebuildable index plus tokens/sessions/audit.
- Per-file commits: one `PUT`/`DELETE .../files/*path` = one commit; `SKILL.md` creates a skill; deleting `SKILL.md` is forbidden.
- Skill names are unique per bucket; the client resolves cross-bucket collisions by config order (last wins).
- MCP is the primary write path; `skills:delete` is opt-in.
- Do not log tokens, cookies, request bodies, or skill contents.
- Never commit or push unless explicitly asked.

## Docs

- `docs/design.md` — architecture, contracts, security, phases.
- `docs/journal.md` — implementation record and known gaps.
- `.omo/plans/skills-hub.md` — execution plan.
