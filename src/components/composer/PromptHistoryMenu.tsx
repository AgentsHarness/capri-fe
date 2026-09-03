import { useEffect, useRef } from 'react'
import type { HistoryItem } from './promptHistory'
import { menuRowClass } from './menuRow'

/**
 * TUI prompt history recall panel (↑ on empty input) — 交互与斜杠/文件
 * 浮层对齐：同一套行样式（menuRowClass）、表头右侧 `位置/总数`、选中行
 * 自动滚进可视区、鼠标按下不抢 textarea 焦点（Esc/继续打字仍可用）。
 *
 * 列表按 TUI 顺序渲染（history_search.rs 反转存储的 newest-first 数组）：
 * 最旧在顶、最新在底；打开时选中最新一条（底部），↑ 沿列表向上走向更旧，
 * ↓ 向下走向更新，越过最新一条关闭面板（键盘路由在 Composer 的 onKeyDown）。
 * `!` 前缀的历史项是 shell 命令，填入后重新进入 shell 模式
 * （docs: "Recalled ! shell commands re-enter shell mode"）。
 */
export function PromptHistoryMenu({
  history,
  selected,
  onHover,
  onPick,
}: {
  history: HistoryItem[]
  selected: number
  onHover: (i: number) => void
  onPick: (item: HistoryItem) => void
}) {
  const listRef = useRef<HTMLDivElement>(null)

  // Keep the highlighted row visible while ↑/↓ walks the list.
  useEffect(() => {
    const el = listRef.current?.querySelector('[data-sel="1"]')
    el?.scrollIntoView({ block: 'nearest' })
  }, [selected, history.length])

  return (
    <div className="absolute bottom-full left-0 right-0 z-40 mb-1 gn-popover">
      <div className="flex items-center justify-between gap-2 border-b border-gn-prompt-border px-3 py-1.5">
        <span className="text-[11px] font-bold text-gn-fg2">提示历史</span>
        {/* 位置/总数放表头右侧（与斜杠菜单同一处）。 */}
        {history.length > 0 ? (
          <span className="shrink-0 font-mono text-[10px] text-gn-gray-dim">
            {Math.min(selected + 1, history.length)}/{history.length}
          </span>
        ) : (
          <span className="min-w-0 truncate text-[10px] text-gn-muted">↑ 前缀触发</span>
        )}
      </div>
      <div ref={listRef} className="gn-no-scrollbar max-h-56 overflow-y-auto">
        {history.map((h, i) => {
          const sel = i === selected
          return (
            <button
              key={`${h.ts}-${i}`}
              type="button"
              data-sel={sel ? '1' : '0'}
              onMouseDown={(e) => {
                // 鼠标点行不要把焦点从 textarea 抢走（Esc/继续打字仍可用）。
                e.preventDefault()
              }}
              onMouseEnter={() => onHover(i)}
              onClick={() => onPick(h)}
              className={menuRowClass(sel)}
              title={`${h.shell ? '! ' : ''}${h.text}\n${new Date(h.ts).toLocaleString()}`}
            >
              {h.shell && (
                <span className="shrink-0 font-mono text-[10px] leading-[18px] text-gn-cyan">
                  {'! '}
                </span>
              )}
              <span
                className={`min-w-0 flex-1 truncate text-[11.5px] leading-[18px] ${
 sel ? 'font-semibold text-gn-fg' : 'text-gn-fg2'
                }`}
              >
                {h.text}
              </span>
              {sel && (
                <span
                  aria-hidden
                  className="ml-2 shrink-0 font-mono text-[10px] leading-[18px] text-gn-gray"
                >
                  ↵
                </span>
              )}
            </button>
          )
        })}
      </div>
      <div className="flex items-center justify-between gap-2 border-t border-gn-prompt-border px-3 py-[3px] text-[10px] text-gn-muted">
        <span
          className="min-w-0 truncate"
          title="↑/↓ 选择 · Enter/Tab 填入 · Esc 关闭；填入 ! 前缀的历史会重新进入 shell 模式"
        >
          ↑/↓ 选择 · Enter/Tab 填入 · Esc 关闭
        </span>
      </div>
    </div>
  )
}
