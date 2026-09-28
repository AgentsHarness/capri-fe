import type { CustomModelConfig } from '../api/types'

/**
 * 「从其他 Host 导入自定义模型」的纯逻辑：分类源条目相对于目标 Host
 * 现有配置的状态，并构造写入 payload。
 *
 * 安全约定（与实现同址，便于对照）：
 * - 密钥类字段只在请求体里流动，不落 localStorage、不进 URL、不进 toast；
 * - 只有「目标上不存在」的条目默认勾选；覆盖必须用户逐条显式勾；
 * - 关闭密钥复制时，若目标是覆盖且原来有密钥，则保留目标原值——否则一次
 *   「只想同步 slug / 上下文窗口」的导入会静默清掉目标上的密钥。
 */

/** 含凭据的字段：默认随导入复制，关闭开关后不写目标。 */
export const SECRET_FIELDS = [
  'api_key',
  'extra_headers',
  'env_http_headers',
  'query_params',
] as const

export type SecretField = (typeof SECRET_FIELDS)[number]

/** 条目相对目标 Host 的可导入状态。 */
export type ImportStatus = 'new' | 'overwrite' | 'slug-conflict' | 'invalid'

export type ImportRow = {
  /** config.toml 小节键 `[model.<id>]`。 */
  id: string
  cfg: CustomModelConfig
  status: ImportStatus
  /** 冲突 / 无效的原因（给用户看的短句）。 */
  reason?: string
}

const isSetValue = (v: unknown): boolean => {
  if (v === undefined || v === null || v === '') return false
  if (Array.isArray(v)) return v.length > 0
  if (typeof v === 'object') return Object.keys(v as object).length > 0
  return true
}

/** 这条配置里有没有会带凭据的字段（列表行标注用）。 */
export function hasSecretFields(cfg: CustomModelConfig): boolean {
  const record = cfg as Record<string, unknown>
  return SECRET_FIELDS.some((k) => isSetValue(record[k]))
}

/**
 * 逐条判定源条目导入目标 Host 时的状态。
 * - `invalid`：缺 `model`（路由 slug）或 `base_url`——host 侧必拒；
 * - `slug-conflict`：同一个 routing slug 只能配置一个 id（下列两种任一）。
 *   目标上该 slug 已属于别的 id；或源 Host 自己就有多条同 slug——导过去
 *   后第二条必被 host 拒（grok 按 key 组织 `[model.*]`，同 slug 两条会让
 *   默认模型 / `/model <slug>` 解析歧义）。源内重复时保留第一条，其余标出；
 * - `overwrite`：目标已有同 id 小节（整节替换语义）；
 * - `new`：目标上没有。
 */
export function classifyImportRows(
  source: CustomModelConfig[],
  target: CustomModelConfig[],
): ImportRow[] {
  const targetById = new Map<string, CustomModelConfig>()
  for (const t of target) targetById.set(t.id, t)
  const slugOwners = new Map<string, string>()
  for (const t of target) {
    const slug = t.model?.trim()
    if (slug) slugOwners.set(slug, t.id)
  }
  // 源内 slug 首次出现的 id：后续同 slug 条目导入时会被 host 拒。
  const firstSourceWithSlug = new Map<string, string>()

  return source.map((cfg) => {
    const id = cfg.id?.trim()
    if (!id) return { id: cfg.id ?? '', cfg, status: 'invalid', reason: '缺少配置节 id' }
    const slug = cfg.model?.trim()
    const baseUrl = cfg.base_url?.trim()
    if (!slug) return { id, cfg, status: 'invalid', reason: '缺少 model（路由 slug）' }
    if (!baseUrl) return { id, cfg, status: 'invalid', reason: '缺少 base_url' }
    const slugOwner = slugOwners.get(slug)
    if (slugOwner && slugOwner !== id) {
      return {
        id,
        cfg,
        status: 'slug-conflict',
        reason: `slug「${slug}」已被目标上的 [model.${slugOwner}] 使用`,
      }
    }
    const firstId = firstSourceWithSlug.get(slug)
    if (firstId !== undefined && firstId !== id) {
      return {
        id,
        cfg,
        status: 'slug-conflict',
        reason: `slug「${slug}」在源 Host 上已由 [model.${firstId}] 使用（同 slug 只能导一个）`,
      }
    }
    if (firstId === undefined) firstSourceWithSlug.set(slug, id)
    const existing = targetById.get(id)
    if (existing) return { id, cfg, status: 'overwrite' }
    return { id, cfg, status: 'new' }
  })
}

/**
 * 构造写入目标 Host 的 values（不含 id：host 的 `/api/custom-model` 把它当
 * 小节键单独收）。字段泛化透传（源条目上 FE 类型不认识的键也照抄），
 * host 侧 normalizeConfigValue 继续负责 TOML 数值归一。
 *
 * `includeSecrets=false` 时剥掉 SECRET_FIELDS；若目标这条原来有密钥，则原样
 * 回填，避免「同步其它字段」把目标的凭据冲成空。
 */
export function buildImportValues(
  row: ImportRow,
  targetRow: CustomModelConfig | undefined,
  includeSecrets: boolean,
): Record<string, unknown> {
  const values: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(row.cfg)) {
    if (k === 'id') continue
    values[k] = v
  }
  if (!includeSecrets) {
    const target = (targetRow ?? {}) as Record<string, unknown>
    for (const k of SECRET_FIELDS) {
      delete values[k]
      if (isSetValue(target[k])) values[k] = target[k]
    }
  }
  return values
}
