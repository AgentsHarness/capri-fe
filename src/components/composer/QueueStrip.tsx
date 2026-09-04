import { useState } from 'react'
import { GripVertical } from 'lucide-react'
import { usePromptQueue, imageMarkerLabels, queueRowText, queuedImages } from '../../store/promptQueue'
import { COMPOSER_BODY_PAD_LEFT_PX } from '../../theme/layout'
import { ImageLightbox, type InlineImage } from '../scrollback/InlineImages'
import type { QueuedPrompt } from '../../store/promptQueue'
import type { useQueueNav } from './useQueueNav'

type QueueStripProps = {
  /** useQueueNav() 的返回（选择/焦点/拖拽状态与整行拖拽事件）。 */
  nav: ReturnType<typeof useQueueNav>
  /** 行内「立即发送」/ 双 Enter 队首发送（见 Composer.sendQueuedItem）。 */
  sendQueuedItem: (id?: string) => void
  /** busy + follow_up_behavior=steer → 队首标注「引导」。 */
  headSteer: boolean
  /** 点击切换队首模式（steer 引导 ↔ queue 队列）。 */
  onToggleMode?: () => void
  /** 模式切换中（禁用按钮避免重复快速触发）。 */
  togglingMode?: boolean
}

/**
 * Inline queue strip：忙时 Enter 只入队，消息正文在 composer 上方。
 * 每行常驻 立即发送 / 编辑 / 删除；除按钮外整行可拖拽排序（拖动阈值
 * 以下视作点击，不误杀选中）。字号与 status 行一致。
 * 展开开关（queuePanelOpen）与选择/焦点/拖拽状态归 useQueueNav。
 * 「编辑」只置 store 的 editIndex —— 正文在 QueueEditModal 弹窗里改
 * （行内只有一行截断宽度，长提示词没法盲改）。
 * 附图不进正文：每张图渲染成一个 `[image N]` 标记（agent 侧队列正文只由
 * text blocks 拼成，纯图片行的 text 恒为空），点开即全屏预览。
 */
export function QueueStrip({
  nav,
  sendQueuedItem,
  headSteer,
  onToggleMode,
  togglingMode,
}: QueueStripProps) {
  // 行内 `[image N]` 标记点开的全屏预览（null = 关闭）。
  const [preview, setPreview] = useState<{ images: InlineImage[]; index: number } | null>(
    null,
  )
  const {
    queue,
    queuePanelOpen,
    queueEditIndex,
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
      {/* 行距固定 gap-1：条目变多时滚动，不压缩行间距；启用 touch-pan-y 优化触屏手势 */}
      <div className="gn-no-scrollbar flex max-h-40 flex-col gap-1 overflow-y-auto touch-pan-y overscroll-contain">
        {queue.map((q: QueuedPrompt, i: number) => {
          const editing = queueEditIndex === i
          const selected = queueFocus && queueSel === i
          const actionClass =
            'shrink-0 rounded px-1.5 py-1 sm:py-[2px] min-h-6 sm:min-h-0 text-gn-gray hover:bg-gn-bg-highlight hover:text-gn-fg'
          const labels = imageMarkerLabels(q.blocks)
          const images = queuedImages(q.blocks)
          const rowText = queueRowText(q)

          // 拖拽状态与结果落点计算
          const dragging = queueDrag != null && queueDrag.from === i
          const targetTo = queueDrag != null ? (queueDrag.to ?? queueDrag.over) : 0
          const targetSlot =
            queueDrag != null
              ? (queueDrag.slot ?? (queueDrag.over > queueDrag.from ? queueDrag.over + 1 : queueDrag.over))
              : 0
          const isNoOp = queueDrag != null && queueDrag.from === targetTo

          // 落点指示线：在目标槽位处画平直青色线（slot = i 顶部，或队尾底部）
          const showDropAbove = !isNoOp && queueDrag != null && targetSlot === i
          const showDropBelow =
            !isNoOp && queueDrag != null && targetSlot === queue.length && i === queue.length - 1
          const showIndicator = showDropAbove || showDropBelow

          return (
            <div
              key={q.id}
              data-queue-idx={i}
              onMouseEnter={() => {
                if (!queueDrag) setQueueSel(i)
              }}
              onMouseDown={() => {
                setQueueSel(i)
                setQueueFocus(true)
              }}
              onPointerDown={(e) => {
                // 按钮上按住不触发整行拖拽（按钮照常点）。
                if ((e.target as HTMLElement).closest('button')) return
                onQueueGripPointerDown(i, e)
              }}
              onPointerMove={onQueueGripPointerMove}
              onPointerUp={onQueueGripPointerUp}
              onPointerCancel={(e) => {
                // 触控拖拽中由全局 touch 事件闭环处理，不在此直接取消拖拽
                if (e.pointerType !== 'touch' || !queueDrag) {
                  onQueueGripPointerUp()
                }
              }}
              style={{ WebkitTouchCallout: 'none' }}
              className={`relative flex min-h-5 shrink-0 cursor-grab items-center gap-1.5 rounded py-0.5 ${
                selected || editing ? 'bg-gn-bg-highlight/70' : ''
              } ${dragging ? 'cursor-grabbing opacity-40' : ''}`}
            >
              {showIndicator ? (
                <span
                  data-drop-indicator
                  className={`pointer-events-none absolute inset-x-0 z-10 h-0.5 bg-gn-cyan ${
                    showDropBelow ? '-bottom-[2px]' : '-top-[2px]'
                  }`}
                  aria-hidden
                />
              ) : null}
              <span
                data-queue-grip
                className="inline-flex h-6 w-5 sm:h-[1.2em] sm:w-[1.25em] shrink-0 items-center justify-center touch-none text-gn-gray hover:text-gn-fg active:text-gn-cyan cursor-grab active:cursor-grabbing select-none"
                title="拖拽排序"
                aria-hidden
              >
                <GripVertical size={17} className="h-[17px] w-[17px] sm:h-[13px] sm:w-[13px]" strokeWidth={2.25} />
              </span>
              <div
                className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden text-gn-gray"
                title={q.degraded ? `发送失败：${q.errorText ?? ''}` : rowText}
                onDoubleClick={() => {
                  setQueueSel(i)
                  setQueueFocus(true)
                  usePromptQueue.getState().startEdit(i)
                }}
              >
                {q.degraded ? (
                  <span className="mr-0.5 shrink-0 text-gn-red">失败</span>
                ) : null}
                {/* 正文先截断，图片标记恒在行内可见（窄屏上把标记挤没就
                    等于纯图片行又变成一条空行）。 */}
                <span className="min-w-0 shrink truncate">{q.text}</span>
                {labels.length > 0 ? (
                  <span className="flex shrink-0 items-center gap-1">
                    {labels.map((label, k) => (
                      <button
                        key={label}
                        type="button"
                        title={
                          images[k] ? '点击查看图片' : `第 ${k + 1} 张附图（本端无图片数据）`
                        }
                        onMouseDown={(e) => e.stopPropagation()}
                        onClick={(e) => {
                          e.stopPropagation()
                          setQueueSel(i)
                          if (images[k]) setPreview({ images, index: k })
                        }}
                        className={`shrink-0 rounded px-1 py-px text-[10px] leading-none select-none ${ images[k] ? 'text-gn-cyan hover:bg-gn-cyan/10 active:bg-gn-cyan/20' : 'text-gn-gutter' }`}
                      >
                        {label}
                      </button>
                    ))}
                  </span>
                ) : null}
              </div>
              {i === 0 && !q.degraded ? (
                <button
                  type="button"
                  disabled={togglingMode}
                  onClick={(e) => {
                    e.stopPropagation()
                    onToggleMode?.()
                  }}
                  className={`shrink-0 rounded px-1.5 py-1 sm:py-[2px] min-h-6 sm:min-h-0 transition-colors select-none ${
                    headSteer
                      ? 'bg-gn-bg-highlight text-gn-cyan'
                      : 'text-gn-fg2 hover:bg-gn-bg-highlight hover:text-gn-fg'
                  } disabled:cursor-not-allowed disabled:opacity-50`}
                  title={
                    headSteer
                      ? '当前为 steer（引导）：队首将在下一个安全间隙注入；点击切换为「队列」'
                      : '当前为 queue（队列）：等当前回合结束后运行；点击切换为「引导」'
                  }
                >
                  {headSteer ? '引导' : '队列'}
                </button>
              ) : null}
              <button
                type="button"
                onClick={() => sendQueuedItem(q.id)}
                className="shrink-0 rounded px-1.5 py-1 sm:py-[2px] min-h-6 sm:min-h-0 text-gn-cyan hover:bg-gn-bg-highlight"
                title="立即发送这条"
              >
                <span className="hidden sm:inline">立即发送</span>
                <span className="sm:hidden">发送</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  setQueueSel(i)
                  setQueueFocus(true)
                  usePromptQueue.getState().startEdit(i)
                }}
                className={actionClass}
                title="弹窗编辑这条排队消息"
              >
                编辑
              </button>
              <button
                type="button"
                onClick={() => usePromptQueue.getState().removeAt(q.id)}
                className="shrink-0 rounded px-1.5 py-1 sm:py-[2px] min-h-6 sm:min-h-0 text-gn-gray hover:bg-gn-bg-highlight hover:text-gn-red active:text-gn-red"
                aria-label="删除这条排队消息"
                title="删除"
              >
                删除
              </button>
            </div>
          )
        })}
      </div>
      {preview ? (
        <ImageLightbox
          images={preview.images}
          index={preview.index}
          onClose={() => setPreview(null)}
        />
      ) : null}
    </div>
  )
}
