import { Fragment, useEffect, useRef } from 'react'
import type { SlashArgMatch, SlashCommand, SlashMatch } from '../commands/registry'
import type { SlashPhase } from './composer/useSlashMenu'
import { menuActionClass, menuRowClass } from './composer/menuRow'

/**
 * TUI slash command menu — floats above the composer while the input
 * starts with "/". Two phases share one row list (TUI slash/mod.rs keeps a
 * single `SuggestionRow` vec for both):
 * - 命令阶段：模糊过滤命令行，↑/↓（或 hover）选，Enter/Tab 接受。参数
 *   必需的命令接受后只补成 `/name `（尾空格）并翻到下一层；
 * - 参数阶段：命令声明了 `suggestArgs`（TUI `suggest_args`）、敲过分隔符
 *   后进来，行是候选参数，Enter = 选定并执行，Tab = 只填不执行。
 * 命令阶段没有匹配时，这行就不再是命令：页脚说明后 Enter 按原文发给 agent
 * （TUI 会追加一条错误行 — FE 放行）。
 *
 * Skills (source 'skill') sink below the commands behind a group header
 * (TUI 1.0.9: "Skills sink below the commands because there can be far
 * more of them than fit on screen"). Headers are non-interactive rows so
 * the flat `selected` index keeps mapping 1:1 onto `matches`.
 *
 * 选中行是这块面板唯一的状态信号（键盘没有 hover 可依赖），所以一次给
 * 足：选区底色 + 名字加粗提亮 + 行尾 `↵`，页脚再补一个 `N/总数` 位置。
 * 行样式与 @ 文件浮层共用 menuRow。
 */
export function SlashMenu({
  input,
  selected,
  phase = 'command',
  matches,
  argMatches = [],
  argCommand,
  rowCount,
  onHover,
  onPick,
  onLiteral,
}: {
  input: string
  selected: number
  /** 下拉所在层，默认命令层。 */
  phase?: SlashPhase
  /** 命令阶段的行。 */
  matches: SlashMatch[]
  /** 参数阶段的行。 */
  argMatches?: SlashArgMatch[]
  /** 参数阶段所属命令（表头显示 `/name 参数`）。 */
  argCommand?: SlashCommand
  /** 缺省按当前层的行数。 */
  rowCount?: number
  onHover: (i: number) => void
  /** 鼠标点行 = 该行的 Enter（补全还是执行，由 useSlashMenu 判定）。 */
  onPick: (i: number) => void
  /** 在行首补 `\`，把当前 `/…` 草稿声明成原文（键盘等价：行首空格 / `\/`）。 */
  onLiteral?: () => void
}) {
  const listRef = useRef<HTMLDivElement>(null)
  const args = phase === 'args'
  const rows = rowCount ?? (args ? argMatches.length : matches.length)
  // The command filter only ever sees the first word; keep it defensive
  // against any stray text. In the args phase this is the command token.
  const query = input.replace(/^\//, '').split(/\s/)[0]
  const unknown = !args && query.length > 0 && matches.length === 0
  const firstSkillIdx = matches.findIndex((m) => m.cmd.source === 'skill')
  // 「作为原文发送」只在首词真的撞上了命令时才有意义（纯 `/` 或压根不匹配
  // 时，Enter 本来就会执行高亮行 / 把行发出去，不需要这个入口）。参数阶段的
  // 首词必然是一条真命令，所以那一层照给。
  const canLiteral = !!onLiteral && query.length > 0 && (args || matches.length > 0)

  // Keep the highlighted row visible while ↑/↓ walks the list.
  useEffect(() => {
    const el = listRef.current?.querySelector('[data-sel="1"]')
    el?.scrollIntoView({ block: 'nearest' })
  }, [selected, rows])

  return (
    <div className="absolute bottom-full left-0 right-0 z-40 mb-1 gn-popover">
      <div className="flex items-center justify-between gap-2 border-b border-gn-prompt-border px-3 py-1.5">
        <span className="shrink-0 truncate text-[11px] font-bold text-gn-fg2">
          {args ? `参数 · /${argCommand?.name ?? ''}` : '命令'}
        </span>
        {/* 位置/总数放表头右侧（与标题同一行，扫一眼就知道列表有多长、
            当前在哪）；没有行可数时才回落到触发说明。 */}
        {rows > 0 ? (
          <span className="shrink-0 font-mono text-[10px] text-gn-gray-dim">
            {Math.min(selected + 1, rows)}/{rows}
          </span>
        ) : (
          <span className="min-w-0 truncate text-[10px] text-gn-muted">/ 前缀触发</span>
        )}
      </div>
      <div ref={listRef} className="gn-no-scrollbar max-h-56 overflow-y-auto touch-pan-y overscroll-contain">
        {args
          ? argMatches.map(({ arg }, i) => {
              const sel = i === selected
              return (
                <button
                  key={`${arg.insertText}-${i}`}
                  type="button"
                  data-sel={sel ? '1' : '0'}
                  onMouseDown={(e) => {
                    // 鼠标点行不要把焦点从 textarea 抢走（Esc/继续打字仍可用）。
                    e.preventDefault()
                  }}
                  onMouseEnter={() => onHover(i)}
                  onClick={() => onPick(i)}
                  className={menuRowClass(sel)}
                >
                  <span
                    className={`shrink-0 font-mono text-[12px] leading-[18px] ${
 sel ? 'font-semibold text-gn-cyan' : 'text-gn-cyan/80'
                    }`}
                  >
                    {arg.display}
                  </span>
                  <span
                    className={`ml-2 min-w-0 flex-1 truncate text-[11px] leading-[18px] ${
 sel ? 'text-gn-fg2' : 'text-gn-muted'
                    }`}
                  >
                    {arg.description}
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
            })
          : matches.map((m, i) => {
              const sel = i === selected
              return (
                <Fragment key={m.cmd.name}>
                  {i === firstSkillIdx && (
                    <div className="border-t border-gn-prompt-border/60 px-3 pb-0.5 pt-1.5 text-[10px] uppercase tracking-wider text-gn-gutter first:border-t-0">
                      技能
                    </div>
                  )}
                  <button
                    type="button"
                    data-sel={sel ? '1' : '0'}
                    onMouseDown={(e) => {
                      // 鼠标点行不要把焦点从 textarea 抢走（Esc/继续打字仍可用）。
                      e.preventDefault()
                    }}
                    onMouseEnter={() => onHover(i)}
                    onClick={() => onPick(i)}
                    className={menuRowClass(sel)}
                  >
                    <span
                      className={`shrink-0 font-mono text-[12px] leading-[18px] ${
 sel ? 'font-semibold text-gn-cyan' : 'text-gn-cyan/80'
                      }`}
                    >
                      /{m.cmd.name}
                    </span>
                    {m.cmd.source === 'agent' && (
                      <span className="ml-1.5 shrink-0 font-mono text-[10px] leading-[18px] text-gn-accent-system">
                        [agent]
                      </span>
                    )}
                    {m.cmd.source === 'skill' && (
                      <span className="ml-1.5 shrink-0 font-mono text-[10px] leading-[18px] text-gn-accent-system">
                        [skill]
                      </span>
                    )}
                    {(m.cmd.aliases ?? []).map((a) => (
                      <span
                        key={a}
                        className="ml-1.5 shrink-0 font-mono text-[10px] leading-[18px] text-gn-gray-dim"
                      >
                        /{a}
                      </span>
                    ))}
                    {m.cmd.argHint && (
                      <span className="ml-1.5 shrink-0 font-mono text-[10px] leading-[18px] text-gn-gray-dim">
                        {m.cmd.argHint}
                      </span>
                    )}
                    <span
                      className={`ml-2 min-w-0 flex-1 truncate text-[11px] leading-[18px] ${
 sel ? 'text-gn-fg2' : 'text-gn-muted'
                      }`}
                    >
                      {m.cmd.description}
                    </span>
                    {m.cmd.suggestArgs && (
                      // 二级列表预告：这行的 Enter/Tab 是展开，不是直接执行。
                      <span
                        aria-hidden
                        className="ml-1.5 shrink-0 font-mono text-[10px] leading-[18px] text-gn-gray-dim"
                        title="带参数候选"
                      >
                        ▸
                      </span>
                    )}
                    {sel && (
                      <span
                        aria-hidden
                        className="ml-2 shrink-0 font-mono text-[10px] leading-[18px] text-gn-gray"
                      >
                        ↵
                      </span>
                    )}
                  </button>
                </Fragment>
              )
            })}
        {unknown && (
          <div className="px-3 py-2 text-[11px] text-gn-muted">
            没有匹配的命令
          </div>
        )}
      </div>
      {(unknown || canLiteral) && (
        <div className="flex items-center justify-between gap-2 border-t border-gn-prompt-border px-3 py-[3px] text-[10px]">
          {unknown ? (
            <span
              className="min-w-0 truncate text-gn-fg2"
              title={`没有匹配的命令 — Enter 把 /${query} 原样发给 agent（不再拦截）`}
            >
              没有匹配，按原文发送 /{query}
            </span>
          ) : null}
          {canLiteral && (
            // 首词撞上真命令、但你要发原文时的鼠标入口（键盘等价：行首空格 / \/）。
            // 放在页脚最右：靠输入框，且不与左侧的键盘提示抢位。
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={onLiteral}
              title={'在这行行首补一个 \\，作为普通消息发送（等价：行首加空格）'}
              className={`ml-auto ${menuActionClass()}`}
            >
              作为原文发送
            </button>
          )}
        </div>
      )}
    </div>
  )
}
