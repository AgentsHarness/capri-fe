import type { ModelOption } from '../../api/types'
import type { useModelMenu } from './useModelMenu'

type ModelMenuProps = {
  models: ModelOption[]
  /** useModelMenu 计算的固定定位矩形（视口钳制）。 */
  pos: NonNullable<ReturnType<typeof useModelMenu>['modelMenuPos']>
  menu: ReturnType<typeof useModelMenu>
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
      className="pointer-events-auto fixed z-50 overflow-y-auto rounded border border-gn-prompt-border-active bg-gn-bg-base shadow-2xl"
      style={{
        bottom: pos.bottom,
        right: pos.right,
        maxHeight: pos.maxH,
        width: pos.width,
      }}
    >
      <div className="sticky top-0 z-10 border-b border-gn-prompt-border bg-gn-bg-dark px-3 py-1.5 text-[11px] font-bold text-gn-fg2">
        切换模型
      </div>
      {models.map((m) => {
        const efforts = m.reasoningEfforts ?? []
        const active = modelActive(m)
        const defEffort = efforts.find((e) => e.default) ?? efforts[0]
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
                          ? 'border-gn-prompt-border-active bg-gn-bg-hover text-gn-magenta'
                          : 'border-gn-prompt-border text-gn-muted hover:border-gn-prompt-border-active hover:bg-gn-bg-highlight hover:text-gn-fg'
                      }`}
                    >
                      {e.label || e.value}
                    </button>
                  )
                })}
              </div>
            )}
          </div>
        )
      })}
      <div className="sticky bottom-0 flex items-center gap-2 border-t border-gn-prompt-border bg-gn-bg-dark px-3 py-1.5">
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
