import path from "node:path"

export interface OpenCodeConfig {
  skills?: {
    paths?: string[]
  }
  mcp?: Record<string, unknown>
}

export interface SkillDeliveryAdapter {
  apply(config: OpenCodeConfig, skillsRoot: string, previous?: string): void
}

export function applyV1Path(config: OpenCodeConfig, skillsRoot: string, previous?: string): void {
  config.skills ??= {}
  const current = Array.isArray(config.skills.paths) ? config.skills.paths : []
  const normalized = current.filter((item) => item !== previous)
  const target = path.resolve(skillsRoot)
  if (!normalized.includes(target)) normalized.push(target)
  config.skills.paths = [...new Set(normalized)]
}

export const v1PathAdapter: SkillDeliveryAdapter = {
  apply(config, skillsRoot, previous) {
    applyV1Path(config, skillsRoot, previous)
  },
}

export const v2TransformAdapter: SkillDeliveryAdapter = {
  apply() {
    // Reserved for opencode v2: ctx.skill.transform(editor) + ctx.skill.reload().
    // The v1 plugin runtime does not expose a skill transform.
  },
}
