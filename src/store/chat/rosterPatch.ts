import type { SessionInfo } from '../../api/types'
import type { ChatState, SetState } from './types'

/**
 * `sessions_changed` 的行级补丁（wire shape）。
 *
 * params 是 `{upserted?: row[], removed?: sessionId[]}`：行只带变化的那部分
 * 字段。补丁按字段合并已有的会话行、删除 `removed` 里的行；名册里还没有
 * 的会话不插入（调用方整表重拉），空 params（名册结构变化）也交给调用方
 * 整表重拉。
 */
export type RosterChangedParams = {
  upserted?: unknown
  removed?: unknown
}

/** 从事件参数里取出行级补丁；没有行数据返回 null（调用方整表重拉）。 */
export function parseRosterPatch(
  params: Record<string, unknown> | undefined,
): { upserted: SessionInfo[]; removed: string[] } | null {
  const p = params as RosterChangedParams | undefined
  if (!p) return null
  const hasUpserted = Array.isArray(p.upserted)
  const hasRemoved = Array.isArray(p.removed)
  if (!hasUpserted && !hasRemoved) return null
  const upserted: SessionInfo[] = []
  if (hasUpserted) {
    for (const raw of p.upserted as unknown[]) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
      const o = raw as Record<string, unknown>
      const sessionId =
        (typeof o.sessionId === 'string' && o.sessionId) ||
        (typeof o.session_id === 'string' && o.session_id) ||
        ''
      if (!sessionId) continue
      // 归一化 id：下游（合并、按 id 查找）只认 camelCase。
      upserted.push(
        (o.sessionId === sessionId ? o : { ...o, sessionId }) as unknown as SessionInfo,
      )
    }
  }
  const removed: string[] = []
  if (hasRemoved) {
    for (const raw of p.removed as unknown[]) {
      if (typeof raw === 'string' && raw) removed.push(raw)
      else if (raw && typeof raw === 'object') {
        const sid = (raw as { sessionId?: unknown }).sessionId
        if (typeof sid === 'string' && sid) removed.push(sid)
      }
    }
  }
  return { upserted, removed }
}

/**
 * 把行级补丁折进 `sessions`。
 *
 * 返回 `unknown`：补丁里出现、但名册里还没有的会话数。调用方据此决定要
 * 不要整表重拉——那种行的 cwd / 摘要都还不可知（另一台客户端刚建、本页
 * 尚未拉到），凭空插入会造出一行字段残缺的会话；走一次（已被闸门合并过的）
 * 全量拉取才是对的。
 *
 * 行的字段是**部分**的（例如模型切换的行只带 modelId），所以合并方向是
 * 「用新值覆盖同名键，未出现的键保留」，不是整行替换。census 三兄弟
 * （hasTasks / bgCount / bgRunning）由磁盘扫描得出，行里通常没有——缺失
 * 不等于清零。`changed` 只看补丁行实际携带的键，保留字段与旧值相同，
 * 因此不会把「没带 census」误判成变化。
 */
export function applyRosterPatch(
  set: SetState,
  get: () => ChatState,
  patch: { upserted: SessionInfo[]; removed: string[] },
): { changed: boolean; unknown: number } {
  const { upserted, removed } = patch
  const cur = get().sessions
  let changed = false
  const gone = new Set(removed)
  const next = cur.filter((s) => {
    if (!gone.has(s.sessionId)) return true
    changed = true
    return false
  })
  const byId = new Map(next.map((s) => [s.sessionId, s] as const))
  let unknown = 0
  for (const row of upserted) {
    const prev = byId.get(row.sessionId)
    if (!prev) {
      unknown += 1
      continue
    }
    const merged: SessionInfo = { ...prev }
    const keys: string[] = []
    for (const [k, v] of Object.entries(row as Record<string, unknown>)) {
      if (v === undefined) continue
      // id 只用于定位行；snake_case 别名是解析时补的，不算内容变化。
      if (k !== 'sessionId' && k !== 'session_id') keys.push(k)
      ;(merged as Record<string, unknown>)[k] = v
    }
    const idx = next.indexOf(prev)
    if (idx >= 0) next[idx] = merged
    byId.set(row.sessionId, merged)
    if (changedOver(prev, merged, keys)) changed = true
  }
  if (changed) set({ sessions: next })
  return { changed, unknown }
}

/**
 * 只比较补丁行实际携带的键：合并时未出现的键取自 `prev`，天然相等。
 * 对象（`status` / `meta`）按一层浅比较，避免内容相同的新对象触发重渲染。
 */
function changedOver(prev: SessionInfo, merged: SessionInfo, keys: string[]): boolean {
  for (const key of keys) {
    if (!sameValue(
      (prev as unknown as Record<string, unknown>)[key],
      (merged as unknown as Record<string, unknown>)[key],
    )) {
      return true
    }
  }
  return false
}

function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  const ka = Object.keys(a)
  const kb = Object.keys(b)
  if (ka.length !== kb.length) return false
  return ka.every((k) =>
    Object.is(
      (a as Record<string, unknown>)[k],
      (b as Record<string, unknown>)[k],
    ),
  )
}
