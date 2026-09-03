import { useEffect, useRef, useState } from 'react'
import { ImagePlus, X } from 'lucide-react'
import {
  canEditQueuedImages,
  imageBlocksOf,
  imageMarkerLabels,
  queuedImageEditNote,
  queuedImages,
  usePromptQueue,
} from '../../store/promptQueue'
import type { ContentBlock } from '../../api/types'
import { IMAGE_THUMB_CLASS } from '../../theme/layout'
import { fileToDataUrl } from './pasteChips'
import { ImageLightbox } from '../scrollback/InlineImages'

/**
 * 队列行编辑弹窗（TUI PromptMode::EditingQueued 的 web 对应）。
 *
 * 队列条里的行只显示截断的一行正文，长提示词在行内改等于盲改；点「编辑」
 * （或选中行按 e / Enter）后弹出本窗，整段正文在 textarea 里改。编辑锁
 * （queueHoldEdit）、保存与取消全部在 promptQueue store——这里只是它的
 * 视图：Enter 保存、Shift+Enter 换行、Esc 取消（含 backdrop 点击）。
 *
 * 附图在这里编辑（缩略图与 composer 同款固定尺寸，点击放大）：删除 / 追加
 * 都写进 store 的 editImages 草稿，保存时由 store 决定后果——本端真身
 * （degraded）就地改，agent 那份则删旧行重新入队。正文与附图都为空的行
 * 没有可保存的东西（store 语义是保留原文），禁用保存。
 */
export function QueueEditModal() {
  const editIndex = usePromptQueue((s) => s.editIndex)
  const draft = usePromptQueue((s) => s.editDraft)
  const draftImages = usePromptQueue((s) => s.editImages)
  const row = usePromptQueue((s) =>
    s.editIndex == null ? undefined : s.queue[s.editIndex],
  )
  const total = usePromptQueue((s) => s.queue.length)
  const taRef = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const open = editIndex != null && row != null
  // 缩略图点开的放大预览（图片下标；null = 关闭）。
  const [preview, setPreview] = useState<number | null>(null)
  // 追加图片读文件的耗时（禁用按钮避免重复点）。
  const [reading, setReading] = useState(false)

  // Esc 关窗：捕获期监听，弹窗内任何焦点位置都生效，并吞掉按键——
  // 忙碌时它不该再走 scrollback 的 Esc→取消回合。缩略图预览打开时让位：
  // 那一下 Esc 只关预览（ImageLightbox 自己的捕获监听处理），编辑窗留下。
  useEffect(() => {
    if (!open || preview != null) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      usePromptQueue.getState().cancelEdit()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, preview])

  // 打开即聚焦；行高跟着内容长（上限 320px 后内部滚动）。窗口尺寸变化
  // （转屏 / 桌面缩放）要重算——换宽度后同样的正文占的行数不一样。
  useEffect(() => {
    if (!open) return
    const grow = () => {
      const ta = taRef.current
      if (!ta) return
      ta.style.height = 'auto'
      ta.style.height = `${Math.min(ta.scrollHeight + 2, 320)}px`
    }
    grow()
    window.addEventListener('resize', grow)
    return () => window.removeEventListener('resize', grow)
  }, [open, draft])

  // 打开时把光标放到正文末尾（长提示词从中间插字比从头挪光标省事）。
  useEffect(() => {
    if (!open) return
    setPreview(null)
    const ta = taRef.current
    if (!ta) return
    const n = ta.value.length
    ta.setSelectionRange(n, n)
  }, [open, editIndex])

  if (!open || !row) return null

  const q = usePromptQueue.getState()
  const images = queuedImages(draftImages)
  const labels = imageMarkerLabels(draftImages)
  const imagesEditable = canEditQueuedImages(row)
  // 正文与附图全空 = 没东西可发（store 会保留原文），禁用保存。
  const blank = draft.trim() === '' && images.length === 0

  /** 追加图片文件 → image blocks 草稿（与 composer 的贴图同一条读取路径）。 */
  const addFiles = async (files: File[]) => {
    const imgs = files.filter((f) => f.type.startsWith('image/'))
    if (imgs.length === 0) return
    setReading(true)
    // 读文件是异步的：草稿从 store 现读，连贴两张不会互相覆盖。
    const next: ContentBlock[] = [...usePromptQueue.getState().editImages]
    for (const f of imgs) {
      try {
        const { data, mimeType } = await fileToDataUrl(f)
        next.push({ type: 'image', data, mimeType })
      } catch {
        // 读不出来的文件跳过（与 composer 一致）。
      }
    }
    setPreview(null)
    q.setEditImages(next)
    setReading(false)
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto gn-modal-dim p-4"
      role="dialog"
      aria-modal="true"
      aria-label="编辑排队消息"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) usePromptQueue.getState().cancelEdit()
      }}
      onPaste={(e) => {
        // 往弹窗里贴图 = 追加附图（纯文本粘贴照常进 textarea）。
        if (!imagesEditable) return
        const files = Array.from(e.clipboardData?.files ?? [])
        if (files.length === 0) return
        e.preventDefault()
        void addFiles(files)
      }}
    >
      <div className="mt-16 w-full max-w-[640px] gn-modal-panel">
        <header className="gn-modal-header">
          <span className="text-[13px] font-bold text-gn-fg">编辑排队消息</span>
          <span className="font-mono text-[10.5px] text-gn-gutter">
            {editIndex != null ? editIndex + 1 : 0}/{total}
          </span>
          {row.degraded ? (
            <span className="text-[10.5px] text-gn-red" title={row.errorText}>
              发送失败
            </span>
          ) : null}
          <button
            type="button"
            onClick={() => usePromptQueue.getState().cancelEdit()}
            className="ml-auto rounded px-2 py-0.5 text-[12px] text-gn-muted hover:bg-gn-bg-highlight hover:text-gn-fg"
          >
            esc
          </button>
        </header>

        <div className="px-4 py-3">
          <textarea
            ref={taRef}
            autoFocus
            rows={3}
            value={draft}
            onChange={(e) => usePromptQueue.getState().setEditDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing) return
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                e.stopPropagation()
                if (!blank) usePromptQueue.getState().saveEdit()
              }
            }}
            className="gn-no-scrollbar w-full resize-none rounded border border-gn-prompt-border bg-gn-bg-dark px-3 py-2 font-ui text-[13.5px] leading-[1.5] text-gn-fg outline-none max-h-[320px] overflow-y-auto focus:border-gn-prompt-border-active"
            spellCheck={false}
          />

          {/* ── 附图：固定尺寸缩略图（与 composer 一致），可增删、点击放大 ── */}
          <div className="mt-2.5 flex flex-wrap items-start gap-2">
            {images.map((img, i) => (
              <div key={`${img.data.slice(-16)}-${i}`} className="group relative">
                <button
                  type="button"
                  onClick={() => setPreview(i)}
                  title="点击放大查看"
                  className="flex flex-col items-start gap-1 rounded p-1 transition-colors active:bg-gn-bg-highlight"
                >
                  <img
                    src={img.data}
                    // 装饰性：按钮的可及名由下面的 `[image N]` 说明文字给出。
                    alt=""
                    loading="lazy"
                    decoding="async"
                    className={IMAGE_THUMB_CLASS}
                  />
                  <span className="w-20 truncate text-center font-mono text-[10px] leading-none text-gn-muted">
                    {labels[i]}
                  </span>
                </button>
                {imagesEditable ? (
                  <button
                    type="button"
                    aria-label={`移除 ${labels[i] ?? '附图'}`}
                    title="移除这张附图"
                    onClick={() => {
                      setPreview(null)
                      q.setEditImages(
                        imageBlocksOf(draftImages).filter((_, k) => k !== i),
                      )
                    }}
                    className="absolute -right-1.5 -top-1.5 flex h-4 w-4 items-center justify-center rounded-full bg-gn-bg-dark text-gn-gray shadow transition-colors hover:text-gn-red"
                  >
                    <X size={10} strokeWidth={2.5} aria-hidden />
                  </button>
                ) : null}
              </div>
            ))}
            {imagesEditable ? (
              <button
                type="button"
                disabled={reading}
                onClick={() => fileRef.current?.click()}
                title="添加附图"
                className="flex flex-col items-start gap-1 rounded border-dashed p-1 text-gn-muted transition-colors hover:text-gn-fg disabled:cursor-not-allowed disabled:opacity-50"
              >
                <span className="flex h-20 w-20 items-center justify-center rounded border border-gn-prompt-border bg-gn-bg-dark">
                  <ImagePlus size={18} aria-hidden />
                </span>
                <span className="w-20 text-center font-mono text-[10px] leading-none">
                  添加
                </span>
              </button>
            ) : null}
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              onChange={(e) => {
                const files = Array.from(e.target.files ?? [])
                e.target.value = ''
                if (files.length > 0) void addFiles(files)
              }}
            />
          </div>

          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10.5px] leading-snug text-gn-gutter">
            <span>Enter 保存 · Shift+Enter 换行 · Esc 取消</span>
            {draft.trim() === '' && images.length > 0 ? (
              <span className="text-gn-muted">正文为空：只发附图</span>
            ) : null}
            {blank ? (
              <span className="text-gn-warning">
                正文与附图都为空：不保存这条改动，改回内容或 Esc 取消
              </span>
            ) : null}
            {images.length > 0 ? <span>{queuedImageEditNote(row)}</span> : null}
          </div>
        </div>

        <footer className="gn-modal-footer flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={() => usePromptQueue.getState().cancelEdit()}
            className="min-h-9 rounded px-4 py-1.5 text-[12.5px] text-gn-fg2 hover:bg-gn-bg-highlight"
          >
            取消
          </button>
          <button
            type="button"
            disabled={blank}
            onClick={() => usePromptQueue.getState().saveEdit()}
            className="min-h-9 rounded px-4 py-1.5 text-[12.5px] text-gn-cyan hover:bg-gn-cyan/10 active:bg-gn-cyan/20 disabled:cursor-not-allowed disabled:opacity-50"
          >
            保存
          </button>
        </footer>
      </div>
      {preview != null && images[preview] ? (
        <ImageLightbox
          images={images}
          index={preview}
          onClose={() => setPreview(null)}
        />
      ) : null}
    </div>
  )
}
