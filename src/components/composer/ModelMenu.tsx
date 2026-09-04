import type { ModelOption } from '../../api/types'
import type { useModelMenu } from './useModelMenu'

type ModelMenuProps = {
  models: ModelOption[]
  /** useModelMenu 计算的固定定位矩形（视口钳制）。 */
  pos: NonNullable<ReturnType<typeof useModelMenu>['modelMenuPos']>
  menu: ReturnType<typeof useModelMenu>
}

const EFFORT_TOKENS = ['xhigh', 'minimal', 'medium', 'high', 'max', 'low', 'none'] as const

function normalizeToken(s: string): string {
  return s.trim().toLowerCase().replace(/[_\s-]/g, '')
}

/**
 * 过滤/规范化 effort 标签字符：value/id 本身已是标准档位词时直接采用
 * （防止上游错位 label 劫持显示）；否则在 label/value/id 里做子串匹配，
 * 命中即收敛为对应简写档位，避免 "Extra High Effort" 等长字符撑宽弹窗。
 */
export function formatEffortLabel(e: { id?: string; label?: string; value?: string }): string {
  for (const k of ['value', 'id'] as const) {
    const v = e[k]
    if (v && EFFORT_TOKENS.includes(normalizeToken(v) as (typeof EFFORT_TOKENS)[number])) {
      return normalizeToken(v)
    }
  }
  const target = `${e.label || ''} ${e.value || ''} ${e.id || ''}`.toLowerCase()
  if (
    target.includes('xhigh') ||
    target.includes('extra high') ||
    target.includes('extra-high')
  ) {
    return 'xhigh'
  }
  if (target.includes('minimal')) return 'minimal'
  if (target.includes('medium')) return 'medium'
  if (target.includes('high')) return 'high'
  if (target.includes('max')) return 'max'
  if (target.includes('low')) return 'low'
  return e.label || e.value || ''
}

const EFFORT_WEIGHTS: Record<string, number> = {
  none: 0,
  minimal: 1,
  low: 2,
  medium: 3,
  high: 4,
  xhigh: 5,
  max: 6,
}

/** 语义强度权重（从小到大排序）。 */
export function effortWeight(e: { id?: string; label?: string; value?: string }): number {
  const norm = formatEffortLabel(e).toLowerCase()
  return EFFORT_WEIGHTS[norm] ?? 99
}

/**
 * /model 模型菜单弹出层（composer 底部 caption 模型槽）：模型行 +
 * reasoning-effort chips + 「设为默认」勾选。定位/开关/激活判定归
 * useModelMenu；switchModel 的 effort 保留逻辑（重选同一模型时若仍
 * 提供当前 effort 则沿用，否则落到默认档）在菜单行内组装。
 */
export function ModelMenu({ models, pos, menu }: ModelMenuProps) {
  const {
    reasoningEffort,
    setAsDefault,
    setSetAsDefault,
    switchModel,
    effortActive,
    modelActive,
  } = menu
  return (
    <div
      className="pointer-events-auto fixed z-50 flex flex-col gn-modal-panel"
      style={{
        bottom: pos.bottom,
        right: pos.right,
        maxHeight: pos.maxH,
        width: pos.width,
      }}
    >
      <div className="shrink-0 border-b border-gn-prompt-border px-3 py-1.5 text-[11px] font-bold text-gn-fg2">
        切换模型
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto touch-pan-y overscroll-contain">
        {models.map((m) => {
          const rawEfforts = m.reasoningEfforts ?? []
          const defEffort = rawEfforts.find((e) => e.default) ?? rawEfforts[0]
          const efforts = [...rawEfforts].sort(
            (a, b) => effortWeight(a) - effortWeight(b),
          )
          const active = modelActive(m)
          return (
            <div
              key={m.modelId}
              className={`border-b border-gn-prompt-border/40 px-3 py-1.5 ${
                active ? 'bg-gn-bg-highlight/60' : ''
              }`}
            >
              <button
                type="button"
                onClick={() =>
                  switchModel(
                    m.modelId,
                    // Keep current effort when re-picking same model
                    // if still offered; else fall back to default.
                    active && reasoningEffort
                      ? efforts.find(
                          (e) =>
                            e.value === reasoningEffort ||
                            e.id === reasoningEffort,
                        )?.value ?? defEffort?.value
                      : defEffort?.value,
                  )
                }
                className="block w-full text-left hover:opacity-90"
              >
                <span
                  className={`text-[12px] font-medium ${
                    active ? 'text-gn-magenta' : 'text-gn-fg'
                  }`}
                >
                  {m.name || m.modelId}
                </span>
              </button>
              {efforts.length > 0 && (
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {efforts.map((e) => {
                    const on = active && effortActive(e)
                    return (
                      <button
                        key={e.id || e.value}
                        type="button"
                        onClick={() => switchModel(m.modelId, e.value)}
                        title={
                          e.label !== e.value ? `${e.label} (${e.value})` : e.value
                        }
                        className={`rounded border px-1.5 py-[2px] text-[10px] leading-none transition-colors ${
                          on
                            ? 'border-gn-magenta text-gn-magenta font-medium'
                            : 'border-gn-prompt-border/60 text-gn-muted hover:border-gn-prompt-border-active hover:text-gn-fg'
                        }`}
                      >
                        {formatEffortLabel(e)}
                      </button>
                    )
                  })}
                </div>
              )}
            </div>
          )
        })}
      </div>
      <div className="shrink-0 flex items-center gap-2 border-t border-gn-prompt-border bg-gn-bg-dark px-3 py-1.5">
        <input
          id="set-as-default-model"
          type="checkbox"
          checked={setAsDefault}
          onChange={(e) => setSetAsDefault(e.target.checked)}
          className="accent-gn-magenta"
        />
        <label
          htmlFor="set-as-default-model"
          className="text-[10.5px] text-gn-muted"
          title="切换时同时写入 ~/.grok/config.toml 的 [models] default（+effort），新会话默认使用"
        >
          设为默认模型（写入 config.toml）
        </label>
      </div>
    </div>
  )
}
