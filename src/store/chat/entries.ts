import type { ScrollEntry } from '../../api/types'
import type { SetState } from './types'
import { nid } from './ids'

/**
 * Normalize an x.ai notification payload. The shell sends either the
 * SessionNotification envelope {"update": {"sessionUpdate": tag, …}} or a
 * flat {"sessionUpdate": tag, …} (headless wire form).
 */
export function extractSessionUpdate(
  params?: Record<string, unknown>,
): { tag?: string; fields: Record<string, unknown> } {
  const u = (params?.update as Record<string, unknown> | undefined) ?? params ?? {}
  const tag = typeof u.sessionUpdate === 'string' ? u.sessionUpdate : undefined
  return { tag, fields: u }
}

/** Distributive Omit (works over the ScrollEntry union). */
export type DistributiveOmit<T, K extends keyof any> = T extends any ? Omit<T, K> : never
export type EntryWithoutId = DistributiveOmit<ScrollEntry, 'id'>

/** Append a non-streaming entry to the scrollback. */
export function appendEntry(set: SetState, entry: EntryWithoutId): void {
  set((s) => ({
    entries: [...s.entries, { id: nid(), ...entry } as ScrollEntry],
  }))
}

/**
 * 条目的可比较时间戳（epoch ms）：user/assistant/image 用 ts，
 * thought/tool/subagent 用 startedAt。无时间字段的条目（session_event、
 * status、error 等）返回 undefined，由调用方跳过。用于 recap 回填的
 * 时间就近定位。
 */
export function entryTimestamp(e: ScrollEntry): number | undefined {
  switch (e.kind) {
    case 'user':
    case 'assistant':
    case 'image':
      return e.ts
    case 'thought':
    case 'tool':
    case 'subagent':
      return e.startedAt
    default:
      return undefined
  }
}
