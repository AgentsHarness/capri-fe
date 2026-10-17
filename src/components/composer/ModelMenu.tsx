import type { ModelOption } from '../../api/types'
import {
  activeContextWindow,
  contextWindowOptions,
  formatContextWindow,
} from '../../store/chat/model'
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
 * reasoning-effort chips + 每个模型自己声明的上下文窗口 chips +
 * 「设为默认」勾选。定位/开关/激活判定归 useModelMenu；effort 保留逻辑
 * （重选同一模型时若仍提供当前 effort 则沿用，否则落到默认档）在菜单行内
 * 组装。窗口 chips 只在目录给出 `_meta.contextWindows`（多于一个）时出现，
 * 且只渲染在那一行内。
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
          // 该模型自己声明的可选窗口；只在该行内渲染，避免把别的模型的
          // 窗口带到不支持它的模型上（agent 会整次拒收）。
          const windows = contextWindowOptions(m)
          const activeWindow = active ? activeContextWindow(m) : undefined
          // 该模型需要挑的类别数：有档位菜单算一类，窗口菜单（>1 个）算一类。
          // 非选中模型要点齐这么多类才提交切换（pickOption 的判据）。
          const categories = (efforts.length > 0 ? 1 : 0) + (windows.length > 0 ? 1 : 0)
          // 选中模型重选档位时沿用当前档位（还在菜单里就保留），否则用默认档。
          const keepEffort =
            active && reasoningEffort
              ? efforts.find(
                  (e) => e.value === reasoningEffort || e.id === reasoningEffort,
                )?.value ?? defEffort?.value
              : defEffort?.value
          // 草稿态高亮：非选中模型只亮用户已点的选项，不亮目录默认值——
          // 否则会被读成"已经选好了"。
          const draftEffort = active ? undefined : menu.draftEffort(m.modelId)
          const draftWindow = active ? undefined : menu.draftWindow(m.modelId)
          return (
            <div
              key={m.modelId}
              className={`border-b border-gn-prompt-border/40 px-3 py-1.5 ${
                active ? 'bg-gn-bg-highlight/60' : ''
              }`}
            >
              <button
                type="button"
                // 不指定窗口＝保持会话当前选择（agent
                // SwitchContextWindow::Preserve：目标模型支持就沿用，否则用
                // 它自己的默认窗口）。与 TUI 直接选模型行一致。
                // 非选中模型有类别要挑时，点名字不提交：等 chip 点齐。
                onClick={() => {
                  if (!active && categories > 0) return
                  switchModel(m.modelId, keepEffort)
                }}
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
                    const on = active
                      ? effortActive(e)
                      : draftEffort != null &&
                        (draftEffort === e.value || draftEffort === e.id)
                    return (
                      <button
                        key={e.id || e.value}
                        type="button"
                        onClick={() =>
                          active
                            ? switchModel(m.modelId, e.value)
                            : menu.pickOption(
                                m.modelId,
                                categories,
                                { effort: e.value },
                                defEffort?.value,
                              )
                        }
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
              {windows.length > 0 && (
                <div className="mt-1.5 flex flex-wrap items-center gap-1">
                  {windows.map((w) => {
                    const on = active ? activeWindow === w : draftWindow === w
                    return (
                      <button
                        key={w}
                        type="button"
                        onClick={() =>
                          active
                            ? switchModel(m.modelId, keepEffort, w)
                            : menu.pickOption(
                                m.modelId,
                                categories,
                                { window: w },
                                defEffort?.value,
                              )
                        }
                        title={`${w.toLocaleString()} tokens`}
                        className={`rounded border px-1.5 py-[2px] text-[10px] leading-none transition-colors ${
                          on
                            ? 'border-gn-cyan font-medium text-gn-cyan'
                            : 'border-gn-prompt-border/60 text-gn-muted hover:border-gn-prompt-border-active hover:text-gn-fg'
                        }`}
                      >
                        {formatContextWindow(w)}
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
