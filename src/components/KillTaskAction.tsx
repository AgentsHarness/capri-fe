import { useEffect, useRef, useState } from 'react'
import { ChipDropdown } from './ChipDropdown'
import { InlineAction } from './InlineAction'
import { menuRowClass } from './composer/menuRow'

/**
 * `[kill]` 行内动作 —— 后台任务行的唯一终止入口。
 *
 * 点击不直接杀，先问一句「要不要通知 agent」。这一问就是 wire 上唯一的开关
 * （`x.ai/task/kill` 的 `source`，agent 侧 `TaskKillSource`）：`clientUi` 会让
 * agent 在任务收尾时补一条 "This task was killed by the user — do not restart
 * it." 唤醒；`teardown` 则让 agent 认为结果已交付，不再为这条任务叫醒模型。
 * 两种选法终止本体的效果完全相同，差别只在事后告不告诉它。
 *
 * 静默与否只覆盖 agent 的主动唤醒这一层：模型若在杀之前正阻塞等这条任务，
 * 终止结果会直接落进它的 tool result，压不掉。
 *
 * 终止动作本身由调用方注入（`onKill`），与 chrome.cancelSubagent 同一 seams
 * —— 行组件不直连 store。
 */
const CHOICES = [
  {
    notifyAgent: true,
    label: '终止并通知 agent',
    hint: 'agent 会收到一条「已被用户终止」的提醒',
  },
  {
    notifyAgent: false,
    label: '静默终止',
    hint: '不发终止提醒，agent 不会被叫醒（它自己查输出仍看得到）',
  },
] as const

export function KillTaskAction({
  onKill,
  className = '',
}: {
  onKill: (notifyAgent: boolean) => void
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const anchorRef = useRef<HTMLSpanElement>(null)

  // 面板是行内的 fixed 浮层，Esc 关掉它不该同时把所在回合的快捷键吃掉，
  // 所以只在打开期间挂捕获监听。
  useEffect(() => {
    if (!open) return
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') {
        ev.stopPropagation()
        setOpen(false)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open])

  const run = (notifyAgent: boolean) => {
    setOpen(false)
    onKill(notifyAgent)
  }

  return (
    <>
      {/* InlineAction 不转发 ref，浮层的落点靠这层 span 量出来。
          stopPropagation 在 InlineAction 内部已有，展开面板不会顺带打开查看器。 */}
      <span ref={anchorRef} className={`inline-flex shrink-0 items-center ${className}`}>
        <InlineAction label="kill" title="x.ai/task/kill" onRun={() => setOpen((v) => !v)} />
      </span>
      <ChipDropdown
        open={open}
        onClose={() => setOpen(false)}
        anchorRef={anchorRef}
        label="终止后台任务"
        widthClass="w-64"
      >
        {CHOICES.map((c) => (
          <button
            key={c.label}
            type="button"
            onClick={(ev) => {
              ev.stopPropagation()
              run(c.notifyAgent)
            }}
            className={menuRowClass(false)}
          >
            <span className="min-w-0 flex-1">
              <span className="block text-[12px] leading-[16px] text-gn-fg">{c.label}</span>
              <span className="block text-[10.5px] leading-[14px] text-gn-muted">{c.hint}</span>
            </span>
          </button>
        ))}
      </ChipDropdown>
    </>
  )
}
