import type { ModelOption } from '../../api/types'
import type { ChatState } from './types'

/**
 * Display name for a model id via the current catalog (id fallback).
 */
export function modelDisplayName(getStore: () => ChatState, modelId: string): string {
  return getStore().models.find((m) => m.modelId === modelId)?.name || modelId
}

/**
 * `模型名(effort)` — parens only when an effort is known.
 */
export function modelLabel(name: string, effort?: string | null): string {
  return effort ? `${name}(${effort})` : name
}
export const BUILTIN_REASONING_EFFORTS: ModelOption['reasoningEfforts'] = [
  { id: 'xhigh', label: 'xhigh', value: 'xhigh' },
  { id: 'high', label: 'high', value: 'high' },
  { id: 'medium', label: 'medium', value: 'medium' },
  { id: 'low', label: 'low', value: 'low' },
]

/**
 * Resolve a SessionModelState from either:
 *   - the top-level `models` field on session/new|load (preferred), or
 *   - agentInfo / agentInfo._meta.modelState (initialize snapshot).
 *
 * Direct SessionModelState shape: { currentModelId, availableModels }.
 */
export function asModelState(...sources: unknown[]): Record<string, unknown> | undefined {
  for (const src of sources) {
    if (!src || typeof src !== 'object') continue
    const o = src as Record<string, unknown>
    // Direct SessionModelState
    if (
      o.currentModelId != null ||
      o.current_model_id != null ||
      Array.isArray(o.availableModels) ||
      Array.isArray(o.available_models)
    ) {
      return {
        currentModelId: o.currentModelId ?? o.current_model_id,
        availableModels: o.availableModels ?? o.available_models,
        reasoningEffort: o.reasoningEffort ?? o.reasoning_effort,
      }
    }
    const meta = o._meta as Record<string, unknown> | undefined
    const nested = (meta?.modelState ?? o.modelState) as
      | Record<string, unknown>
      | undefined
    if (nested && typeof nested === 'object') {
      return {
        currentModelId: nested.currentModelId ?? nested.current_model_id,
        availableModels: nested.availableModels ?? nested.available_models,
        reasoningEffort: nested.reasoningEffort ?? nested.reasoning_effort,
      }
    }
  }
  return undefined
}

/**
 * Build a store partial for models + current caption fields.
 * `sessionModels` (from session/new|load) wins over `agentInfo`.
 * When neither yields a model name, returns only the catalog if present.
 */
export function applySessionModelState(
  sessionModels: unknown,
  agentInfo: unknown,
): Partial<Pick<ChatState, 'models' | 'modelName' | 'reasoningEffort'>> {
  // Prefer session models for both catalog and current selection.
  const primary = asModelState(sessionModels)
  const fallback = asModelState(agentInfo)
  const ms = primary ?? fallback
  const catalogSrc = sessionModels ?? agentInfo
  const list = extractModelsFromModelState(ms) 
  // Also try agentInfo path for catalog if ms was empty
  const models =
    list.length > 0
      ? list
      : extractModelsFromAgentInfo(catalogSrc)

  const name =
    extractModelNameFromState(ms) ??
    extractModelFromAgentInfo(agentInfo)
  const effort =
    extractEffortFromState(ms) ??
    extractEffortFromAgentInfo(agentInfo)

  const out: Partial<Pick<ChatState, 'models' | 'modelName' | 'reasoningEffort'>> =
    {}
  if (models.length > 0) out.models = models
  if (name) out.modelName = name
  // Always write effort when we have a session models payload so a restored
  // session without effort does not keep the previous session's suffix.
  if (sessionModels != null) {
    out.reasoningEffort = effort
  } else if (effort) {
    out.reasoningEffort = effort
  }
  return out
}

export function extractModelsFromModelState(
  ms: Record<string, unknown> | undefined,
): ModelOption[] {
  if (!ms) return []
  return extractModelsFromAgentInfo({ modelState: ms })
}

export function extractModelNameFromState(
  ms: Record<string, unknown> | undefined,
): string | undefined {
  if (!ms) return undefined
  return extractModelFromAgentInfo({ modelState: ms })
}

export function extractEffortFromState(
  ms: Record<string, unknown> | undefined,
): string | undefined {
  if (!ms) return undefined
  return extractEffortFromAgentInfo({ modelState: ms })
}

/** Normalize one effort entry from model meta (id/value/label variants). */
export function normalizeEffortOption(raw: unknown): {
  id: string
  label: string
  value: string
  default?: boolean
} | null {
  if (typeof raw === 'string' && raw.trim()) {
    const v = raw.trim()
    return { id: v, label: v, value: v }
  }
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const value =
    (typeof o.value === 'string' && o.value.trim()) ||
    (typeof o.id === 'string' && o.id.trim()) ||
    ''
  if (!value) return null
  const id =
    (typeof o.id === 'string' && o.id.trim()) ||
    value
  const label =
    (typeof o.label === 'string' && o.label.trim()) ||
    (typeof o.name === 'string' && o.name.trim()) ||
    id
  return {
    id,
    label,
    value,
    ...(o.default === true ? { default: true } : {}),
  }
}

/** Model catalog from agentInfo._meta.modelState.availableModels. */
export function extractModelsFromAgentInfo(info: unknown): ModelOption[] {
  if (!info || typeof info !== 'object') return []
  const o = info as Record<string, unknown>
  const meta = o._meta as Record<string, unknown> | undefined
  const modelState = (meta?.modelState ?? o.modelState) as
    | Record<string, unknown>
    | undefined
  // Direct SessionModelState passed as `info` itself.
  const list =
    modelState?.availableModels ??
    modelState?.available_models ??
    (Array.isArray(o.availableModels) ? o.availableModels : undefined) ??
    (Array.isArray(o.available_models) ? o.available_models : undefined)
  if (!Array.isArray(list)) return []
  const out: ModelOption[] = []
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue
    const r = raw as Record<string, unknown>
    const id =
      (typeof r.modelId === 'string' && r.modelId) ||
      (typeof r.model_id === 'string' && r.model_id) ||
      ''
    if (!id) continue
    // ACP ModelInfo.meta serializes as `_meta` on some crates and `meta`
    // on others — accept both.
    const rm =
      ((r._meta as Record<string, unknown> | undefined) ??
        (r.meta as Record<string, unknown> | undefined) ??
        {}) as Record<string, unknown>
    const supports =
      rm.supportsReasoningEffort === true ||
      rm.supports_reasoning_effort === true
    const parsed = Array.isArray(rm.reasoningEfforts)
      ? (rm.reasoningEfforts as unknown[])
          .map(normalizeEffortOption)
          .filter((x): x is NonNullable<typeof x> => x != null)
      : Array.isArray(rm.reasoning_efforts)
        ? (rm.reasoning_efforts as unknown[])
            .map(normalizeEffortOption)
            .filter((x): x is NonNullable<typeof x> => x != null)
        : []
    // TUI: supported + empty/unusable list → built-in low..xhigh menu.
    // Unsupported → no effort row (even if a list was present).
    let efforts: ModelOption['reasoningEfforts']
    if (supports) {
      efforts = parsed.length > 0 ? parsed : BUILTIN_REASONING_EFFORTS
    } else if (parsed.length > 0) {
      // Some payloads only ship the list without the bool flag.
      efforts = parsed
    } else {
      efforts = undefined
    }
    out.push({
      modelId: id,
      name: typeof r.name === 'string' ? r.name : undefined,
      description: typeof r.description === 'string' ? r.description : undefined,
      agentType: typeof rm.agentType === 'string' ? rm.agentType : undefined,
      // TUI context bar total: model meta.totalContextTokens (may be a
      // number or a numeric string across crates).
      contextWindow:
        typeof rm.totalContextTokens === 'number'
          ? rm.totalContextTokens
          : typeof rm.totalContextTokens === 'string' &&
              rm.totalContextTokens.trim() !== '' &&
              !Number.isNaN(Number(rm.totalContextTokens))
            ? Number(rm.totalContextTokens)
            : undefined,
      reasoningEffort:
        typeof rm.reasoningEffort === 'string'
          ? rm.reasoningEffort
          : typeof rm.reasoning_effort === 'string'
            ? rm.reasoning_effort
            : undefined,
      supportsReasoningEffort: supports || (efforts != null && efforts.length > 0),
      reasoningEfforts: efforts,
    })
  }
  return out
}

/** Current reasoning effort from agentInfo._meta.modelState (if any). */
export function extractEffortFromAgentInfo(info: unknown): string | undefined {
  if (!info || typeof info !== 'object') return undefined
  const o = info as Record<string, unknown>
  const meta = o._meta as Record<string, unknown> | undefined
  const ms = (meta?.modelState ?? o.modelState) as
    | Record<string, unknown>
    | undefined
  if (!ms) return undefined
  for (const k of ['reasoningEffort', 'reasoning_effort', 'currentReasoningEffort']) {
    const v = ms[k]
    if (typeof v === 'string' && v.trim()) return v.trim()
  }
  // Fall back to the current model's own default effort meta.
  const cur = ms.currentModelId ?? ms.current
  const avail = ms.availableModels
  if (typeof cur === 'string' && Array.isArray(avail)) {
    const m = avail.find((x) => {
      if (x == null || typeof x !== 'object') return false
      const r = x as Record<string, unknown>
      return r.modelId === cur || r.model_id === cur
    }) as Record<string, unknown> | undefined
    const rm =
      ((m?._meta as Record<string, unknown> | undefined) ??
        (m?.meta as Record<string, unknown> | undefined) ??
        {}) as Record<string, unknown>
    for (const k of ['reasoningEffort', 'reasoning_effort']) {
      const v = rm[k]
      if (typeof v === 'string' && v.trim()) return v.trim()
    }
    const list = Array.isArray(rm.reasoningEfforts)
      ? rm.reasoningEfforts
      : Array.isArray(rm.reasoning_efforts)
        ? rm.reasoning_efforts
        : null
    if (list) {
      const def = list.find(
        (x) =>
          x != null &&
          typeof x === 'object' &&
          (x as Record<string, unknown>).default === true,
      ) as Record<string, unknown> | undefined
      const pick = def ?? (list[0] as Record<string, unknown> | undefined)
      if (pick) {
        const v = pick.value ?? pick.id
        if (typeof v === 'string' && v.trim()) return v.trim()
      }
    }
  }
  return undefined
}

/** Pull a display model name from ACP agentInfo when present. */
export function extractModelFromAgentInfo(info: unknown): string | undefined {
  if (!info || typeof info !== 'object') return undefined
  const o = info as Record<string, unknown>
  for (const k of ['modelName', 'model', 'modelId', 'name']) {
    const v = o[k]
    if (typeof v === 'string' && v.trim()) return v.trim()
  }
  // grok nests the model state under _meta.modelState: currentModelId +
  // availableModels (the same place extractModelsFromAgentInfo reads).
  const meta = o._meta as Record<string, unknown> | undefined
  const ms = (meta?.modelState ?? o.modelState) as
    | Record<string, unknown>
    | undefined
  const cur = ms?.currentModelId ?? ms?.current ?? ms?.current_model_id
  if (typeof cur === 'string' && cur.trim()) {
    const list = ms?.availableModels ?? ms?.available_models
    if (Array.isArray(list)) {
      const m = list.find((x) => {
        if (x == null || typeof x !== 'object') return false
        const r = x as Record<string, unknown>
        return r.modelId === cur || r.model_id === cur
      })
      const name = (m as Record<string, unknown> | undefined)?.name
      if (typeof name === 'string' && name.trim()) return name.trim()
    }
    return cur.trim()
  }
  const models = o.models
  if (models && typeof models === 'object') {
    const m = models as Record<string, unknown>
    const cur2 = m.current ?? m.currentModel ?? m.selected
    if (typeof cur2 === 'string' && cur2.trim()) return cur2.trim()
    if (cur2 && typeof cur2 === 'object') {
      const c = cur2 as Record<string, unknown>
      for (const k of ['name', 'modelName', 'id', 'modelId']) {
        const v = c[k]
        if (typeof v === 'string' && v.trim()) return v.trim()
      }
    }
  }
  return undefined
}
