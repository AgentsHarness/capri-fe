import { useEffect, useRef } from 'react'
import type { SlashCommand, SlashMatch } from '../commands/registry'

/**
 * TUI slash command menu — floats above the composer while the input
 * starts with "/". Fuzzy-filtered command rows; ↑/↓ (or hover) pick,
 * Enter/Tab execute. When nothing matches, the footer shows the
 * unknown-command hint: Enter then takes the plain slash-line path
 * (error row appended, NEVER sent to the agent).
 */
export function SlashMenu({
  input,
  selected,
  matches,
  onHover,
  onPick,
}: {
  input: string
  selected: number
  matches: SlashMatch[]
  onHover: (i: number) => void
  onPick: (cmd: SlashCommand) => void
}) {
  const listRef = useRef<HTMLDivElement>(null)
  // The menu is only shown while the command word is being typed (no
  // space yet), but keep the filter defensive against any stray text.
  const query = input.slice(1).split(/\s/)[0]
  const unknown = query.length > 0 && matches.length === 0

  // Keep the highlighted row visible while ↑/↓ walks the list.
  useEffect(() => {
    const el = listRef.current?.querySelector('[data-sel="1"]')
    el?.scrollIntoView({ block: 'nearest' })
  }, [selected, matches.length])

  return (
    <div className="absolute bottom-full left-0 right-0 z-40 mb-1 overflow-hidden rounded border border-gn-prompt-border-active bg-gn-bg-dark shadow-2xl">
      <div className="flex items-center justify-between border-b border-gn-prompt-border px-3 py-1.5">
        <span className="text-[11px] font-bold text-gn-fg2">命令</span>
        <span className="text-[10px] text-gn-muted">/ 前缀触发 · 本地执行</span>
      </div>
      <div ref={listRef} className="gn-no-scrollbar max-h-56 overflow-y-auto py-0.5">
        {matches.map((m, i) => (
          <button
            key={m.cmd.name}
            type="button"
            data-sel={i === selected ? '1' : '0'}
            onMouseEnter={() => onHover(i)}
            onClick={() => onPick(m.cmd)}
            className={`block w-full px-3 py-[5px] text-left transition-colors ${
              i === selected ? 'bg-gn-bg-highlight' : ''
            }`}
          >
            <span className="font-mono text-[12px] text-gn-cyan">
              /{m.cmd.name}
            </span>
            {(m.cmd.aliases ?? []).map((a) => (
              <span
                key={a}
                className="ml-1 font-mono text-[10px] text-gn-gray-dim"
              >
                /{a}
              </span>
            ))}
            {m.cmd.argHint && (
              <span className="ml-1 font-mono text-[10px] text-gn-gray-dim">
                {m.cmd.argHint}
              </span>
            )}
            <span className="ml-2 text-[11px] text-gn-muted">
              {m.cmd.description}
            </span>
          </button>
        ))}
      </div>
      <div className="border-t border-gn-prompt-border px-3 py-[3px] text-[10px]">
        {unknown ? (
          <span className="text-gn-red">
            未知命令 /{query} — Enter 不会发送，仅追加错误提示
          </span>
        ) : (
          <span className="text-gn-muted">
            ↑/↓ 选择 · Enter/Tab 执行 · Esc 关闭
          </span>
        )}
      </div>
    </div>
  )
}
