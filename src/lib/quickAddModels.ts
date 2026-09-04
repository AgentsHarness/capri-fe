import type { CustomModelConfig } from '../api/types'

/** 自定义模型稳定排序：优先按显示名（或 id）不区分大小写字母序，相同则按 id 兜底。 */
export function compareCustomModels(a: CustomModelConfig, b: CustomModelConfig): number {
  const nameA = a.name?.trim() || a.id
  const nameB = b.name?.trim() || b.id
  return (
    nameA.localeCompare(nameB, undefined, { sensitivity: 'base' }) ||
    a.id.localeCompare(b.id)
  )
}

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

/** 某一个 provider 上报的一组 effort 档位 */
export interface EffortChoice {
  /** 该组档位值，如 ['low','high','max'] */
  values: string[]
  /** 上报该组的 provider id 列表 */
  providers: string[]
}

/** 同一模型在各 provider 下的 effort 候选组：按上报 provider 数降序 */
export interface ModelsDevEfforts {
  groups: EffortChoice[]
}

/** 某一个 provider 上报的上下文/输出上限组合 */
export interface LimitChoice {
  context?: number
  output?: number
  /** 上报该组的 provider id 列表 */
  providers: string[]
}

/** 同一模型在各 provider 下的 limit 组合：按上报 provider 数降序 */
export interface ModelsDevLimits {
  groups: LimitChoice[]
}

export interface DiscoveredModel {
  remoteId: string
  configKey: string
  name: string
  contextWindow: number
  maxCompletionTokens?: number
  supportsReasoning: boolean
  reasoningEfforts?: Array<{ value: string; label?: string; description?: string; default?: boolean }>
  /** 各 provider 上报的 effort 档位组（按上报 provider 数降序），供用户整组勾选 */
  effortChoices?: EffortChoice[]
  /** 当前选中的 effort values（默认取上报 provider 最多的一组） */
  selectedEfforts?: string[]
  /** 各 provider 上报的 context/output 组合（按上报 provider 数降序），供用户下拉选择 */
  limitChoices?: LimitChoice[]
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
  return Array.from(map.values()).sort(
    (a, b) => b.count - a.count || a.baseUrl.localeCompare(b.baseUrl),
  )
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
/** remoteId（小写）-> 各 provider 上报的 effort 组（按 provider 数降序） */
let cachedEffortChoices: Map<string, ModelsDevEfforts> | null = null
/** remoteId（小写）-> 各 provider 上报的 context/output 组（按 provider 数降序） */
let cachedLimitChoices: Map<string, ModelsDevLimits> | null = null

/** 聚合：signature -> provider ids → 按 provider 数降序的 limit 候选组 */
function buildLimitChoices(
  limits: Map<string, Map<string, LimitChoice>>,
): Map<string, ModelsDevLimits> {
  const out = new Map<string, ModelsDevLimits>()
  for (const [key, sigMap] of limits) {
    const groups: LimitChoice[] = Array.from(sigMap.values()).sort(
      (a, b) => b.providers.length - a.providers.length,
    )
    out.set(key, { groups })
  }
  return out
}

/** 聚合：signature -> values 与 signature -> provider ids → 按 provider 数降序的候选组 */
function buildEffortChoices(
  candidates: Map<string, Map<string, string[]>>,
  providers: Map<string, Map<string, string[]>>,
): Map<string, ModelsDevEfforts> {
  const out = new Map<string, ModelsDevEfforts>()
  for (const [key, sigMap] of candidates) {
    const provMap = providers.get(key) ?? new Map<string, string[]>()
    const groups: EffortChoice[] = Array.from(sigMap.entries())
      .map(([sig, values]) => ({ values, providers: provMap.get(sig) ?? [] }))
      .sort((a, b) => b.providers.length - a.providers.length)
    out.set(key, { groups })
  }
  return out
}

/** 从 models.dev 拉取全量模型元数据并建立快速索引 Map */
export async function getModelsDevMap(): Promise<Map<string, ModelsDevModel>> {
  if (cachedModelsDevMap) return cachedModelsDevMap
  if (modelsDevPromise) return modelsDevPromise

  modelsDevPromise = (async () => {
    try {
      const res = await fetch('https://models.dev/api.json', { signal: AbortSignal.timeout(8000) })
      if (!res.ok) return new Map()
      const data = (await res.json()) as Record<
        string,
        { models?: Record<string, ModelsDevModel> }
      >
      const map = new Map<string, ModelsDevModel>()
      // remoteId（小写）-> 各 provider 上报的 effort 组；slug 键只收第一次命中（与 map 同规则）
      const effortCandidates = new Map<string, Map<string, string[]>>() // key -> (signature -> values)
      const effortProviders = new Map<string, Map<string, string[]>>() // key -> (signature -> provider ids)
      // remoteId（小写）-> 各 provider 上报的 context/output 组
      const limitCandidates = new Map<string, Map<string, LimitChoice>>() // key -> (signature -> choice)
      const seenSlugs = new Set<string>()
      for (const [providerId, provider] of Object.entries(data)) {
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
          // 本模型的索引键：完整 id 与（未占用时）slug，effort/limit 聚合共用
          const keys = [modelObj.id.toLowerCase()]
          if (modelObj.id.includes('/')) {
            const slug = modelObj.id.split('/').pop()!.toLowerCase()
            if (!seenSlugs.has(slug)) keys.push(slug)
          }

          // context/output 组合聚合
          const ctx = modelObj.limit?.context
          const out = modelObj.limit?.output
          if (typeof ctx === 'number' || typeof out === 'number') {
            const sig = `${ctx ?? ''}/${out ?? ''}`
            for (const key of keys) {
              if (!limitCandidates.has(key)) limitCandidates.set(key, new Map())
              const sigMap = limitCandidates.get(key)!
              const choice = sigMap.get(sig) ?? {
                context: typeof ctx === 'number' ? ctx : undefined,
                output: typeof out === 'number' ? out : undefined,
                providers: [],
              }
              if (!choice.providers.includes(providerId)) choice.providers.push(providerId)
              sigMap.set(sig, choice)
            }
          }

          // effort 档位组聚合
          const effortOpt = modelObj.reasoning_options?.find((o) => o.type === 'effort')
          if (effortOpt?.values?.length) {
            const sig = effortOpt.values.join(',')
            for (const key of keys) {
              if (!effortCandidates.has(key)) effortCandidates.set(key, new Map())
              if (!effortProviders.has(key)) effortProviders.set(key, new Map())
              effortCandidates.get(key)!.set(sig, effortOpt.values)
              const provs = effortProviders.get(key)!.get(sig) ?? []
              if (!provs.includes(providerId)) provs.push(providerId)
              effortProviders.get(key)!.set(sig, provs)
            }
          }
          if (modelObj.id.includes('/')) {
            seenSlugs.add(modelObj.id.split('/').pop()!.toLowerCase())
          }
        }
      }
      cachedModelsDevMap = map
      cachedEffortChoices = buildEffortChoices(effortCandidates, effortProviders)
      cachedLimitChoices = buildLimitChoices(limitCandidates)
      return map
    } catch {
      return new Map()
    } finally {
      modelsDevPromise = null
    }
  })()

  return modelsDevPromise
}

/** 测试辅助：清空 models.dev 缓存（生产代码不应调用） */
export function resetModelsDevCacheForTest(): void {
  cachedModelsDevMap = null
  cachedEffortChoices = null
  cachedLimitChoices = null
  modelsDevPromise = null
}

/**
 * 取某模型在各 provider 下上报的 effort 档位组（按上报 provider 数降序）。
 * 匹配优先级与 getModelsDevMap 索引一致：完整 id > 去前缀 slug。
 */
export function getEffortCandidates(remoteId: string): ModelsDevEfforts | undefined {
  if (!cachedEffortChoices) return undefined
  return (
    cachedEffortChoices.get(remoteId.toLowerCase()) ||
    cachedEffortChoices.get(remoteId.split('/').pop()?.toLowerCase() || '')
  )
}

/**
 * 取某模型在各 provider 下上报的 context/output 组合（按上报 provider 数降序）。
 * 匹配优先级与 getModelsDevMap 索引一致：完整 id > 去前缀 slug。
 */
export function getLimitCandidates(remoteId: string): ModelsDevLimits | undefined {
  if (!cachedLimitChoices) return undefined
  return (
    cachedLimitChoices.get(remoteId.toLowerCase()) ||
    cachedLimitChoices.get(remoteId.split('/').pop()?.toLowerCase() || '')
  )
}