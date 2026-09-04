import { MODE_OPTIONS, type useModeMenu } from './useModeMenu'

type ModeMenuProps = {
  pos: NonNullable<ReturnType<typeof useModeMenu>['modeMenuPos']>
  menu: ReturnType<typeof useModeMenu>
}

/**
 * 运行模式切换菜单弹出层（composer 底部 caption 模式槽）。
 * 纯文本选项，无图标，对齐 ModelMenu 的定位与视觉风格。
 */
export function ModeMenu({ pos, menu }: ModeMenuProps) {
  const { currentModeId, switchMode } = menu

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
        切换运行模式
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto touch-pan-y overscroll-contain py-1">
        {MODE_OPTIONS.map((item) => {
          const active = currentModeId === item.id
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => switchMode(item.id)}
              className={`block w-full border-b border-gn-prompt-border/30 px-3 py-2 text-left transition-colors last:border-b-0 hover:bg-gn-bg-highlight/80 ${
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
