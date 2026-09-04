import { PERMISSION_OPTIONS, type useModeMenu } from './useModeMenu'

type ModeMenuProps = {
  pos: NonNullable<ReturnType<typeof useModeMenu>['modeMenuPos']>
  menu: ReturnType<typeof useModeMenu>
}

/**
 * 运行模式与权限菜单弹出层（composer 底部右下角）。
 * 分为 MODE（Plan 独立开关）与 PERMISSION（权限单选）两组，行样式与交互完全统一。
 */
export function ModeMenu({ pos, menu }: ModeMenuProps) {
  const { currentPermId, inPlan, switchPerm, togglePlan } = menu

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
      {/* MODE 分组标题 */}
      <div className="shrink-0 border-b border-gn-prompt-border px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider text-gn-muted">
        MODE
      </div>

      {/* Plan 模式独立开关行（样式与下方列表完全统一） */}
      <div>
        <button
          type="button"
          onClick={() => togglePlan()}
          className={`block w-full cursor-pointer px-3 py-2 text-left transition-colors hover:bg-gn-bg-highlight/80 ${
            inPlan ? 'bg-gn-bg-highlight/60' : ''
          }`}
        >
          <div className="flex items-center justify-between">
            <span
              className={`text-[12px] ${
                inPlan ? 'font-semibold text-gn-fg' : 'font-medium text-gn-fg2'
              }`}
            >
              Plan
            </span>
            {inPlan && (
              <span className="font-mono text-[10px] text-gn-orange">
                生效中
              </span>
            )}
          </div>
          <div className="mt-0.5 text-[11px] leading-[1.3] text-gn-muted">
            只读探索并规划方案，可与任意权限叠加
          </div>
        </button>
      </div>

      {/* PERMISSION 分组标题 */}
      <div className="shrink-0 border-t border-b border-gn-prompt-border/40 px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider text-gn-muted">
        PERMISSION
      </div>

      {/* 权限单选列表 */}
      <div className="min-h-0 flex-1 overflow-y-auto touch-pan-y overscroll-contain pb-1">
        {PERMISSION_OPTIONS.map((item) => {
          const active = currentPermId === item.id
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => switchPerm(item.id)}
              className={`block w-full cursor-pointer border-b border-gn-prompt-border/30 px-3 py-2 text-left transition-colors last:border-b-0 hover:bg-gn-bg-highlight/80 ${
                active ? 'bg-gn-bg-highlight/60' : ''
              }`}
            >
              <div className="flex items-center justify-between">
                <span
                  className={`text-[12px] ${
                    active ? 'font-semibold text-gn-fg' : 'font-medium text-gn-fg2'
                  }`}
                >
                  {item.label}
                </span>
                {active && (
                  <span className="font-mono text-[10px] text-gn-cyan">
                    生效中
                  </span>
                )}
              </div>
              <div className="mt-0.5 text-[11px] leading-[1.3] text-gn-muted">
                {item.desc}
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}
