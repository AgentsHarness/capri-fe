/**
 * Module-wide cache of the agent's skills (GET /api/extensions →
 * {hooks, plugins, skills}). Feeds the slash menu's "skills below
 * commands" group (TUI 1.0.9): mergedSlashCommands is synchronous and
 * shared by the menu filter and typed-line matching, so the list rides a
 * module cache instead of component state; the Composer refreshes it on
 * mount and bumps a render tick.
 */
import type { ExtensionSkill } from '../api/types/extensions'

let cached: ExtensionSkill[] = []
const listeners = new Set<() => void>()

export function cachedSkills(): ExtensionSkill[] {
  return cached
}

export function setCachedSkills(list: ExtensionSkill[]): void {
  cached = list
  listeners.forEach((cb) => cb())
}

export function onSkillsChange(cb: () => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}
