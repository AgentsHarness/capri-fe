import type { CustomModelConfig } from '../api/types'

export interface EndpointOption {
  key: string
  baseUrl: string
  apiKey?: string
  apiBackend?: CustomModelConfig['api_backend']
  count: number
}

export interface RawRemoteModel {
  id: string
  name?: string
  context_window?: number
  [key: string]: unknown
}

export interface ModelsDevModel {
  id: string
  name: string
  reasoning?: boolean
  reasoning_options?: Array<{ type: string; values?: string[] }>
  limit?: {
    context?: number
    output?: number
  }
}

export interface DiscoveredModel {
  remoteId: string
  configKey: string
  name: string
  contextWindow: number
  maxCompletionTokens?: number
  supportsReasoning: boolean
  reasoningEfforts?: Array<{ value: string; label?: string; description?: string; default?: boolean }>
  isExisting: boolean
  matchedDev: boolean
}

/** 从现有模型列表中提取去重后的端点 (baseUrl + apiKey) */
export function extractEndpoints(models: CustomModelConfig[]): EndpointOption[] {
  const map = new Map<string, EndpointOption>()
  for (const m of models) {
    if (!m.base_url?.trim()) continue
    const url = m.base_url.trim()
    const existing = map.get(url)
    if (existing) {
      existing.count++
      if (!existing.apiKey && m.api_key) existing.apiKey = m.api_key
      if (!existing.apiBackend && m.api_backend) existing.apiBackend = m.api_backend
    } else {
      map.set(url, {
        key: url,
        baseUrl: url,
        apiKey: m.api_key,
        apiBackend: m.api_backend,
        count: 1,
      })
    }
  }
  return Array.from(map.values())
}

/** 生成合法的 TOML 配置节键名（防止重名冲突） */
export function generateModelConfigKey(
  remoteId: string,
  existingKeys: Set<string>,
): string {
  let cleanSlug = remoteId.trim()
  if (cleanSlug.includes('/')) {
    const parts = cleanSlug.split('/')
    const shortName = parts[parts.length - 1].toLowerCase().replace(/[^a-z0-9._-]/g, '-')
    if (shortName && !existingKeys.has(shortName)) {
      return shortName
    }
  }
  const base = cleanSlug.toLowerCase().replace(/[^a-z0-9._-]/g, '-') || 'model'
  if (!existingKeys.has(base)) {
    return base
  }
  let counter = 2
  while (existingKeys.has(`${base}-${counter}`)) {
    counter++
  }
  return `${base}-${counter}`
}

/** 请求 baseUrl 对应的 /v1/models 接口 */
export async function fetchRemoteModels(
  baseUrl: string,
  apiKey?: string,
): Promise<RawRemoteModel[]> {
  const clean = baseUrl.trim().replace(/\/+$/, '')
  if (!clean) throw new Error('请输入有效的 Base URL')

  const candidates: string[] = []
  if (clean.endsWith('/v1')) {
    candidates.push(`${clean}/models`)
  } else {
    candidates.push(`${clean}/v1/models`, `${clean}/models`)
  }

  const headers: Record<string, string> = {
    Accept: 'application/json',
  }
  if (apiKey?.trim()) {
    headers['Authorization'] = `Bearer ${apiKey.trim()}`
  }

  let lastError: Error | null = null
  for (const url of candidates) {
    try {
      const res = await fetch(url, { headers })
      if (!res.ok) {
        const errText = await res.text().catch(() => '')
        throw new Error(`HTTP ${res.status}: ${errText || res.statusText}`)
      }
      const json = await res.json()
      let list: unknown[] = []
      if (Array.isArray(json)) {
        list = json
      } else if (Array.isArray(json.data)) {
        list = json.data
      } else if (Array.isArray(json.models)) {
        list = json.models
      } else {
        throw new Error('返回数据不包含可识别的模型列表（需包含 data 或 models 数组）')
      }

      return list
        .map((item) => {
          if (typeof item === 'string') return { id: item }
          if (typeof item === 'object' && item !== null) {
            const obj = item as Record<string, unknown>
            const id = String(obj.id || obj.name || obj.model || '')
            if (!id) return null
            return {
              id,
              name: typeof obj.name === 'string' ? obj.name : undefined,
              context_window:
                typeof obj.context_window === 'number'
                  ? obj.context_window
                  : typeof obj.contextWindow === 'number'
                    ? obj.contextWindow
                    : undefined,
              ...obj,
            } as RawRemoteModel
          }
          return null
        })
        .filter((item): item is RawRemoteModel => item !== null)
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e))
    }
  }

  throw lastError || new Error('未能从端点获取模型列表')
}

let cachedModelsDevMap: Map<string, ModelsDevModel> | null = null
let modelsDevPromise: Promise<Map<string, ModelsDevModel>> | null = null

/** 从 models.dev 拉取全量模型元数据并建立快速索引 Map */
export async function getModelsDevMap(): Promise<Map<string, ModelsDevModel>> {
  if (cachedModelsDevMap) return cachedModelsDevMap
  if (modelsDevPromise) return modelsDevPromise

  modelsDevPromise = (async () => {
    try {
      const res = await fetch('https://models.dev/api.json', { signal: AbortSignal.timeout(8000) })
      if (!res.ok) return new Map()
      const data = (await res.json()) as Record<string, { models?: Record<string, ModelsDevModel> }>
      const map = new Map<string, ModelsDevModel>()
      for (const provider of Object.values(data)) {
        if (!provider.models) continue
        for (const [modelKey, modelObj] of Object.entries(provider.models)) {
          if (!modelObj || !modelObj.id) continue
          map.set(modelKey, modelObj)
          map.set(modelKey.toLowerCase(), modelObj)
          map.set(modelObj.id, modelObj)
          map.set(modelObj.id.toLowerCase(), modelObj)
          if (modelObj.id.includes('/')) {
            const slug = modelObj.id.split('/').pop()!
            if (!map.has(slug)) map.set(slug, modelObj)
            if (!map.has(slug.toLowerCase())) map.set(slug.toLowerCase(), modelObj)
          }
        }
      }
      cachedModelsDevMap = map
      return map
    } catch {
      return new Map()
    } finally {
      modelsDevPromise = null
    }
  })()

  return modelsDevPromise
}
