import type { TransportCore } from '../transport'

type JsonObject = Record<string, unknown>

function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function responseError(data: unknown): string | undefined {
  if (!isJsonObject(data)) return undefined
  const value = data.error ?? data.message
  if (typeof value === 'string' && value.trim()) return value
  if (value == null || value === false || value === '') return undefined
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

/** Read an RPC response without turning an empty or invalid body into a parse error. */
export async function readRpcJson(res: Response): Promise<unknown | undefined> {
  try {
    return await res.json()
  } catch {
    return undefined
  }
}

/** Apply the HTTP/RPC success convention while retaining the host's error text. */
export function assertRpcOk(res: Response, data: unknown, fallback: string): void {
  if (!res.ok || (isJsonObject(data) && data.ok === false)) {
    throw new Error(responseError(data) || `${fallback} (${res.status})`)
  }
}

export function requireRpcObject(
  data: unknown,
  path: string,
  status: number,
): JsonObject {
  if (!isJsonObject(data)) {
    throw new Error(`${path} returned invalid JSON response (${status})`)
  }
  return data
}

export async function xaiCall(core: TransportCore, path: string, body: Record<string, unknown>): Promise<unknown> {
    const res = await core.fetch(core.url(path), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const data = await readRpcJson(res)
    assertRpcOk(res, data, path + ' failed')
    return isJsonObject(data) ? data.result : undefined
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
