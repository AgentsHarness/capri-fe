import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChevronLeft, ChevronRight, X } from 'lucide-react'

type InlineImage = { data: string; mimeType?: string }

export type { InlineImage }

/**
 * Inline images for a conversation row. `size` selects the layout:
 * - assistant rows get wide images (max 65%), click opens the block viewer
 *   for the owning entry (full-size view with byte/mime meta lives there);
 * - user rows render uniform-height thumbnails (h-24) in a bottom-aligned
 *   gallery (`items-end`), click magnifies in a lightbox preview — the
 *   lightbox navigates multi-image sets with ‹ › / ← →, Esc or backdrop
 *   click closes.
 * Hover/selected outline is NOT drawn on the thumbnails themselves: the
 * owning entry's SelectionBox (EntryShell) draws the constant-width frame
 * spanning the scrollback content column.
 * `data-no-fold` keeps thumbnail clicks out of the block's fold-toggle
 * (see EntryShell). Clicks stop propagation either way.
 */
export function InlineImages({
  images,
  size,
  onOpen,
}: {
  images: InlineImage[]
  size: 'assistant' | 'user'
  onOpen: () => void
}) {
  const [preview, setPreview] = useState<number | null>(null)
  if (!images.length) return null
  return (
    <>
      <div
        className={`flex flex-wrap ${
          size === 'assistant' ? 'items-start gap-2' : 'items-end gap-1.5'
        }`}
      >
        {images.map((img, i) => (
          <img
            key={i}
            src={img.data}
            alt={img.mimeType ? `image (${img.mimeType})` : 'image'}
            loading="lazy"
            decoding="async"
            data-no-fold
            onClick={(ev) => {
              ev.stopPropagation()
              if (size === 'user') setPreview(i)
              else onOpen()
            }}
            title="点击放大查看"
            // 两种 size 都封顶高度：图片解码是异步的，未封顶的原始比例
            // 会在 prepend 的旧轮次里把行撑高，把刚恢复好的视口再挪一次。
            className={
              size === 'assistant'
                ? 'max-h-[60vh] max-w-[65%] cursor-zoom-in rounded border border-gn-prompt-border object-contain'
                : 'h-24 max-w-[45%] cursor-zoom-in rounded border border-gn-prompt-border object-contain'
            }
          />
        ))}
      </div>
      {size === 'user' && preview != null ? (
        <ImageLightbox
          images={images}
          index={preview}
          onClose={() => setPreview(null)}
        />
      ) : null}
    </>
  )
}

/**
 * Full-screen image preview (lightbox): black backdrop, centered
 * contain-fit image, counter for multi-image galleries, ‹ › buttons and
 * ←/→ keys navigate, Esc or backdrop click closes. Portaled to body so
 * clicks/keys never reach the owning scrollback entry or its keybindings.
 */
export function ImageLightbox({
  images,
  index,
  onClose,
}: {
  images: InlineImage[]
  index: number
  onClose: () => void
}) {
  const [i, setI] = useState(() => Math.min(index, images.length - 1))
  const atFirst = i <= 0
  const atLast = i >= images.length - 1

  // Capture phase: own Esc/←/→ so the scrollback global handler (Esc →
  // cancel/focus-prompt, ←/→ → fold) never sees them while the preview is
  // open. Other keys pass through (Tab still reaches the close/nav buttons).
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') {
        ev.stopPropagation()
        ev.preventDefault()
        onClose()
      } else if (ev.key === 'ArrowLeft') {
        ev.stopPropagation()
        ev.preventDefault()
        setI((v) => Math.max(0, v - 1))
      } else if (ev.key === 'ArrowRight') {
        ev.stopPropagation()
        ev.preventDefault()
        setI((v) => Math.min(images.length - 1, v + 1))
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [images.length, onClose])

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`图片预览 ${i + 1}/${images.length}`}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 select-none"
      onClick={onClose}
    >
      <img
        key={i}
        src={images[i].data}
        alt={images[i].mimeType ? `image (${images[i].mimeType})` : 'image'}
        className="max-h-[85vh] max-w-[92vw] rounded object-contain"
        onClick={(ev) => ev.stopPropagation()}
      />
      <button
        type="button"
        aria-label="关闭预览"
        className="absolute right-3 top-3 flex h-9 w-9 items-center justify-center rounded text-gn-fg2 hover:bg-gn-bg-highlight"
        onClick={(ev) => {
          ev.stopPropagation()
          onClose()
        }}
      >
        <X size={20} aria-hidden />
      </button>
      {images.length > 1 && (
        <>
          <button
            type="button"
            aria-label="上一张"
            aria-disabled={atFirst}
            className={`absolute left-2 top-1/2 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded text-gn-fg2 hover:bg-gn-bg-highlight ${
              atFirst ? 'cursor-default opacity-30 hover:bg-transparent' : ''
            }`}
            onClick={(ev) => {
              ev.stopPropagation()
              if (!atFirst) setI((v) => Math.max(0, v - 1))
            }}
          >
            <ChevronLeft size={28} aria-hidden />
          </button>
          <button
            type="button"
            aria-label="下一张"
            aria-disabled={atLast}
            className={`absolute right-2 top-1/2 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded text-gn-fg2 hover:bg-gn-bg-highlight ${
              atLast ? 'cursor-default opacity-30 hover:bg-transparent' : ''
            }`}
            onClick={(ev) => {
              ev.stopPropagation()
              if (!atLast) setI((v) => Math.min(images.length - 1, v + 1))
            }}
          >
            <ChevronRight size={28} aria-hidden />
          </button>
          <div className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded bg-gn-bg-dark/80 px-2 py-0.5 font-mono text-[12px] tabular-nums text-gn-fg2">
            {i + 1} / {images.length}
          </div>
        </>
      )}
    </div>,
    document.body,
  )
}
