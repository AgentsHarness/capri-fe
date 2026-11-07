import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChevronLeft, ChevronRight, X } from 'lucide-react'
import { trackLightbox } from '../../lib/lightboxState'

export type InlineImage = { data: string; mimeType?: string }

/**
 * Entry image with click-to-enlarge. The thumbnail keeps the caller's
 * classes; clicking opens the shared lightbox on the single image (or calls
 * `onOpen` when the parent owns a multi-image gallery, e.g. the scrollback's
 * consecutive-image group). Clicks stop propagating so they never fold the
 * owning entry, and `data-no-fold` marks the same intent for EntryShell's
 * pointer handler.
 */
export function ZoomableImage({
  src,
  alt,
  mimeType,
  className = '',
  title = '点击放大查看',
  loading = 'lazy',
  onOpen,
}: {
  src: string
  alt?: string
  mimeType?: string
  className?: string
  title?: string
  loading?: 'lazy' | 'eager'
  onOpen?: () => void
}) {
  const [preview, setPreview] = useState(false)
  return (
    <>
      <img
        src={src}
        alt={alt ?? (mimeType ? `image (${mimeType})` : 'image')}
        loading={loading}
        decoding="async"
        data-no-fold
        title={title}
        onClick={(ev) => {
          ev.stopPropagation()
          if (onOpen) onOpen()
          else setPreview(true)
        }}
        className={`cursor-zoom-in ${className}`}
      />
      {preview ? (
        <ImageLightbox
          images={[{ data: src, mimeType }]}
          index={0}
          onClose={() => setPreview(false)}
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

  // Tracks nested previews for outer dialogs' Esc handlers (see lightboxState).
  useEffect(() => trackLightbox(), [])

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
            className={`absolute left-2 top-1/2 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded text-gn-fg2 hover:bg-gn-bg-highlight ${ atFirst ? 'cursor-default opacity-30 hover:bg-transparent' : '' }`}
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
            className={`absolute right-2 top-1/2 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded text-gn-fg2 hover:bg-gn-bg-highlight ${ atLast ? 'cursor-default opacity-30 hover:bg-transparent' : '' }`}
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
