import { useState } from 'react'
import { ImageLightbox, type InlineImage } from '../ui/ImageLightbox'

export type { InlineImage }

/**
 * Inline images for a conversation row. `size` selects the layout:
 * - assistant rows get wide images (max 65%), click opens the block viewer
 *   for the owning entry (full-size view with byte/mime meta lives there);
 * - user rows render fixed-size thumbnails (96×96) in a bottom-aligned
 *   gallery (`items-end`) that cover-fill their frame (no letterbox bands;
 *   the full image lives in the lightbox), click magnifies in a lightbox
 *   preview — the lightbox navigates multi-image sets with ‹ › / ← →, Esc
 *   or backdrop click closes.
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
            // user 缩略图固定 96×96 cover：同组每张同宽同高（宽度若随原图
            // 比例走，宽图与竖图并排时大小不一），裁切掉的边角看 lightbox。
            className={
              size === 'assistant'
                ? 'max-h-[60vh] max-w-[65%] cursor-zoom-in rounded border border-gn-prompt-border object-contain'
                : 'h-24 w-24 cursor-zoom-in rounded border border-gn-prompt-border object-cover'
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
