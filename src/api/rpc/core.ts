import type { TransportCore } from '../transport'

export async function xaiCall(core: TransportCore, path: string, body: Record<string, unknown>): Promise<unknown> {
    const res = await core.fetch(core.url(path), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok || data.ok === false) {
      throw new Error(data.error || `${path} failed (${res.status})`)
    }
    return data.result
  }

export function findField(root: unknown, key: string): unknown {
  const seen = new Set<unknown>()
  const walk = (v: unknown, depth: number): unknown => {
    if (v == null || depth > 6) return undefined
    if (typeof v !== 'object' || Array.isArray(v)) return undefined
    if (seen.has(v)) return undefined
    seen.add(v)
    const o = v as Record<string, unknown>
    if (key in o && o[key] !== undefined && o[key] !== null) return o[key]
    for (const k of ['result', 'data', 'payload']) {
      const found = walk(o[k], depth + 1)
      if (found !== undefined) return found
    }
    return undefined
  }
  return walk(root, 0)
}

export function findArrayField(root: unknown, key: string): unknown[] {
  const seen = new Set<unknown>()
  const walk = (v: unknown, depth: number): unknown[] | null => {
    if (v == null || depth > 6) return null
    if (typeof v !== 'object') return null
    if (seen.has(v)) return null
    seen.add(v)
    if (Array.isArray(v)) return null
    const o = v as Record<string, unknown>
    if (Array.isArray(o[key])) return o[key]
    for (const k of ['result', 'data', 'payload']) {
      const found = walk(o[k], depth + 1)
      if (found) return found
    }
    return null
  }
  return walk(root, 0) ?? []
}

export function findObjectField(
  root: unknown,
  key: string,
): Record<string, unknown> | undefined {
  const seen = new Set<unknown>()
  const walk = (v: unknown, depth: number): Record<string, unknown> | undefined => {
    if (v == null || depth > 6) return undefined
    if (typeof v !== 'object' || Array.isArray(v)) return undefined
    if (seen.has(v)) return undefined
    seen.add(v)
    const o = v as Record<string, unknown>
    if (o[key] && typeof o[key] === 'object' && !Array.isArray(o[key])) {
      return o[key] as Record<string, unknown>
    }
    for (const k of ['result', 'data', 'payload']) {
      const found = walk(o[k], depth + 1)
      if (found) return found
    }
    return undefined
  }
  return walk(root, 0)
}

export function unwrapExtResult<T>(raw: unknown): T {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const o = raw as Record<string, unknown>
    if ('result' in o) {
      if (o.error != null && o.error !== false && o.error !== '') {
        throw new Error(
          typeof o.error === 'string' ? o.error : JSON.stringify(o.error),
        )
      }
      if (o.result != null) return o.result as T
    }
  }
  return raw as T
}

export function pickSummaryActivityAt(o: Record<string, unknown>): string | undefined {
  for (const key of ['last_active_at', 'lastActiveAt', 'updated_at', 'updatedAt'] as const) {
    const v = o[key]
    if (typeof v === 'string' && v) return v
  }
  return undefined
}
