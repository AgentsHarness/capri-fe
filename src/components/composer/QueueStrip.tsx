import { GripVertical } from 'lucide-react'
import { usePromptQueue } from '../../store/promptQueue'
import { COMPOSER_BODY_PAD_LEFT_PX, ICON_COL_CLASS } from '../../theme/layout'
import type { QueuedPrompt } from '../../store/promptQueue'
import type { useQueueNav } from './useQueueNav'

type QueueStripProps = {
  /** useQueueNav() 的返回（选择/焦点/拖拽状态与抓手事件）。 */
  nav: ReturnType<typeof useQueueNav>
  /** 行内「立即发送」/ 双 Enter 队首发送（见 Composer.sendQueuedItem）。 */
  sendQueuedItem: (id?: string) => void
  /** busy + follow_up_behavior=steer → 队首标注「引导」。 */
  headSteer: boolean
}

/**
 * Inline queue strip：忙时 Enter 只入队，消息正文在 composer 上方。
 * 每行常驻 立即发送 / 编辑 / 删除；左侧抓手拖拽排序。字号与 status 行一致。
 * 展开开关（queuePanelOpen）与选择/焦点/拖拽状态归 useQueueNav。
 */
export function QueueStrip({ nav, sendQueuedItem, headSteer }: QueueStripProps) {
  const {
    queue,
    queuePanelOpen,
    queueEditIndex,
    queueEditDraft,
    queueSel,
    setQueueSel,
    queueFocus,
    setQueueFocus,
    queueDrag,
    queuePanelRef,
    onQueueGripPointerDown,
    onQueueGripPointerMove,
    onQueueGripPointerUp,
  } = nav
  if (queue.length === 0 || !queuePanelOpen) return null
  return (
    <div
      ref={queuePanelRef}
      className="select-none pb-2 pr-0.5 font-ui text-[13.5px] leading-[1.4]"
      style={{ paddingLeft: COMPOSER_BODY_PAD_LEFT_PX }}
    >
      <div className="gn-no-scrollbar flex max-h-28 flex-col gap-0.5 overflow-y-auto">
        {queue.map((q: QueuedPrompt, i: number) => {
          const editing = queueEditIndex === i
          const selected = queueFocus && queueSel === i
          const actionClass =
            'shrink-0 rounded px-1.5 py-[2px] text-gn-gray hover:bg-gn-bg-highlight hover:text-gn-fg'
          return (
            <div
              key={q.id}
              data-queue-idx={i}
              onMouseEnter={() => setQueueSel(i)}
              onMouseDown={() => {
                setQueueSel(i)
                setQueueFocus(true)
              }}
              className={`flex min-h-5 items-center gap-1.5 rounded py-0.5 ${
                selected && !editing ? 'bg-gn-bg-highlight/70' : ''
              } ${queueDrag?.from === i ? 'opacity-50' : ''} ${
                queueDrag && queueDrag.over === i && queueDrag.from !== i
                  ? 'border-t border-gn-cyan'
                  : ''
              }`}
            >
              <button
                type="button"
                disabled={editing}
                onPointerDown={(e) => onQueueGripPointerDown(i, e)}
                onPointerMove={onQueueGripPointerMove}
                onPointerUp={onQueueGripPointerUp}
                onPointerCancel={onQueueGripPointerUp}
                className={`${ICON_COL_CLASS} cursor-grab text-gn-gray touch-none hover:text-gn-fg active:cursor-grabbing disabled:cursor-default disabled:opacity-40`}
                aria-label="拖拽排序"
                title="拖拽排序"
              >
                <GripVertical size={13} strokeWidth={2.25} aria-hidden />
              </button>
              {editing ? (
                <textarea
                  autoFocus
                  rows={1}
                  value={queueEditDraft}
                  onChange={(e) =>
                    usePromptQueue.getState().setEditDraft(e.target.value)
                  }
                  onKeyDown={(e) => {
                    if (e.nativeEvent.isComposing) return
                    if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey) {
                      e.preventDefault()
                      e.stopPropagation()
                      usePromptQueue.getState().saveEdit()
                    } else if (e.key === 'Escape') {
                      e.preventDefault()
                      e.stopPropagation()
                      usePromptQueue.getState().cancelEdit()
                    }
                  }}
                  className="gn-no-scrollbar min-h-[1.4em] flex-1 resize-none bg-transparent font-ui text-[13.5px] leading-[1.4] text-gn-fg outline-none"
                  spellCheck={false}
                />
              ) : (
                <span
                  className="min-w-0 flex-1 truncate text-gn-gray"
                  title={q.degraded ? `发送失败：${q.errorText ?? ''}` : q.text}
                >
                  {q.degraded ? (
                    <span className="mr-1.5 text-gn-red">失败</span>
                  ) : null}
                  {q.text}
                </span>
              )}
              {editing ? (
                <button
                  type="button"
                  onClick={() => usePromptQueue.getState().saveEdit()}
                  className={actionClass}
                >
                  保存
                </button>
              ) : (
                <>
                  {i === 0 && !q.degraded ? (
                    <span
                      className={`shrink-0 rounded border px-1 py-px text-[10px] leading-none ${
                        headSteer
                          ? 'border-gn-cyan/50 text-gn-cyan'
                          : 'border-gn-prompt-border/70 text-gn-gutter'
                      }`}
                      title={
                        headSteer
                          ? 'steer：队首将在运行中回合的下一个工具/模型安全间隙注入（不取消回合）'
                          : 'queue：队首等当前回合结束后作为下一回合运行'
                      }
                    >
                      {headSteer ? '引导' : '队列'}
                    </span>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => sendQueuedItem(q.id)}
                    className="shrink-0 rounded px-1.5 py-[2px] text-gn-cyan hover:bg-gn-bg-highlight"
                    title="立即发送这条"
                  >
                    立即发送
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setQueueSel(i)
                      setQueueFocus(true)
                      usePromptQueue.getState().startEdit(i)
                    }}
                    className={actionClass}
                  >
                    编辑
                  </button>
                  <button
                    type="button"
                    onClick={() => usePromptQueue.getState().removeAt(q.id)}
                    className="shrink-0 rounded px-1.5 py-[2px] text-gn-gray hover:bg-gn-bg-highlight hover:text-gn-red"
                    aria-label="删除这条排队消息"
                    title="删除"
                  >
                    删除
                  </button>
                </>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
